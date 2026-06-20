/* =====================================================================
   RAFFLE — Creator Fee Pack Opening  (backend)
   - Helius key stays server-side (never sent to the browser)
   - Single shared global state, persisted to data/state.json
   - COMING SOON mode: when CONFIG.TOKEN_MINT is empty there is no token to
     analyze yet -> the API reports comingSoon:true, name "RAFFLE", packs 0.
   - When a token mint is set: every $50 of creator-fee inflow opens a pack +
     runs a VERIFIABLE weighted holder draw.
   - Latest pulls: NFTs received by the prize wallet, each with an estimated value.
   ===================================================================== */
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const web3 = require("@solana/web3.js");

/* ----------------------------- CONFIG ----------------------------- */
const CONFIG = {
  TOKEN_MINT:   "",   // <-- empty = Coming Soon. Paste the CA here to go live.
  TOKEN_NAME:   "RAFFLE",                             // shown while no token is configured
  PRIZE_WALLET: "FCaiVbqDr721tDQ6jTTVF6cghnTDrzx6bZTpKB1TsqHw",
  PACK_THRESHOLD_USD: 50,
  BIG_HOLDER_PCT: 4,
  POLL_MS: 30000,            // heavy poll: token info, holders, pulls
  FAST_POLL_MS: 3000,        // light poll: creator fees only (drives the bar)
  PULLS_RESET_TOKEN: "reset-2026-06-20c",  // bump this string to wipe latest pulls again
  TOP_HOLDERS_SHOWN: 50,
  MAX_PULLS: 12,
  DEFAULT_NFT_VALUE_SOL: null,                        // optional fallback value per card (SOL) if no market price found
  PUMP_PROGRAM:     "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMPSWAP_PROGRAM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  WSOL_MINT:        "So11111111111111111111111111111111111111112",
  USDC_MINT:        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  TOKEN_PROGRAM:    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022:       "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
};
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const PORT = process.env.PORT || 3000;
if (!HELIUS_KEY) { console.error("Missing HELIUS_API_KEY in .env"); process.exit(1); }

const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const STATE_FILE = path.join(__dirname, "data", "state.json");
const comingSoon = () => !CONFIG.TOKEN_MINT;

/* ----------------------------- STATE ----------------------------- */
let state = loadState();
let live = {
  token: { name: CONFIG.TOKEN_NAME, symbol: "", image: "", creator: null, marketCap: null },
  solUsd: 0, holders: [], rateUsdPerSec: 0, lastSampleAt: null, lastSampleCum: null,
  updatedAt: 0, error: null,
};

function freshState() {
  return { mint: CONFIG.TOKEN_MINT, baselineUsd: null, lastUsd: null, cumUsd: 0, packs: 0, winners: [],
    recentPulls: [], seenPulls: [], pullsResetToken: CONFIG.PULLS_RESET_TOKEN, pullsSince: Date.now(), startedAt: Date.now() };
}
function loadState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return freshState(); }
  if (!s.recentPulls) s.recentPulls = [];
  if (!s.seenPulls) s.seenPulls = [];
  if (s.pullsSince == null) s.pullsSince = 0;
  // If the configured token changed (incl. switching to/from Coming Soon), reset the
  // counters so packs/fees/winners start clean.
  if (s.mint !== CONFIG.TOKEN_MINT) {
    console.log(`Token changed (${s.mint || "none"} -> ${CONFIG.TOKEN_MINT || "none"}); resetting packs/fees/winners.`);
    s.mint = CONFIG.TOKEN_MINT;
    s.baselineUsd = null; s.lastUsd = null; s.cumUsd = 0; s.packs = 0; s.winners = [];
  }
  // Reset the latest pulls when the reset token changes; only pulls after `pullsSince` are shown.
  if (s.pullsResetToken !== CONFIG.PULLS_RESET_TOKEN) {
    console.log(`Pulls reset (${s.pullsResetToken || "none"} -> ${CONFIG.PULLS_RESET_TOKEN}).`);
    s.pullsResetToken = CONFIG.PULLS_RESET_TOKEN;
    s.recentPulls = []; s.seenPulls = []; s.pullsSince = Date.now();
  }
  return s;
}
function saveState() {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("saveState:", e.message); }
}

/* ----------------------------- HELPERS ----------------------------- */
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
function pda(seedStr, ownerB58, programB58) {
  const seed = new TextEncoder().encode(seedStr);
  const owner = new web3.PublicKey(ownerB58).toBytes();
  const [addr] = web3.PublicKey.findProgramAddressSync([seed, owner], new web3.PublicKey(programB58));
  return addr.toBase58();
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/* ----------------------------- PRICE ----------------------------- */
async function loadSolPrice() {
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"); const d = await r.json(); if (d.solana && d.solana.usd) live.solUsd = d.solana.usd; }
  catch (e) {}
}

/* ----------------------------- TOKEN INFO ----------------------------- */
async function loadTokenInfo() {
  if (comingSoon()) { live.token = { name: CONFIG.TOKEN_NAME, symbol: "", image: "", creator: null, marketCap: null }; return; }
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${CONFIG.TOKEN_MINT}`);
    const d = await r.json();
    live.token = { name: d.name || "Token", symbol: d.symbol || "", image: d.image_uri || "", creator: d.creator || live.token.creator, marketCap: d.usd_market_cap || null };
    if (d.usd_market_cap && d.market_cap_quote) live.solUsd = d.usd_market_cap / d.market_cap_quote;
  } catch (e) {}
}

/* ----------------------------- CREATOR FEES -----------------------------
   Returns the USD value of unclaimed creator fees sitting in the creator vault(s).
   Handles both SOL-quoted pools (SOL/WSOL) and USDC-quoted pools (USDC). */
async function getUnclaimedCreatorUsd() {
  const creator = live.token.creator;
  if (!creator) return null;
  const auth = [];
  try { auth.push(pda("creator-vault", creator, CONFIG.PUMP_PROGRAM)); } catch (e) {}
  try { auth.push(pda("creator_vault", creator, CONFIG.PUMPSWAP_PROGRAM)); } catch (e) {}
  let usd = 0;
  for (const a of auth) {
    try { const bal = await rpc("getBalance", [a]); const lam = (bal && bal.value != null ? bal.value : (bal || 0)); usd += (lam / 1e9) * live.solUsd; } catch (e) {}
    for (const prog of [CONFIG.TOKEN_PROGRAM, CONFIG.TOKEN_2022]) {
      try {
        const ta = await rpc("getTokenAccountsByOwner", [a, { programId: prog }, { encoding: "jsonParsed" }]);
        (ta.value || []).forEach(x => {
          const info = x.account.data.parsed.info;
          const ui = Number(info.tokenAmount.uiAmount || 0);
          if (info.mint === CONFIG.WSOL_MINT) usd += ui * live.solUsd;
          else if (info.mint === CONFIG.USDC_MINT) usd += ui;
        });
      } catch (e) {}
    }
  }
  return usd;
}

/* ----------------------------- HOLDERS ----------------------------- */
async function getHolders() {
  if (comingSoon()) return [];
  const owners = {}; let total = 0; let page = 1;
  while (page <= 10) {
    let res; try { res = await rpc("getTokenAccounts", { mint: CONFIG.TOKEN_MINT, page, limit: 1000 }); } catch (e) { break; }
    const accts = (res && res.token_accounts) || []; if (!accts.length) break;
    for (const a of accts) { const amt = Number(a.amount || 0); if (amt <= 0) continue; owners[a.owner] = (owners[a.owner] || 0) + amt; total += amt; }
    if (accts.length < 1000) break; page++;
  }
  if (total <= 0) return [];
  const list = Object.entries(owners).map(([owner, amount]) => ({ owner, amount, pct: amount / total * 100 })).sort((a, b) => b.amount - a.amount);
  for (const h of list) { h.big = h.pct >= CONFIG.BIG_HOLDER_PCT; h.eligible = !h.big; }
  return list;
}

/* ----------------------------- NFT IMAGE + VALUE ----------------------------- */
async function getNftImage(mint) {
  try {
    const asset = await rpc("getAsset", { id: mint });
    const files = asset && asset.content && asset.content.files;
    if (files && files.length) return files[0].cdn_uri || files[0].uri;
    return (asset && asset.content && asset.content.links && asset.content.links.image) || null;
  } catch (e) { return null; }
}
/* best-effort market value of a single NFT -> {sol, usd} or null */
async function getNftValue(mint) {
  try {
    const r = await fetch(`https://api-mainnet.magiceden.dev/v2/tokens/${mint}`);
    if (r.ok) {
      const d = await r.json();
      if (typeof d.price === "number" && d.price > 0)
        return { sol: d.price, usd: live.solUsd ? d.price * live.solUsd : null };
    }
  } catch (e) {}
  if (CONFIG.DEFAULT_NFT_VALUE_SOL != null)
    return { sol: CONFIG.DEFAULT_NFT_VALUE_SOL, usd: live.solUsd ? CONFIG.DEFAULT_NFT_VALUE_SOL * live.solUsd : null };
  return null;
}

/* ----------------------------- LATEST PULLS ----------------------------- */
async function refreshPulls() {
  let txs = [];
  try {
    const r = await fetch(`https://api-mainnet.helius-rpc.com/v0/addresses/${CONFIG.PRIZE_WALLET}/transactions?api-key=${HELIUS_KEY}&limit=40`);
    txs = await r.json();
  } catch (e) { return; }
  if (!Array.isArray(txs)) return;
  if (!state.seenPulls) state.seenPulls = [];
  const currentWinner = state.winners.length ? state.winners[state.winners.length - 1].winner : null;
  let added = false;
  for (const tx of txs.reverse()) {                      // oldest first so winner mapping is stable
    const tt = tx.tokenTransfers || [];
    const nft = tt.find(t => t.toUserAccount === CONFIG.PRIZE_WALLET && Number(t.tokenAmount) === 1);
    if (!nft) continue;
    const tsMs = tx.timestamp ? tx.timestamp * 1000 : Date.now();
    if (tsMs < (state.pullsSince || 0)) continue;        // ignore pulls before the last reset
    if (state.seenPulls.includes(tx.signature)) continue;
    state.seenPulls.push(tx.signature);
    const [image, value] = await Promise.all([getNftImage(nft.mint), getNftValue(nft.mint)]);
    state.recentPulls.unshift({
      sig: tx.signature, mint: nft.mint, image,
      valueSol: value ? value.sol : null, valueUsd: value ? value.usd : null,
      winner: currentWinner, at: (tx.timestamp ? tx.timestamp * 1000 : Date.now()),
    });
    added = true;
  }
  if (state.recentPulls.length > CONFIG.MAX_PULLS) state.recentPulls = state.recentPulls.slice(0, CONFIG.MAX_PULLS);
  if (state.seenPulls.length > 200) state.seenPulls = state.seenPulls.slice(-200);
  if (added) saveState();
}

/* ----------------------------- VERIFIABLE DRAW ----------------------------- */
async function recentBlockhash() {
  try { const r = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]); return r.value.blockhash; }
  catch (e) { return "fallback-" + Date.now(); }
}
function pickWinner(blockhash, packIndex, snapshot) {
  if (!snapshot.length) return { winner: null };
  const seedHash = sha(`${blockhash}:${packIndex}`);
  const seedInt = parseInt(seedHash.slice(0, 13), 16);
  const totalW = snapshot.reduce((s, h) => s + h.pct, 0);
  let r = (seedInt / 0xFFFFFFFFFFFFF) * totalW;
  for (const h of snapshot) { r -= h.pct; if (r <= 0) return { winner: h.owner, seedHash }; }
  return { winner: snapshot[snapshot.length - 1].owner, seedHash };
}
async function reconcilePacks() {
  if (comingSoon()) return;
  const target = Math.floor(state.cumUsd / CONFIG.PACK_THRESHOLD_USD);
  while (state.packs < target) {
    const packIndex = state.packs + 1;
    const snapshot = live.holders.filter(h => h.eligible).map(h => ({ owner: h.owner, pct: +h.pct.toFixed(6) }));
    const blockhash = await recentBlockhash();
    const { winner, seedHash } = pickWinner(blockhash, packIndex, snapshot);
    state.packs = packIndex;
    state.winners.push({ pack: packIndex, winner: winner || "no eligible holder", at: Date.now(), blockhash, seedHash: seedHash || null, snapshotHash: sha(JSON.stringify(snapshot)), eligibleCount: snapshot.length });
    console.log(`Pack #${packIndex} -> ${winner}`);
  }
  saveState();
}

/* ----------------------------- FEE ACCUMULATION (USD) ----------------------------- */
function ingestFeeReading(currentUsd) {
  if (currentUsd == null) return;
  const now = Date.now();
  if (state.baselineUsd == null) { state.baselineUsd = currentUsd; state.lastUsd = currentUsd; saveState(); return; }
  if (currentUsd > state.lastUsd) state.cumUsd += (currentUsd - state.lastUsd);   // claims (decreases) don't reduce cumulative
  state.lastUsd = currentUsd;
  if (live.lastSampleAt) { const dt = (now - live.lastSampleAt) / 1000; if (dt > 0) { const inst = (state.cumUsd - live.lastSampleCum) / dt; live.rateUsdPerSec = live.rateUsdPerSec ? live.rateUsdPerSec * 0.6 + inst * 0.4 : inst; } }
  live.lastSampleAt = now; live.lastSampleCum = state.cumUsd;
}

/* ----------------------------- POLLING ----------------------------- */
/* Fast loop (every FAST_POLL_MS): creator fees only -> drives the bar + opens packs. */
let fastBusy = false;
async function fastPoll() {
  if (fastBusy || comingSoon()) return; fastBusy = true;
  try {
    const feeUsd = await getUnclaimedCreatorUsd();
    ingestFeeReading(feeUsd);
    await reconcilePacks();
    live.updatedAt = Date.now();
  } catch (e) { live.error = e.message; }
  finally { fastBusy = false; }
}
/* Slow loop (every POLL_MS): price, token info, holders, pulls. */
let slowBusy = false;
async function poll() {
  if (slowBusy) return; slowBusy = true;
  try {
    await loadSolPrice();
    await loadTokenInfo();
    if (!comingSoon()) {
      const hl = await getHolders();
      if (hl && hl.length) live.holders = hl;
    }
    await refreshPulls();
    live.error = null; live.updatedAt = Date.now();
  } catch (e) { live.error = e.message; console.error("poll:", e.message); }
  finally { slowBusy = false; }
}

/* ----------------------------- API ----------------------------- */
function publicState() {
  const soon = comingSoon();
  const inChunk = state.cumUsd % CONFIG.PACK_THRESHOLD_USD;
  const elig = live.holders.filter(h => h.eligible);
  const totalW = elig.reduce((s, h) => s + h.pct, 0) || 1;
  return {
    comingSoon: soon,
    config: { threshold: CONFIG.PACK_THRESHOLD_USD, bigPct: CONFIG.BIG_HOLDER_PCT, mint: CONFIG.TOKEN_MINT, prizeWallet: CONFIG.PRIZE_WALLET, pollMs: CONFIG.POLL_MS },
    token: live.token,
    fees: { cumUsd: state.cumUsd, inChunk, progressPct: Math.min(100, inChunk / CONFIG.PACK_THRESHOLD_USD * 100), packs: state.packs, rateUsdPerSec: live.rateUsdPerSec },
    holders: live.holders.slice(0, CONFIG.TOP_HOLDERS_SHOWN).map(h => ({ owner: h.owner, pct: h.pct, big: h.big, chance: h.eligible ? (h.pct / totalW * 100) : 0 })),
    eligibleCount: elig.length,
    winners: state.winners.slice(-40).reverse(),
    pulls: state.recentPulls,
    creator: live.token.creator,
    updatedAt: live.updatedAt, error: live.error,
  };
}

const app = express();
app.get("/api/state", (req, res) => res.json(publicState()));
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => {
  console.log(`RAFFLE site on http://localhost:${PORT}  (${comingSoon() ? "COMING SOON mode" : "LIVE: " + CONFIG.TOKEN_MINT})`);
  poll().then(fastPoll);
  setInterval(poll, CONFIG.POLL_MS);
  setInterval(fastPoll, CONFIG.FAST_POLL_MS);
});
