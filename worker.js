// Background refresher with diffing + publish to Redis channel "token_updates"
require("dotenv").config();

const axios = require("axios");
const cron = require("node-cron");
const { mergeTokenLists } = require("./merger");
const { withBackoff } = require("./ratelimit");
const redis = require("./redis");
const { createClient } = require("redis");

const COINGECKO_TIMEOUT = Number(process.env.COINGECKO_TIMEOUT || 8000);
const DEXSCREENER_TIMEOUT = Number(process.env.DEXSCREENER_TIMEOUT || 8000);

// Default: 15s
const CRON_EXPR = process.env.CRON || "*/15 * * * * *";

// TTL=45s
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL || 45);

const CACHE_KEY = process.env.CACHE_KEY || "tokens:merged";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const PUB_CHANNEL = process.env.PUB_CHANNEL || "token_updates";

// Push thresholds & cooldowns
const PUSH_THRESHOLD_PCT = Number(process.env.PUSH_THRESHOLD_PCT || 0.02); // 2% default
const PUSH_COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_MS || 15_000); // 15s default
const LAST_PUB_TTL_SECONDS = Math.ceil(
  Number(process.env.LAST_PUB_TTL_SECONDS) || 60
); // TTL for per-token last-published key

const TOKENS = [
  {
    label: "USDT (ETH)",
    address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    platform: "ethereum",
  },
  {
    label: "USDC (ETH)",
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    platform: "ethereum",
  },
  {
    label: "WETH (ETH)",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    platform: "ethereum",
  },
  {
    label: "WBTC (ETH)",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    platform: "ethereum",
  },
];

async function fetchDexScreener(address) {
  if (!address) return null;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
    address
  )}`;
  const { data } = await axios.get(url, { timeout: DEXSCREENER_TIMEOUT });
  return data;
}

async function fetchCoinGecko(address, platform = "ethereum") {
  if (!address) return { raw: null, summary: null };
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    platform
  )}/contract/${encodeURIComponent(address)}`;
  const { data } = await axios.get(url, { timeout: COINGECKO_TIMEOUT });

  const getPriceUsd = () => {
    const p = data?.market_data?.current_price;
    return p && p.usd !== undefined ? p.usd : null;
  };

  const summary = {
    id: data?.id ?? null,
    name: data?.name ?? null,
    symbol: data?.symbol ? String(data.symbol).toUpperCase() : null,
    contract_address:
      data?.platforms?.[platform] ??
      data?.detail_platforms?.[platform]?.contract_address ??
      data?.contract_address ??
      null,
    decimals: data?.detail_platforms?.[platform]?.decimal_place ?? null,
    price_usd: getPriceUsd(),
    market_cap_usd: data?.market_data?.market_cap?.usd ?? null,
    price_change_percentage_1h:
      data?.market_data?.price_change_percentage_1h_in_currency?.usd ??
      data?.market_data?.price_change_percentage_1h ??
      null,
    price_change_percentage_24h:
      data?.market_data?.price_change_percentage_24h_in_currency?.usd ??
      data?.market_data?.price_change_percentage_24h ??
      null,
    price_change_percentage_7d:
      data?.market_data?.price_change_percentage_7d_in_currency?.usd ??
      data?.market_data?.price_change_percentage_7d ??
      null,
    image: data?.image ?? null,
    links: data?.links ?? null,
    raw: data ?? null,
  };

  return { raw: data, summary };
}

async function fetchSolPriceUsd() {
  if (typeof solPriceUsd === "number") {
    try {
      await redis.setK("sol:usd", String(solPriceUsd), 300);
    } catch (e) {}
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`;
  const { data } = await axios.get(url, { timeout: COINGECKO_TIMEOUT });
  const p = data?.solana?.usd ?? null;
  return typeof p === "number" ? p : null;
}

// Detects changes
function pctChange(oldV, newV) {
  if (oldV == null || newV == null) return Infinity;
  if (typeof oldV !== "number" || typeof newV !== "number") return Infinity;
  if (oldV === 0) return Math.abs(newV - oldV);
  return Math.abs(newV - oldV) / Math.abs(oldV);
}

//Normalises adresses for matching of apis
function canonicalAddressFor(item, tokenConfig) {
  const addr =
    (item?.token &&
      (item.token.token_address || item.token.contract_address)) ||
    (tokenConfig && tokenConfig.address) ||
    item?.label ||
    "";
  return String(addr).toLowerCase();
}

// Extract relevant paramaters for diffing
function extractRelevantNumbers(item) {
  const token = item?.token || {};
  const debug = token._debug || {};

  const price_usd =
    typeof token.price_usd === "number"
      ? token.price_usd
      : typeof debug.price_usd === "number"
      ? debug.price_usd
      : null;

  const market_cap_usd =
    typeof token.market_cap_usd === "number"
      ? token.market_cap_usd
      : typeof debug.market_cap_usd === "number"
      ? debug.market_cap_usd
      : null;

  const volume_usd =
    typeof debug.total_volume_usd === "number" ? debug.total_volume_usd : null;

  const txns24 =
    typeof token.transaction_count === "number"
      ? token.transaction_count
      : null;

  return {
    price_usd,
    market_cap_usd,
    volume_usd,
    txns24,
  };
}

// -------------------- Publisher (Redis) --------------------
let pubClient = null;
async function ensurePublisher() {
  if (pubClient) return;
  pubClient = createClient({ url: REDIS_URL });
  pubClient.on("error", (e) =>
    console.error("[pub] redis error", e?.message || e)
  );
  await pubClient.connect();
}

// Refresher
async function refreshCacheOnce() {
  const started = Date.now();
  console.log(`[worker] refresh start @ ${new Date().toISOString()}`);

  try {
    const solPriceUsd = await withBackoff(() => fetchSolPriceUsd());
    const final_result = [];

    for (const token of TOKENS) {
      try {
        const [dexData, cg] = await Promise.all([
          withBackoff(() => fetchDexScreener(token.address)),
          withBackoff(() => fetchCoinGecko(token.address, token.platform)),
        ]);

        const merged = mergeTokenLists(
          [
            { source: "dexscreener", list: dexData },
            { source: "coingecko", list: cg?.summary || null },
          ],
          { solPriceUsd, platform: token.platform }
        );

        final_result.push({
          label: token.label,
          token: merged.token,
        });
      } catch (innerErr) {
        console.warn(
          `[worker] token error for ${token.label}:`,
          innerErr?.message || innerErr
        );
        final_result.push({
          label: token.label,
          error: innerErr?.message || String(innerErr),
        });
      }
    }

    let prev = null;
    try {
      const prevRaw = await redis.getK(CACHE_KEY);
      prev = prevRaw ? JSON.parse(prevRaw) : null;
    } catch (e) {
      prev = null;
    }

    const prevMap = new Map();
    if (Array.isArray(prev)) {
      for (const p of prev) {
        const tokenCfg = TOKENS.find((t) => t.label === p.label);
        const key = canonicalAddressFor(p, tokenCfg);
        prevMap.set(key, p);
      }
    }

    // computing diffs
    const diffs = [];
    const now = Date.now();

    for (const item of final_result) {
      const tokenCfg = TOKENS.find((t) => t.label === item.label);
      const key = canonicalAddressFor(item, tokenCfg) || item.label; // fallback key
      const oldItem = prevMap.get(key) || null;

      const newNums = extractRelevantNumbers(item);
      const oldNums = oldItem
        ? extractRelevantNumbers(oldItem)
        : { price_usd: null, market_cap_usd: null };

      // decide if change exceeds threshold
      let significant = false;
      let changePct = null;

      if (newNums.price_usd != null && oldNums.price_usd != null) {
        changePct = pctChange(oldNums.price_usd, newNums.price_usd);
        if (changePct === Infinity || changePct >= PUSH_THRESHOLD_PCT)
          significant = true;
      } else if (oldNums.price_usd == null && newNums.price_usd != null) {
        // new discovery -> significant
        significant = true;
        changePct = Infinity;
      } else {
        // fallback: compare market cap if price not available
        if (newNums.market_cap_usd != null && oldNums.market_cap_usd != null) {
          const mcChange = pctChange(
            oldNums.market_cap_usd,
            newNums.market_cap_usd
          );
          if (mcChange === Infinity || mcChange >= PUSH_THRESHOLD_PCT)
            significant = true;
        }
      }

      if (!significant) continue;

      // Respect per-token cooldown
      const lastPubKey = `last_pub:${key}`;
      let lastPubRaw = null;
      try {
        lastPubRaw = await redis.getK(lastPubKey);
      } catch (e) {
        lastPubRaw = null;
      }
      const lastPubTs = lastPubRaw ? Number(lastPubRaw) : 0;
      if (lastPubTs && now - lastPubTs < PUSH_COOLDOWN_MS) {
        // skip due to cooldown
        continue;
      }

      // diff item
      diffs.push({
        address: key,
        label: item.label,
        old: oldNums,
        next: newNums,
        changePct: changePct === Infinity ? null : changePct,
      });
    }

    // Publish if diffs exist
    if (diffs.length > 0) {
      await ensurePublisher();

      const payload = {
        type: "patch",
        seq: Date.now(),
        ts: new Date().toISOString(),
        diffs,
      };

      try {
        await pubClient.publish(PUB_CHANNEL, JSON.stringify(payload));
        console.log(
          `[worker] published ${diffs.length} diffs to ${PUB_CHANNEL}`
        );
        // update per token last published timestamps (with TTL)
        for (const d of diffs) {
          const lastPubKey = `last_pub:${d.address}`;
          try {
            // store timestamp string with TTL
            await redis.setK(
              lastPubKey,
              String(Date.now()),
              LAST_PUB_TTL_SECONDS
            );
          } catch (e) {
            // non-fatal
          }
        }
      } catch (err) {
        console.warn("[worker] publish error:", err?.message || err);
      }
    }

    await redis.setK(
      CACHE_KEY,
      JSON.stringify(final_result),
      CACHE_TTL_SECONDS
    );

    const ms = Date.now() - started;
    console.log(
      `[worker] refresh ok, ${final_result.length} tokens, took ${ms}ms, TTL=${CACHE_TTL_SECONDS}s`
    );
  } catch (err) {
    console.error("[worker] refresh failed:", err?.message || err);
  }
}

// Scheduler
(async function bootstrap() {
  try {
    await redis.ensureConnected();
    // prepare publisher connection in background (non-blocking)
    try {
      await ensurePublisher();
    } catch (e) {
      console.warn("[worker] pub connect failed:", e?.message || e);
    }

    // First run immediately
    await refreshCacheOnce();

    // Cron schedule
    cron.schedule(CRON_EXPR, async () => {
      await refreshCacheOnce();
    });

    // closing pub client on exit
    const shutdown = async () => {
      try {
        if (pubClient) await pubClient.disconnect();
      } catch (e) {
        /* ignore */
      }
      try {
        await redis?.quit?.();
      } catch (e) {}
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(
      `[worker] scheduled with CRON="${CRON_EXPR}", cache key="${CACHE_KEY}"`
    );
  } catch (err) {
    console.error("[worker] bootstrap error:", err?.message || err);
    process.exit(1);
  }
})();
