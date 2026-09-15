
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ALCHEMY_API_KEY;
const RPC_URL = API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${API_KEY}` : null;

if (!API_KEY) {
  console.warn('ALCHEMY_API_KEY is not set. Create a .env file before starting the server.');
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const CHAIN_ID = 4663;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

async function rpc(method, params = []) {
  if (!RPC_URL) throw new Error('Server is missing ALCHEMY_API_KEY.');
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})
  });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error?.message || `RPC ${r.status}`);
  return body.result;
}

async function transfers(params) {
  if (!RPC_URL) throw new Error('Server is missing ALCHEMY_API_KEY.');
  let pageKey;
  const all = [];
  do {
    const p = {...params};
    if (pageKey) p.pageKey = pageKey;
    const r = await fetch(RPC_URL, {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({
        jsonrpc:'2.0',
        id:1,
        method:'alchemy_getAssetTransfers',
        params:[p]
      })
    });
    const body = await r.json();
    if (!r.ok || body.error) throw new Error(body.error?.message || `Transfers API ${r.status}`);
    const result = body.result || {};
    all.push(...(result.transfers || []));
    pageKey = result.pageKey || '';
  } while (pageKey);
  return all;
}

function decodeUint(hex) {
  return BigInt(hex || '0x0');
}

function decodeAbiString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const bytes = Buffer.from(hex.slice(2), 'hex');
    if (bytes.length >= 64) {
      const offset = Number(BigInt('0x' + bytes.slice(0,32).toString('hex')));
      if (offset + 32 <= bytes.length) {
        const len = Number(BigInt('0x' + bytes.slice(offset, offset+32).toString('hex')));
        const start = offset + 32;
        return bytes.slice(start, start + len).toString('utf8').replace(/\0+$/,'');
      }
    }
    // bytes32 fallback
    return bytes.toString('utf8').replace(/\0+$/,'');
  } catch {
    return '';
  }
}

async function tokenMeta(address) {
  const [decHex, symHex, nameHex] = await Promise.all([
    rpc('eth_call',[{to:address,data:'0x313ce567'},'latest']),
    rpc('eth_call',[{to:address,data:'0x95d89b41'},'latest']).catch(()=> '0x'),
    rpc('eth_call',[{to:address,data:'0x06fdde03'},'latest']).catch(()=> '0x')
  ]);
  let decimals = Number(decodeUint(decHex));
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) decimals = 18;
  let symbol = decodeAbiString(symHex) || 'TOKEN';
  let name = decodeAbiString(nameHex) || symbol;
  return {address, decimals, symbol, name};
}

function amountOf(t, decimals) {
  if (t?.rawContract?.value) {
    const raw = BigInt(t.rawContract.value);
    return Number(raw) / Math.pow(10, decimals);
  }
  return Number(t?.value || 0);
}

function ethAmount(t) {
  if (t?.rawContract?.value) return Number(BigInt(t.rawContract.value)) / 1e18;
  return Number(t?.value || 0);
}

function groupByHash(list, direction, kind, decimals) {
  const map = new Map();
  for (const t of list) {
    const hash = t.hash;
    if (!hash) continue;
    if (!map.has(hash)) map.set(hash, {hash, blockNum:t.blockNum, timestamp:t.metadata?.blockTimestamp || null, tokenIn:0, tokenOut:0, ethIn:0, ethOut:0});
    const g = map.get(hash);
    if (kind === 'token') {
      const n = amountOf(t, decimals);
      if (direction === 'in') g.tokenIn += n;
      else g.tokenOut += n;
    } else {
      const n = ethAmount(t);
      if (direction === 'in') g.ethIn += n;
      else g.ethOut += n;
    }
  }
  return map;
}

async function getBlockTimes(blockNums) {
  const unique = [...new Set(blockNums.filter(Boolean))];
  const out = new Map();
  const batchSize = 40;
  for (let i=0;i<unique.length;i+=batchSize) {
    const batch = unique.slice(i,i+batchSize).map((blockNum, idx)=>({
      jsonrpc:'2.0', id:idx+1, method:'eth_getBlockByNumber', params:[blockNum,false]
    }));
    const r = await fetch(RPC_URL, {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(batch)
    });
    const body = await r.json();
    for (const item of (Array.isArray(body) ? body : [])) {
      if (item.result?.number) {
        out.set(item.result.number, Number(BigInt(item.result.timestamp))*1000);
      }
    }
  }
  return out;
}

function classifyTrades(tokenTransfersIn, tokenTransfersOut, ethIn, ethOut, decimals) {
  const txs = new Map();
  const merge = (m) => {
    for (const [hash,g] of m) {
      if (!txs.has(hash)) txs.set(hash,{hash,blockNum:g.blockNum, timestamp:g.timestamp, tokenIn:0,tokenOut:0,ethIn:0,ethOut:0});
      const x=txs.get(hash);
      x.tokenIn += g.tokenIn; x.tokenOut += g.tokenOut;
      x.ethIn += g.ethIn; x.ethOut += g.ethOut;
      if (!x.blockNum) x.blockNum=g.blockNum;
    }
  };
  merge(tokenTransfersIn); merge(tokenTransfersOut); merge(ethIn); merge(ethOut);

  const trades = [];
  for (const x of txs.values()) {
    const tokenDelta = x.tokenIn - x.tokenOut;
    const ethDelta = x.ethIn - x.ethOut;
    // Buy: wallet gets token and spends ETH. Sell: wallet sends token and gets ETH.
    if (tokenDelta > 0.000000000001 && ethDelta < -0.000000000000001) {
      trades.push({...x,type:'BUY',tokenAmount:tokenDelta,ethAmount:-ethDelta});
    } else if (tokenDelta < -0.000000000001 && ethDelta > 0.000000000000001) {
      trades.push({...x,type:'SELL',tokenAmount:-tokenDelta,ethAmount:ethDelta});
    }
  }
  trades.sort((a,b)=> {
    if (a.blockNum && b.blockNum) return Number(BigInt(a.blockNum)-BigInt(b.blockNum));
    return 0;
  });
  return trades;
}

function calculatePnl(trades) {
  let position = 0;
  let totalCost = 0;
  let realized = 0;
  let proceeds = 0;
  let costBasis = 0;
  let sellCount = 0;
  const normalized = [];
  for (const t of trades) {
    if (t.type === 'BUY') {
      position += t.tokenAmount;
      totalCost += t.ethAmount;
    } else {
      const qty = Math.min(t.tokenAmount, position);
      const avg = position > 0 ? totalCost / position : 0;
      const cost = avg * qty;
      realized += t.ethAmount - cost;
      proceeds += t.ethAmount;
      costBasis += cost;
      position -= qty;
      totalCost -= cost;
      sellCount++;
    }
    normalized.push({
      type:t.type,
      hash:t.hash,
      blockNum:t.blockNum,
      timestamp:t.timestamp,
      tokenAmount:t.tokenAmount,
      ethAmount:t.ethAmount
    });
  }
  return {eth:realized, proceeds, costBasis, sellCount, remainingToken:position, remainingCost:totalCost, trades:normalized};
}

async function analyze(wallet, token) {
  const meta = await tokenMeta(token);
  const common = {fromBlock:'0x0', toBlock:'latest', contractAddresses:[token], excludeZeroValue:true, withMetadata:true, category:['erc20'], maxCount:1000};
  const [tokenInList, tokenOutList, ethInList, ethOutList] = await Promise.all([
    transfers({...common, toAddress:wallet}),
    transfers({...common, fromAddress:wallet}),
    transfers({fromBlock:'0x0',toBlock:'latest',toAddress:wallet,excludeZeroValue:true,withMetadata:true,category:['external','internal'],maxCount:1000}),
    transfers({fromBlock:'0x0',toBlock:'latest',fromAddress:wallet,excludeZeroValue:true,withMetadata:true,category:['external','internal'],maxCount:1000})
  ]);

  const tin=groupByHash(tokenInList,'in','token',meta.decimals);
  const tout=groupByHash(tokenOutList,'out','token',meta.decimals);
  const ein=groupByHash(ethInList,'in','eth',18);
  const eout=groupByHash(ethOutList,'out','eth',18);
  const trades=classifyTrades(tin,tout,ein,eout,meta.decimals);
  const times=await getBlockTimes(trades.map(t=>t.blockNum));
  for(const t of trades) t.timestamp = t.timestamp || (times.get(t.blockNum) ? new Date(times.get(t.blockNum)).toISOString() : null);

  const pnl=calculatePnl(trades);
  const firstBuy=trades.find(t=>t.type==='BUY') || null;
  return {
    chainId:CHAIN_ID,
    token:meta,
    wallet,
    tradeCount:trades.length,
    firstBuy:firstBuy ? {
      txHash:firstBuy.hash,
      blockNumber:Number(BigInt(firstBuy.blockNum)),
      timestamp:firstBuy.timestamp,
      tokenAmount:firstBuy.tokenAmount,
      ethSpent:firstBuy.ethAmount
    } : null,
    realizedPnl:{
      eth:pnl.eth,
      proceeds:pnl.proceeds,
      costBasis:pnl.costBasis,
      sellCount:pnl.sellCount
    },
    timeline:trades.slice(-8).map(t=>({type:t.type,hash:t.hash,blockNumber:Number(BigInt(t.blockNum)),timestamp:t.timestamp,tokenAmount:t.tokenAmount,ethAmount:t.ethAmount})),
    trades:pnl.trades
  };
}

const server = http.createServer(async (req,res)=>{
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname === '/api/health') {
      return json(res,200,{ok:Boolean(API_KEY),chainId:CHAIN_ID});
    }
    if (u.pathname === '/api/analyze') {
      const wallet=u.searchParams.get('wallet')?.trim();
      const token=u.searchParams.get('token')?.trim();
      if(!/^0x[a-fA-F0-9]{40}$/.test(wallet||'') || !/^0x[a-fA-F0-9]{40}$/.test(token||'')) {
        return json(res,400,{error:'Invalid wallet or token contract address.'});
      }
      const result=await analyze(wallet,token);
      return json(res,200,result);
    }
    let filePath = u.pathname === '/' ? path.join(PUBLIC_DIR,'index.html') : path.join(PUBLIC_DIR,u.pathname.replace(/^\/+/,''));
    if(!filePath.startsWith(PUBLIC_DIR)) return json(res,403,{error:'Forbidden'});
    if(!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath=path.join(PUBLIC_DIR,'index.html');
    const ext=path.extname(filePath);
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
    res.writeHead(200,{'Content-Type':types[ext]||'text/plain; charset=utf-8'});
    fs.createReadStream(filePath).pipe(res);
  } catch(err) {
    console.error(err);
    json(res,500,{error:err.message || 'Server error'});
  }
});

server.listen(PORT,()=>console.log(`UNDO server running on http://localhost:${PORT}`));
