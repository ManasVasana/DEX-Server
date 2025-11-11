const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const client = createClient({ url: REDIS_URL });

client.on("error", (err) => {
  console.error("Redis error:", err);
});

let connected = false;
async function ensureConnected() {
  if (connected) return;
  try {
    await client.connect();
    connected = true;
    console.log("Redis connected to", REDIS_URL);
  } catch (err) {
    console.error("Redis connect failed:", err?.message || err);
    throw err;
  }
}

async function setK(key, value, ttlSeconds = null) {
  await ensureConnected();
  if (ttlSeconds) {
    return client.set(key, value, { EX: ttlSeconds });
  } else {
    return client.set(key, value);
  }
}

async function getK(key) {
  await ensureConnected();
  return client.get(key);
}

async function delK(key) {
  await ensureConnected();
  return client.del(key);
}

module.exports = {
  client,
  ensureConnected,
  setK,
  getK,
  delK,
};
