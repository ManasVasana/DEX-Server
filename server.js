require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const redis = require("./redis");
const { mergeTokenLists } = require("./merger");
const { withBackoff } = require("./ratelimit");
const { createClient } = require("redis");
require('./worker.js');

const PORT = process.env.PORT || 3000;
const COINGECKO_TIMEOUT = 8000;
const DEXSCREENER_TIMEOUT = 8000;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL) || 30;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const app = express();
app.use(cors());

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
  try {
    const { data } = await axios.get(url, { timeout: DEXSCREENER_TIMEOUT });
    return data;
  } catch (err) {
    console.warn("DexScreener fetch failed:", err?.message || err);
    return null;
  }
}

async function fetchCoinGecko(address, platform = "ethereum") {
  if (!address) return { raw: null, summary: null };
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    platform
  )}/contract/${encodeURIComponent(address)}`;
  try {
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
  } catch (err) {
    if (err?.response?.status === 404) {
      console.warn(
        `CoinGecko: not found for platform=${platform}, address=${address}`
      );
      return { raw: null, summary: null };
    }
    console.warn("CoinGecko fetch error:", err?.message || err);
    return { raw: null, summary: null };
  }
}

async function fetchSolPriceUsd() {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`;
    const { data } = await axios.get(url, { timeout: COINGECKO_TIMEOUT });
    const p = data?.solana?.usd ?? null;
    return typeof p === "number" ? p : null;
  } catch (err) {
    console.warn("Failed to fetch SOL price:", err?.message || err);
    return null;
  }
}

app.get("/fetch-all", async (req, res) => {
  const useCache = req.query.useCache !== "false";

  try {
    if (useCache) {
      const cached = await redis.getK("tokens:merged");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          console.log("Returning merged tokens from Redis cache");
          return res.json({
            ok: true,
            cached: true,
            fetchedAt: new Date().toISOString(),
            tokens: parsed,
          });
        } catch (e) {
          console.warn(
            "Failed to parse cached tokens, will recompute:",
            e?.message || e
          );
        }
      }
    }

    let solPriceUsd = null;

    // try with backoff first
    try {
      solPriceUsd = await withBackoff(() => fetchSolPriceUsd());
    } catch (_) {
      solPriceUsd = null;
    }

    // fallback to last known good price from Redis
    if (solPriceUsd == null) {
      try {
        const cached = await redis.getK("sol:usd");
        const n = cached ? Number(cached) : null;
        solPriceUsd = Number.isFinite(n) ? n : null;
      } catch (_) {}
    }

    const final_result = [];

    // To avoid API rate limits, processing tokens sequentially
    for (const token of TOKENS) {
      try {
        const [dexData, coinGeckoResult] = await Promise.all([
          withBackoff(() => fetchDexScreener(token.address)),
          withBackoff(() => fetchCoinGecko(token.address, token.platform)),
        ]);

        const merged = mergeTokenLists(
          [
            { source: "dexscreener", list: dexData },
            { source: "coingecko", list: coinGeckoResult?.summary || null },
          ],
          { solPriceUsd, platform: token.platform }
        );

        final_result.push({
          label: token.label,
          token: merged.token,
          pools: merged.pools,
        });
      } catch (tokenErr) {
        console.error(
          `Error processing token ${token.label}:`,
          tokenErr?.message || tokenErr
        );
        final_result.push({
          label: token.label,
          error: tokenErr?.message || String(tokenErr),
        });
      }
    }

    // Saving to cache (storing final_result JSON)
    try {
      await redis.setK(
        "tokens:merged",
        JSON.stringify(final_result),
        CACHE_TTL_SECONDS
      );
      console.log(`Cached merged tokens for ${CACHE_TTL_SECONDS}s`);
    } catch (e) {
      console.warn("Failed to cache merged tokens:", e?.message || e);
    }

    return res.json({
      ok: true,
      cached: false,
      fetchedAt: new Date().toISOString(),
      solPriceUsd,
      tokens: final_result,
    });
  } catch (err) {
    console.error("Server Fetch Error:", err?.message || err);
    res.status(502).json({
      ok: false,
      error: "Failed to fetch token information.",
      details: err?.message || String(err),
    });
  }
});

// WebSocket

const http = require("http").createServer(app);
const { Server: IOServer } = require("socket.io");

const io = new IOServer(http, {
  path: "/ws",
});

io.on("connection", (socket) => {
  console.log("[ws] client connected", socket.id);

  socket.on("subscribe", (data) => {
    console.log("[ws] subscribe", socket.id, data);
  });

  socket.on("disconnect", () => {
    console.log("[ws] client disconnected", socket.id);
  });
});

(async function setupRedisSubscriber() {
  try {
    const sub = createClient({ url: REDIS_URL });
    sub.on("error", (e) =>
      console.error("[redis-sub] error:", e?.message || e)
    );
    await sub.connect();

    // subscribing to 'token_updates' channel
    await sub.subscribe("token_updates", (message) => {
      try {
        const obj = JSON.parse(message);
        console.log("[redis-sub] forwarding to WS:", obj);
        io.emit("delta", obj);
      } catch (err) {
        console.warn("[redis-sub] invalid message:", err?.message || err);
      }
    });

    console.log("[redis-sub] subscribed to token_updates");
  } catch (err) {
    console.error("[redis-sub] failed to subscribe:", err?.message || err);
  }
})();

http.listen(PORT, () => {
  console.log(`Server (HTTP+WS) running on http://localhost:${PORT}`);
});
