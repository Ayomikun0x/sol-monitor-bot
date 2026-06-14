require("dotenv").config();
const { Connection } = require("@solana/web3.js");
const { initBot, alertStartup, sendAlert } = require("./notifier");
const { startMonitor } = require("./monitor");

function validateEnv() {
  const required = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "SOLANA_RPC_WSS",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required environment variables:", missing.join(", "));
    process.exit(1);
  }
}

async function main() {
  validateEnv();
  initBot();

  console.log("Connecting to Solana mainnet via WebSocket...");

  const connection = new Connection(
    process.env.SOLANA_RPC_HTTPS,
    {
      wsEndpoint: process.env.SOLANA_RPC_WSS,
      commitment: "confirmed",
    }
  );

  try {
    const slot = await connection.getSlot();
    console.log("Connected to Solana mainnet — latest slot: " + slot);
  } catch (err) {
    console.error("Failed to connect to Solana RPC:", err.message);
    process.exit(1);
  }

  const count = await startMonitor(connection);
  await alertStartup(count);

  // Heartbeat every 5 minutes
  setInterval(async () => {
    try {
      const slot = await connection.getSlot();
      console.log("Heartbeat — slot: " + slot + " — " + new Date().toISOString());
    } catch (err) {
      console.warn("Heartbeat failed:", err.message);
    }
  }, 5 * 60 * 1000);

  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    await sendAlert("🛑 <b>Solana Token Monitor — OFFLINE</b>").catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
