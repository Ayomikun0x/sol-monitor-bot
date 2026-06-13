const axios = require("axios");

let cachedSolPrice = 150;
let lastFetch = 0;
const CACHE_TTL = 60_000;

async function getSolPriceUSD() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL) return cachedSolPrice;

  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { timeout: 5000 }
    );
    cachedSolPrice = res.data?.solana?.usd || cachedSolPrice;
    lastFetch = now;
  } catch {
    // silently use cached value
  }
  return cachedSolPrice;
}

function solToUSD(solAmount, solPriceUSD) {
  return (parseFloat(solAmount) * solPriceUSD).toFixed(2);
}

module.exports = { getSolPriceUSD, solToUSD };
