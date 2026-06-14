const { Connection, PublicKey } = require("@solana/web3.js");
const axios = require("axios");
const {
  alertNewToken,
  alertGraduation,
  alertLiquidityAdded,
  alertFirstBuy,
  alertLiquidityWarning,
  alertLiquidityRemoved,
  alertPriceMilestone,
} = require("./notifier");
const { getSolPriceUSD } = require("./price");

// ─── Program IDs ───
const PUMP_FUN_PROGRAM    = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RAYDIUM_AMM         = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CLMM        = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const ORCA_WHIRLPOOL      = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const METEORA_DLMM        = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const METEORA_POOLS       = new PublicKey("Eo7WjKq67rjJQDd1d4Hazh3NJUmLTpaLQQT2DcJvhMkB");

// Pump.fun graduation — when token moves to Raydium
const PUMP_FUN_MIGRATION  = new PublicKey("39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");

const firstBuyDone        = new Set();
const priceTrackers       = new Map();
const liquidityAddedTime  = new Map();
const qualifiedTokens     = new Set();
const tokenInfoCache      = new Map();

const MILESTONES          = [50, 100, 150, 200, 300, 500, 1000];
const SNIPE_WINDOW_MS     = 60000;
const MIN_LIQ_USD         = Number(process.env.MIN_LIQUIDITY_USD || 500);

// ─── Fetch token metadata from Jupiter ───
async function getTokenInfo(mint) {
  if (tokenInfoCache.has(mint)) return tokenInfoCache.get(mint);
  try {
    // Try pump.fun API first
    const res = await Promise.race([
      axios.get(`https://frontend-api.pump.fun/coins/${mint}`, { timeout: 5000 }),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 6000))
    ]);
    const data = res.data;
    const info = {
      name: data.name || "Unknown",
      symbol: data.symbol || "???",
      decimals: 6,
      totalSupply: 1000000000,
    };
    tokenInfoCache.set(mint, info);
    return info;
  } catch {
    // Fallback to Jupiter
    try {
      const res = await Promise.race([
        axios.get(`https://tokens.jup.ag/token/${mint}`, { timeout: 5000 }),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 6000))
      ]);
      const data = res.data;
      const info = {
        name: data.name || "Unknown",
        symbol: data.symbol || "???",
        decimals: data.decimals || 6,
        totalSupply: 1000000000,
      };
      tokenInfoCache.set(mint, info);
      return info;
    } catch {
      const fallback = { name: "Unknown", symbol: "???", decimals: 6, totalSupply: 1000000000 };
      tokenInfoCache.set(mint, fallback);
      return fallback;
    }
  }
}
// ─── Get token price from Jupiter ───
async function getTokenPrice(mint) {
  try {
    const res = await Promise.race([
      axios.get(`https://api.jup.ag/price/v2?ids=${mint}`, { timeout: 5000 }),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 6000))
    ]);
    const price = res.data?.data?.[mint]?.price;
    return price ? parseFloat(price) : 0;
  } catch {
    return 0;
  }
}

// ─── Format price ───
function formatPrice(p) {
  if (!p || p === 0) return "0";
  if (p < 0.000000001) return p.toExponential(4);
  if (p < 0.000001)    return p.toFixed(10);
  if (p < 0.0001)      return p.toFixed(8);
  if (p < 0.01)        return p.toFixed(6);
  if (p < 1)           return p.toFixed(4);
  return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatNumber(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return num.toFixed(4);
}

// ─── Check price milestones ───
async function checkMilestone(mint, name, symbol, currentPrice) {
  const tracker = priceTrackers.get(mint);
  if (!tracker || !tracker.firstBuyPrice) return;
  const gainPct = ((currentPrice - tracker.firstBuyPrice) / tracker.firstBuyPrice) * 100;
  for (const milestone of MILESTONES) {
    if (gainPct >= milestone && tracker.nextMilestone <= milestone) {
      await alertPriceMilestone({
        name, symbol, address: mint,
        gainPct: milestone,
        currentPrice: formatPrice(currentPrice),
        fromPrice: formatPrice(tracker.firstBuyPrice),
      });
      const nextIdx = MILESTONES.indexOf(milestone) + 1;
      tracker.nextMilestone = nextIdx < MILESTONES.length ? MILESTONES[nextIdx] : 999999;
      priceTrackers.set(mint, tracker);
      break;
    }
  }
}

// ─── Parse pump.fun new token ───
async function handlePumpFunNew(connection, signature, accountKeys) {
  try {
    const mint      = accountKeys[1]?.toString();
    const deployer  = accountKeys[0]?.toString();
    if (!mint || !deployer) return;
    if (qualifiedTokens.has(mint)) return;
    const tokenInfo = await getTokenInfo(mint);
    const solPrice  = await getSolPriceUSD();
    const price     = await getTokenPrice(mint);
    const marketCap = price * tokenInfo.totalSupply;

    qualifiedTokens.add(mint);
    liquidityAddedTime.set(mint, Date.now());

    await alertNewToken({
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      address: mint,
      deployer,
      txHash: signature,
      dex: "Pump.fun",
      marketCap: marketCap > 0 ? marketCap : solPrice * 30, // estimate ~30 SOL initial
    });
  } catch (err) {
    console.error("PumpFun new token error:", err.message);
  }
}

// ─── Parse pump.fun graduation ───
async function handlePumpFunGraduation(connection, signature, accountKeys) {
  try {
    const mint     = accountKeys[2]?.toString();
    const deployer = accountKeys[0]?.toString();
    if (!mint) return;

    const tokenInfo = await getTokenInfo(mint);
    const solPrice  = await getSolPriceUSD();
    const price     = await getTokenPrice(mint);
    const liquidityUSD = solPrice * 85; // pump.fun graduation = ~85 SOL
    const marketCap    = price * tokenInfo.totalSupply;

    await alertGraduation({
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      address: mint,
      txHash: signature,
      liquidityUSD,
      price: formatPrice(price),
      marketCap,
    });
  } catch (err) {
    console.error("Graduation error:", err.message);
  }
}

// ─── Parse Raydium liquidity add ───
async function handleRaydiumMint(connection, signature, accountKeys, solAmount) {
  try {
    const mint     = accountKeys[8]?.toString();
    const provider = accountKeys[0]?.toString();
    if (!mint || !provider) return;

    const tokenInfo  = await getTokenInfo(mint);
    const solPrice   = await getSolPriceUSD();
    const price      = await getTokenPrice(mint);
    const valueUSD   = solAmount * solPrice;
    const marketCap  = price * tokenInfo.totalSupply;

    if (valueUSD < MIN_LIQ_USD) return;

    if (!liquidityAddedTime.has(mint)) liquidityAddedTime.set(mint, Date.now());
    qualifiedTokens.add(mint);

    await alertLiquidityAdded({
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      address: mint,
      provider,
      solAmount: solAmount.toFixed(4),
      tokenAmount: 0,
      totalLiqUSD: valueUSD.toFixed(2),
      txHash: signature,
      dex: "Raydium",
      price: formatPrice(price),
      marketCap: formatNumber(marketCap),
      lpStatus: "🔓 Unlocked ⚠️",
    });
  } catch (err) {
    console.error("Raydium mint error:", err.message);
  }
}

// ─── Parse swap / first buy ───
async function handleSwap(connection, signature, accountKeys, mint, solAmount, dex) {
  try {
    if (!qualifiedTokens.has(mint)) return;
    const buyer     = accountKeys[0]?.toString();
    const tokenInfo = await getTokenInfo(mint);
    const solPrice  = await getSolPriceUSD();
    const price     = await getTokenPrice(mint);
    const valueUSD  = solAmount * solPrice;

    if (!firstBuyDone.has(mint)) {
      firstBuyDone.add(mint);
      priceTrackers.set(mint, { firstBuyPrice: price, nextMilestone: MILESTONES[0] });

      const liqTime = liquidityAddedTime.get(mint) || 0;
      const isSnipe = (Date.now() - liqTime) <= SNIPE_WINDOW_MS;

      await alertFirstBuy({
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        address: mint,
        buyer,
        solAmount: solAmount.toFixed(4),
        tokenAmount: 0,
        valueUSD,
        txHash: signature,
        isSnipe,
      });
    } else {
      await checkMilestone(mint, tokenInfo.name, tokenInfo.symbol, price);
    }
  } catch (err) {
    console.error("Swap error:", err.message);
  }
}

// ─── Main monitor ───
async function startMonitor(connection) {
  console.log("Starting Solana monitor...");

  // Watch Pump.fun
  connection.onProgramAccountChange(
    PUMP_FUN_PROGRAM,
    async (accountInfo, context) => {
      try {
        const sigs = await connection.getSignaturesForAddress(
          PUMP_FUN_PROGRAM, { limit: 1 }
        );
        if (!sigs.length) return;
        const sig = sigs[0].signature;
        const tx  = await connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (!tx) return;
        const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
        const logMessages = tx.meta?.logMessages || [];

        if (logMessages.some(l => l.includes("InitializeMint"))) {
          await handlePumpFunNew(connection, sig, accountKeys);
        }
      } catch {}
    },
    "confirmed"
  );

  // Watch Raydium AMM logs
  connection.onLogs(RAYDIUM_AMM, async (logs, ctx) => {
    try {
      if (!logs.logs) return;
      const sig = logs.signature;
      const tx  = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) return;
      const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
      const preBalances  = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      const solChange    = Math.abs((postBalances[0] - preBalances[0]) / 1e9);

      if (logs.logs.some(l => l.includes("initialize2") || l.includes("addLiquidity"))) {
        await handleRaydiumMint(connection, sig, accountKeys, solChange);
      } else if (logs.logs.some(l => l.includes("swap"))) {
        const mint = accountKeys[8]?.toString();
        if (mint) await handleSwap(connection, sig, accountKeys, mint, solChange, "Raydium");
      }
    } catch {}
  }, "confirmed");

  // Watch Orca Whirlpool logs
  connection.onLogs(ORCA_WHIRLPOOL, async (logs, ctx) => {
    try {
      if (!logs.logs) return;
      const sig = logs.signature;
      const tx  = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) return;
      const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
      const preBalances  = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      const solChange    = Math.abs((postBalances[0] - preBalances[0]) / 1e9);

      if (logs.logs.some(l => l.includes("increaseLiquidity") || l.includes("initializePool"))) {
        const mint = accountKeys[4]?.toString();
        if (mint) {
          const tokenInfo = await getTokenInfo(mint);
          const solPrice  = await getSolPriceUSD();
          const price     = await getTokenPrice(mint);
          const valueUSD  = solChange * solPrice;
          const marketCap = price * tokenInfo.totalSupply;
          if (valueUSD < MIN_LIQ_USD) return;
          if (!liquidityAddedTime.has(mint)) liquidityAddedTime.set(mint, Date.now());
          qualifiedTokens.add(mint);
          await alertLiquidityAdded({
            name: tokenInfo.name, symbol: tokenInfo.symbol,
            address: mint, provider: accountKeys[0],
            solAmount: solChange.toFixed(4), tokenAmount: 0,
            totalLiqUSD: valueUSD.toFixed(2), txHash: sig,
            dex: "Orca", price: formatPrice(price),
            marketCap: formatNumber(marketCap),
            lpStatus: "❓ Unknown",
          });
        }
      } else if (logs.logs.some(l => l.includes("swap"))) {
        const mint = accountKeys[4]?.toString();
        if (mint) await handleSwap(connection, sig, accountKeys, mint, solChange, "Orca");
      }
    } catch {}
  }, "confirmed");

  // Watch Meteora logs
  connection.onLogs(METEORA_DLMM, async (logs, ctx) => {
    try {
      if (!logs.logs) return;
      const sig = logs.signature;
      const tx  = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) return;
      const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
      const preBalances  = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      const solChange    = Math.abs((postBalances[0] - preBalances[0]) / 1e9);

      if (logs.logs.some(l => l.includes("addLiquidity") || l.includes("initializeLbPair"))) {
        const mint = accountKeys[3]?.toString();
        if (mint) {
          const tokenInfo = await getTokenInfo(mint);
          const solPrice  = await getSolPriceUSD();
          const price     = await getTokenPrice(mint);
          const valueUSD  = solChange * solPrice;
          const marketCap = price * tokenInfo.totalSupply;
          if (valueUSD < MIN_LIQ_USD) return;
          if (!liquidityAddedTime.has(mint)) liquidityAddedTime.set(mint, Date.now());
          qualifiedTokens.add(mint);
          await alertLiquidityAdded({
            name: tokenInfo.name, symbol: tokenInfo.symbol,
            address: mint, provider: accountKeys[0],
            solAmount: solChange.toFixed(4), tokenAmount: 0,
            totalLiqUSD: valueUSD.toFixed(2), txHash: sig,
            dex: "Meteora", price: formatPrice(price),
            marketCap: formatNumber(marketCap),
            lpStatus: "❓ Unknown",
          });
        }
      } else if (logs.logs.some(l => l.includes("swap"))) {
        const mint = accountKeys[3]?.toString();
        if (mint) await handleSwap(connection, sig, accountKeys, mint, solChange, "Meteora");
      }
    } catch {}
  }, "confirmed");

  // Watch pump.fun graduation
  connection.onLogs(PUMP_FUN_MIGRATION, async (logs, ctx) => {
    try {
      if (!logs.logs) return;
      const sig = logs.signature;
      const tx  = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) return;
      const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
      await handlePumpFunGraduation(connection, sig, accountKeys);
    } catch {}
  }, "confirmed");

  console.log("Monitoring: Pump.fun · Raydium · Orca · Meteora");
  return 4;
}

module.exports = { startMonitor };
