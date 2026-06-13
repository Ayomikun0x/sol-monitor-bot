const TelegramBot = require("node-telegram-bot-api");

let bot;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function initBot() {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  console.log("Telegram bot initialized");
  return bot;
}

async function sendAlert(message, { tokenAddress, silent = false } = {}) {
  if (!bot) return;
  try {
    await bot.sendMessage(CHAT_ID, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: silent,
    });
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

function alertNewToken({ name, symbol, address, deployer, txHash, dex, marketCap }) {
  return sendAlert(
    `🆕 <b>NEW TOKEN</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>  ·  ${dex}\n\n` +
    `📊 MCap      <b>$${formatNumber(marketCap)}</b>\n` +
    `👤 Deployer  <a href="https://solscan.io/account/${deployer}">${shortAddr(deployer)}</a>\n` +
    `📍 Contract  <code>${address}</code>\n\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">TX</a>  ·  <a href="https://gmgn.ai/sol/token/${address}">GMGN</a>  ·  <a href="https://dexscreener.com/solana/${address}">Chart</a>`,
    { tokenAddress: address }
  );
}

function alertGraduation({ name, symbol, address, txHash, liquidityUSD, price, marketCap }) {
  return sendAlert(
    `🎓 <b>PUMP.FUN GRADUATION!</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>\n\n` +
    `🎉 Token graduated to Raydium!\n\n` +
    `💵 Liquidity  <b>$${formatNumber(liquidityUSD)}</b>\n` +
    `💲 Price      <b>$${price}</b>\n` +
    `📊 MCap       <b>$${formatNumber(marketCap)}</b>\n\n` +
    `📍 Contract  <code>${address}</code>\n\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">TX</a>  ·  <a href="https://gmgn.ai/sol/token/${address}">GMGN</a>  ·  <a href="https://dexscreener.com/solana/${address}">Chart</a>`,
    { tokenAddress: address + "_grad" }
  );
}

function alertLiquidityAdded({ name, symbol, address, provider, solAmount, tokenAmount, totalLiqUSD, txHash, dex, price, marketCap, lpStatus }) {
  return sendAlert(
    `💧 <b>LIQUIDITY ADDED</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>  ·  ${dex}\n\n` +
    `💵 Added     <b>${solAmount} SOL</b>\n` +
    `🪙 Tokens    ${formatNumber(tokenAmount)} ${symbol}\n` +
    `🏊 Pool      ~$${formatNumber(totalLiqUSD)}\n` +
    `💲 Price     <b>$${price}</b>\n` +
    `📊 MCap      <b>$${formatNumber(marketCap)}</b>\n` +
    `🔐 LP        ${lpStatus || "❓ Unknown"}\n\n` +
    `👛 Wallet    <a href="https://solscan.io/account/${provider}">${shortAddr(provider)}</a>  ·  <a href="https://gmgn.ai/sol/address/${provider}">GMGN</a>\n` +
    `📍 Contract  <code>${address}</code>\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">TX</a>  ·  <a href="https://gmgn.ai/sol/token/${address}">GMGN Chart</a>`,
    { tokenAddress: address + "_liq" }
  );
}

function alertFirstBuy({ name, symbol, address, buyer, solAmount, tokenAmount, valueUSD, txHash, isSnipe }) {
  const snipeTag = isSnipe ? `\n⚡ <b>SNIPE DETECTED</b> — bought within 60s of liquidity!` : "";
  return sendAlert(
    `🟢 <b>FIRST BUY${isSnipe ? " ⚡" : ""}</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>  ·  Solana` +
    `${snipeTag}\n\n` +
    `💰 Spent     <b>${solAmount} SOL</b>  (~$${formatNumber(valueUSD)})\n` +
    `🛒 Got       ${formatNumber(tokenAmount)} ${symbol}\n\n` +
    `👛 Wallet    <a href="https://solscan.io/account/${buyer}">${shortAddr(buyer)}</a>  ·  <a href="https://gmgn.ai/sol/address/${buyer}">GMGN</a>\n` +
    `📍 Contract  <code>${address}</code>\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">TX</a>  ·  <a href="https://gmgn.ai/sol/token/${address}">GMGN Chart</a>`,
    { tokenAddress: address + "_buy" }
  );
}

function alertLiquidityWarning({ name, symbol, address, removalPct, provider, txHash }) {
  return sendAlert(
    `⚠️ <b>RUG WARNING</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>  ·  Solana\n\n` +
    `🚨 Removing  <b>${removalPct}%</b> of liquidity!\n` +
    `⚡ Act fast!\n\n` +
    `👛 Wallet    <a href="https://solscan.io/account/${provider}">${shortAddr(provider)}</a>  ·  <a href="https://gmgn.ai/sol/address/${provider}">GMGN</a>\n` +
    `📍 Contract  <code>${address}</code>\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">TX</a>  ·  <a href="https://gmgn.ai/sol/token/${address}">GMGN Chart</a>`,
    { tokenAddress: address + "_warn" }
  );
}

function alertLiquidityRemoved({ name, symbol, address, provider, solAmount, tokenAmount, removedPct, txHash }) {
  return sendAlert(
    `🔴 <b>LIQUIDITY REMOVED</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>  ·  Solana\n\n` +
    `💸 Pulled    <b>${solAmount} SOL</b>\n` +
    `🪙 Tokens    ${formatNumber(tokenAmount)} ${symbol}\n` +
    `📉 Removed   <b>${removedPct}%</b> of pool\n\n` +
    `👛 Wallet    <a href="https://solscan.io/account/${provider}">${shortAddr(provider)}</a>  ·  <a href="https://gmgn.ai/sol/address/${provider}">GMGN</a>\n` +
    `📍 Contract  <code>${address}</code>\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">TX</a>  ·  <a href="https://gmgn.ai/sol/token/${address}">GMGN Chart</a>`,
    { tokenAddress: address + "_removed" }
  );
}

function alertPriceMilestone({ name, symbol, address, gainPct, currentPrice, fromPrice }) {
  const emoji = gainPct >= 200 ? "🚀" : gainPct >= 100 ? "💎" : "📈";
  return sendAlert(
    `${emoji} <b>${gainPct}% GAIN!</b>\n\n` +
    `<b>${name}</b>  <code>$${symbol}</code>\n\n` +
    `📈 Gain      <b>+${gainPct}%</b> since first buy\n` +
    `💲 Now       <b>$${currentPrice}</b>\n` +
    `🏁 Started   $${fromPrice}\n\n` +
    `📍 Contract  <code>${address}</code>\n` +
    `🔗 <a href="https://gmgn.ai/sol/token/${address}">GMGN Chart</a>`,
    { tokenAddress: address + "_milestone" }
  );
}

function alertStartup(watching) {
  return sendAlert(
    `🤖 <b>Solana Token Monitor — ONLINE</b>\n\n` +
    `📡 Watching: Pump.fun · Raydium · Orca · Meteora\n` +
    `✅ New tokens · Liquidity · First buy · Milestones\n` +
    `🎓 Pump.fun graduation alerts enabled\n` +
    `⚠️ Rug warning + removal alerts enabled\n` +
    `📈 Price milestones: 50%, 100%, 200%+\n` +
    `⏰ ${new Date().toUTCString()}`
  );
}

function shortAddr(addr) {
  if (!addr) return "Unknown";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function formatNumber(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return num.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

module.exports = {
  initBot, sendAlert, alertNewToken, alertGraduation,
  alertLiquidityAdded, alertFirstBuy, alertLiquidityWarning,
  alertLiquidityRemoved, alertPriceMilestone, alertStartup,
  shortAddr, formatNumber,
};
