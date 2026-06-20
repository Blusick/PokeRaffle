# $BTL — Creator Fee Pack Opening

A simple white site that tracks a pump.fun token's accumulated **creator fees** live. Every **$50** of fees opens a "pack" and runs a holder raffle. Holders' win chance is weighted by their holding %; holders above **4%** are excluded (shown in red). When the prize wallet receives an NFT, it appears in **Latest pull**.

Token: `3bBQrzzq9DRXXFfC9nUno9m1MBm9Y7dVnBBK44bVpump` (Bad Theory Labs, $BTL)
Prize wallet: `3tnzEgqo6U19ocZbbc49vcGv3mGSoWNFAYjQQk5gF2qP`

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

Your Helius API key lives in `.env` (server-side only — it is never sent to the browser). The frontend in `public/` only reads `/api/state`.

## How it works

- **Backend (`server.js`)** polls every 30s: token info (pump.fun), SOL price (Coingecko), creator-fee vault balances via the `creator-vault` / `creator_vault` PDAs (Helius RPC), holders via Helius `getTokenAccounts`, and the prize wallet's incoming NFTs via the Helius Enhanced Transactions API.
- **Shared state** is persisted to `data/state.json`, so the pack count, fee total and winners are the same for every visitor.
- **Creator fees** accumulate monotonically from real on-chain inflow since first launch; a vault *decrease* (a claim) never reduces the counted total.
- **Verifiable draw**: when a pack opens, the server records a Solana `blockhash` and a hash of the eligible-holder snapshot. The winner = weighted pick using `sha256(blockhash:packIndex)`. Anyone can reproduce it from the values shown under each pack's "verify" link, and the operator cannot pick the blockhash in advance.

## Configuration

Edit `CONFIG` at the top of `server.js`: `PACK_THRESHOLD_USD` (50), `BIG_HOLDER_PCT` (4), `POLL_MS`, etc.

## Deploy

Any Node host (Railway, Render, Fly.io, a VPS). Set `HELIUS_API_KEY` as an environment variable and run `npm start`. Keep `.env` out of git (already in `.gitignore`).

## Notes / limits

- Fees are counted from the moment the server first runs (full lifetime backfill isn't fetched). To seed a starting total, set `cumUsd` in `data/state.json` before first start.
- Not affiliated with pump.fun. Not financial advice.
