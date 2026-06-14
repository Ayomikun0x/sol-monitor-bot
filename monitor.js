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

const RAYDIUM_AMM        = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const PUMP_FUN_MIGRATION = new PublicKey("39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");

const firstBuyDone       = new Set();
const priceTrackers      = new Map();
const liquidityAddedTime = new Map();
const qualifiedTokens    = new Set();
const tokenInfoCache     = new Map();
const processedSigs      = new Set();

const MILESTONES      = [50, 100, 150, 200, 300, 500, 1000];
const SNIPE_WINDOW_MS = 60000;
const MIN_LIQ_USD     = Number(process.env.MIN_LIQUIDITY_USD || 500);

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

async function startMonitor(connection) {
  console.log("Starting Solana monitor — Raydium + Pump.fun graduation only...");

  // Watch Raydium AMM
  connection.onLogs(RAYDIUM_AMM, async (logs, ctx) => {
    try {
      if (!logs.logs || !logs.signature) return;
      const sig = logs.signature;

      // Prevent duplicate processing
      if (processedSigs.has(sig)) return;
      processedSigs.add(sig);
      if (processedSigs.size > 1000) {
        const first = processedSigs.values().next().value;
        processedSigs.delete(first);
      }

      const tx = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) return;

      const accountKeys  = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
      const preBalances  = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      const solChange    = Math.abs((postBalances[0] - preBalances[0]) / 1e9);
      const logMessages  = logs.logs || [];

      // Liquidity added
      if (logMessages.some(l => l.includes("initialize2") || l.includes("InitializeInstruction2"))) {
        const mint     = accountKeys[8]?.toString();
        const provider = accountKeys[0]?.toString();
        if (!mint || !provider) return;

        const tokenInfo = await getTokenInfo(mint);
        const solPrice  = await getSolPriceUSD();
        const price     = await getTokenPrice(mint);
        const valueUSD  = solChange * solPrice;
        const marketCap = price * tokenInfo.totalSupply;

        if (valueUSD < MIN_LIQ_USD) return;
        if (!liquidityAddedTime.has(mint)) liquidityAddedTime.set(mint, Date.now());
        qualifiedTokens.add(mint);

        console.log("Liquidity added: " + tokenInfo.symbol + " $" + valueUSD.toFixed(2));

        await alertNewToken({
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          address: mint,
          deployer: provider,
          txHash: sig,
          dex: "Raydium",
          marketCap: marketCap > 0 ? marketCap : valueUSD * 2,
        });

        await alertLiquidityAdded({
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          address: mint,
          provider,
          solAmount: solChange.toFixed(4),
          tokenAmount: 0,
          totalLiqUSD: valueUSD.toFixed(2),
          txHash: sig,
          dex: "Raydium",
          price: formatPrice(price),
          marketCap: formatNumber(marketCap),
          lpStatus: "🔓 Unlocked ⚠️",
        });
      }

      // Swap — first buy + milestones
      else if (logMessages.some(l => l.includes("Instruction: Swap") || l.includes("SwapBaseIn") || l.includes("SwapBaseOut"))) {
        const mint = accountKeys[16]?.toString() || accountKeys[8]?.toString();
        if (!mint || !qualifiedTokens.has(mint)) return;

        const buyer     = accountKeys[0]?.toString();
        const tokenInfo = await getTokenInfo(mint);
        const solPrice  = await getSolPriceUSD();
        const price     = await getTokenPrice(mint);
        const valueUSD  = solChange * solPrice;

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
            solAmount: solChange.toFixed(4),
            tokenAmount: 0,
            valueUSD,
            txHash: sig,
            isSnipe,
          });
        } else {
          await checkMilestone(mint, tokenInfo.name, tokenInfo.symbol, price);
        }
      }

      // Remove liquidity
      else if (logMessages.some(l => l.includes("WithdrawInstruction") || l.includes("Instruction: Withdraw"))) {
        const mint     = accountKeys[8]?.toString();
        const provider = accountKeys[0]?.toString();
        if (!mint || !qualifiedTokens.has(mint)) return;

        const tokenInfo = await getTokenInfo(mint);

        await alertLiquidityWarning({
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          address: mint,
          removalPct: "?",
          provider,
          txHash: sig,
        });

        await new Promise(r => setTimeout(r, 1500));

        await alertLiquidityRemoved({
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          address: mint,
          provider,
          solAmount: solChange.toFixed(4),
          tokenAmount: 0,
          removedPct: "?",
          txHash: sig,
        });
      }
    } catch (err) {
      console.error("Raydium log error:", err.message);
    }
  }, "confirmed");

  // Watch pump.fun graduation to Raydium
  connection.onLogs(PUMP_FUN_MIGRATION, async (logs, ctx) => {
    try {
      if (!logs.logs || !logs.signature) return;
      const sig = logs.signature;
      if (processedSigs.has(sig)) return;
      processedSigs.add(sig);

      const tx = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) return;

      const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
      const mint        = accountKeys[2]?.toString();
      if (!mint) return;

      const tokenInfo = await getTokenInfo(mint);
      const solPrice  = await getSolPriceUSD();
      const price     = await getTokenPrice(mint);
      const marketCap = price * tokenInfo.totalSupply;

      console.log("Graduation detected: " + tokenInfo.symbol);

      qualifiedTokens.add(mint);
      liquidityAddedTime.set(mint, Date.now());

      await alertGraduation({
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        address: mint,
        txHash: sig,
        liquidityUSD: solPrice * 85,
        price: formatPrice(price),
        marketCap,
      });
    } catch (err) {
      console.error("Graduation error:", err.message);
    }
  }, "confirmed");

  console.log("Monitoring: Raydium AMM + Pump.fun Graduation");
  return 2;
}

module.exports = { startMonitor };
