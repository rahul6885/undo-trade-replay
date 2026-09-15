# UNDO Trade Replay v3 — first real blockchain engine

This build keeps the existing UNDO UI and adds a server-side Robinhood Chain data engine.

## What is real in v3

- Connects to Robinhood Chain Mainnet through Alchemy.
- Reads the selected ERC-20 token metadata.
- Uses Alchemy Transfers API to retrieve historical ERC-20 and ETH transfers for a wallet.
- Groups transfers by transaction hash.
- Detects ETH-quoted BUY/SELL transactions from the wallet's actual on-chain movements.
- Calculates the earliest qualifying First Buy.
- Calculates Realized P&L using average-cost basis in ETH.
- Keeps the API key server-side; it is never sent to the browser.

## Important limitation

Highest Profit, Biggest Dip and Missed Top are intentionally NOT faked yet. Those need a historical token-price/trade reconstruction engine. The UI marks them as the next stage rather than showing made-up numbers.

This first engine is designed around ETH-quoted trades. If a token trades against an ERC-20 quote asset, that quote-pair parser will be added separately.

## Setup

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Put your Alchemy API key in `.env`:

   ALCHEMY_API_KEY=YOUR_KEY

4. Install/run:

   npm install
   npm start

5. Open:

   http://localhost:3000

Do NOT put your Alchemy API key in `public/index.html` or commit `.env` to Git.

## Why the backend exists

The browser should not expose the Alchemy key. The server calls Alchemy and returns only the analysis needed by the UI.

Robinhood Chain Mainnet is chain ID 4663. Alchemy is an official recommended infrastructure provider for Robinhood Chain.
