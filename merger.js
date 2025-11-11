// merger.js
function num(x) {
  const n = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(n) ? n : null;
}

function toFixedOrNull(x) {
  const n = num(x);
  return n === null ? null : n;
}

function sum(arr, picker) {
  let total = 0;
  for (const it of arr) {
    const v = num(picker(it));
    if (v !== null) total += v;
  }
  return total;
}

function firstNN(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function pickMostCommonAddress(pools) {
  const counts = new Map();
  for (const p of pools) {
    const ba = p.base_address;
    const qa = p.quote_address;
    if (ba) counts.set(ba, (counts.get(ba) || 0) + 1);
    if (qa) counts.set(qa, (counts.get(qa) || 0) + 1);
  }
  let best = null;
  let bestCnt = -1;
  for (const [addr, c] of counts.entries()) {
    if (c > bestCnt) {
      best = addr;
      bestCnt = c;
    }
  }
  return best;
}

function pickTokenMetaForAddress(pools, tokenAddress) {
  if (!tokenAddress) return { name: null, symbol: null, address: null };
  for (const p of pools) {
    if (p.base_address === tokenAddress) {
      return {
        name: firstNN(p.base_name, p.base_symbol, null),
        symbol: p.base_symbol ?? null,
        address: tokenAddress,
      };
    }
    if (p.quote_address === tokenAddress) {
      return {
        name: firstNN(p.quote_name, p.quote_symbol, null),
        symbol: p.quote_symbol ?? null,
        address: tokenAddress,
      };
    }
  }
  return { name: null, symbol: null, address: tokenAddress };
}

function liquidityWeighted(pools, field) {
  // Weighted by liquidity_usd, skipping pools that lack either weight or value
  let nume = 0;
  let den = 0;
  for (const p of pools) {
    const w = num(p.liquidity_usd);
    const v = num(p[field]);
    if (w !== null && w > 0 && v !== null) {
      nume += v * w;
      den += w;
    }
  }
  return den > 0 ? nume / den : null;
}

function normalizeDexScreener(raw) {
  // raw may be {pairs:[...]} or null
  const pairs = Array.isArray(raw?.pairs) ? raw.pairs : [];
  // Dedup by pairAddress (if present)
  const seen = new Set();
  const out = [];

  for (const pair of pairs) {
    const pairAddress = pair?.pairAddress ?? pair?.id ?? null;
    if (pairAddress && seen.has(pairAddress)) continue;
    if (pairAddress) seen.add(pairAddress);

    const baseToken = pair?.baseToken ?? {};
    const quoteToken = pair?.quoteToken ?? {};

    const base_symbol =
      baseToken?.symbol ?? pair?.baseSymbol ?? pair?.base_token_symbol ?? pair?.base ?? null;
    const quote_symbol =
      quoteToken?.symbol ?? pair?.quoteSymbol ?? pair?.quote_token_symbol ?? pair?.quote ?? null;

    const base_name =
      baseToken?.name ?? pair?.baseName ?? null;
    const quote_name =
      quoteToken?.name ?? pair?.quoteName ?? null;

    const base_address =
      baseToken?.address ?? pair?.baseTokenAddress ?? null;
    const quote_address =
      quoteToken?.address ?? pair?.quoteTokenAddress ?? null;

    const liquidity_usd = firstNN(
      num(pair?.liquidity?.usd),
      num(pair?.liquidityUsd)
    );

    const volume_h24_usd = firstNN(
      num(pair?.volume?.h24),
      num(pair?.volume24hUsd),
      num(pair?.volume24h)
    );

    const tx_buys_h24 = firstNN(
      num(pair?.txns?.h24?.buys),
      num(pair?.txns24h?.buys)
    ) || 0;
    const tx_sells_h24 = firstNN(
      num(pair?.txns?.h24?.sells),
      num(pair?.txns24h?.sells)
    ) || 0;
    const txns_h24 = tx_buys_h24 + tx_sells_h24;

    const price_usd_pool = firstNN(
      num(pair?.priceUsd),
      num(pair?.price?.usd)
    );

    const price_change_h1 = firstNN(
      num(pair?.priceChange?.h1),
      num(pair?.priceChange1h)
    );
    const price_change_h6 = firstNN(
      num(pair?.priceChange?.h6),
      num(pair?.priceChange6h)
    );
    const price_change_h24 = firstNN(
      num(pair?.priceChange?.h24),
      num(pair?.priceChange24h)
    );

    const protocol =
      pair?.dexId ??
      pair?.platformId ??
      pair?.protocol ??
      null;

    out.push({
      source: "dexscreener",
      pair_id: pairAddress,
      protocol,
      base_symbol,
      quote_symbol,
      base_name,
      quote_name,
      base_address,
      quote_address,
      liquidity_usd: toFixedOrNull(liquidity_usd),
      volume_h24_usd: toFixedOrNull(volume_h24_usd),
      txns_h24,
      price_usd_pool: toFixedOrNull(price_usd_pool),
      price_change_h1: toFixedOrNull(price_change_h1),
      price_change_h6: toFixedOrNull(price_change_h6),
      price_change_h24: toFixedOrNull(price_change_h24),
    });
  }

  return out;
}

function choosePrimaryPool(pools) {
  // Sort by liquidity desc, then volume24h desc, then txns desc
  return [...pools].sort((a, b) => {
    const lA = num(a.liquidity_usd) ?? -1;
    const lB = num(b.liquidity_usd) ?? -1;
    if (lA !== lB) return lB - lA;

    const vA = num(a.volume_h24_usd) ?? -1;
    const vB = num(b.volume_h24_usd) ?? -1;
    if (vA !== vB) return vB - vA;

    const tA = num(a.txns_h24) ?? -1;
    const tB = num(b.txns_h24) ?? -1;
    return tB - tA;
  })[0] ?? null;
}

function mergePools(dexPools /* array */) {
  // If multiple APIs later provide overlapping pools, dedupe again by pair_id+protocol.
  const key = (p) => `${p.protocol || "na"}::${p.pair_id || "na"}`;
  const map = new Map();
  for (const p of dexPools) {
    if (!p) continue;
    const k = key(p);
    const existing = map.get(k);
    if (!existing) {
      map.set(k, { ...p });
      continue;
    }
    // merge numeric fields by summing where it makes sense
    // but for a single pool coming from 2 APIs, prefer max liquidity and latest volume/txns
    existing.liquidity_usd = Math.max(
      num(existing.liquidity_usd) ?? 0,
      num(p.liquidity_usd) ?? 0
    );
    existing.volume_h24_usd = Math.max(
      num(existing.volume_h24_usd) ?? 0,
      num(p.volume_h24_usd) ?? 0
    );
    existing.txns_h24 = Math.max(
      num(existing.txns_h24) ?? 0,
      num(p.txns_h24) ?? 0
    );
    // prefer a defined pool price
    existing.price_usd_pool = firstNN(existing.price_usd_pool, p.price_usd_pool);
    // prefer defined price changes
    existing.price_change_h1 = firstNN(existing.price_change_h1, p.price_change_h1);
    existing.price_change_h6 = firstNN(existing.price_change_h6, p.price_change_h6);
    existing.price_change_h24 = firstNN(existing.price_change_h24, p.price_change_h24);
    map.set(k, existing);
  }
  return Array.from(map.values());
}

function toSol(usd, solPriceUsd) {
  const u = num(usd);
  const s = num(solPriceUsd);
  if (u === null || s === null || s === 0) return null;
  return u / s;
}

function buildToken(
  pools,
  cg,                // CoinGecko summary or null
  solPriceUsd        // number or null
) {
  // Aggregate across all pools
  const total_volume_usd = sum(pools, (p) => p.volume_h24_usd);
  const total_liquidity_usd = sum(pools, (p) => p.liquidity_usd);
  const transaction_count = sum(pools, (p) => p.txns_h24);

  const primaryPool = choosePrimaryPool(pools);

  // Price USD (prefer CG, else most-liquid pool)
  const price_usd = firstNN(
    num(cg?.price_usd),
    num(primaryPool?.price_usd_pool)
  );

  // Price change 1h (prefer CG, else liquidity-weighted from pools)
  const price_1hr_change = firstNN(
    num(cg?.price_change_percentage_1h),
    liquidityWeighted(pools, "price_change_h1")
  );

  // Market cap USD (prefer CG)
  const market_cap_usd = num(cg?.market_cap_usd);

  // Token identity: prefer CoinGecko; else infer from pools
  const token_address =
    cg?.contract_address ??
    pickMostCommonAddress(pools);

  const metaFromPools = pickTokenMetaForAddress(pools, token_address);
  const token_name = firstNN(cg?.name, metaFromPools.name, null);
  const token_ticker = firstNN(
    cg?.symbol ? String(cg.symbol).toUpperCase() : null,
    metaFromPools.symbol,
    null
  );

  // Protocol: from the primary (most liquid) pool
  const protocol = primaryPool?.protocol ?? null;

  // USD → SOL conversions
  const price_sol = toSol(price_usd, solPriceUsd);
  const market_cap_sol = toSol(market_cap_usd, solPriceUsd);
  const volume_sol = toSol(total_volume_usd, solPriceUsd);
  const liquidity_sol = toSol(total_liquidity_usd, solPriceUsd);

  return {
    token: {
      token_address: token_address ?? null,
      token_name: token_name ?? null,
      token_ticker: token_ticker ?? null,
      price_sol: price_sol ?? null,
      market_cap_sol: market_cap_sol ?? null,
      volume_sol: volume_sol ?? 0,          // sum across pools converted to SOL
      liquidity_sol: liquidity_sol ?? 0,    // sum across pools converted to SOL
      transaction_count: transaction_count || 0, // sum of buys+sells (24h) across pools
      price_1hr_change: price_1hr_change ?? null,
      protocol,
      _debug: {
        price_usd: price_usd ?? null,
        market_cap_usd: market_cap_usd ?? null,
        total_volume_usd,
        total_liquidity_usd,
      },
    },
  };
}

function extractFromSources(sources) {
  let dsRaw = null;
  let cg = null;

  for (const s of sources || []) {
    if (!s) continue;
    if (s.source === "dexscreener") {
      dsRaw = s.list ?? null;
    } else if (s.source === "coingecko") {
      // s.list may already be the summary object { ... } per server.js
      cg = s.list && s.list.summary ? s.list.summary : s.list ?? null;
    }
  }

  const dexPools = normalizeDexScreener(dsRaw);
  return { pools: mergePools(dexPools), cg };
}

function mergeTokenLists(sources, opts = {}) {
  const solPriceUsd = num(opts?.solPriceUsd);
  const { pools, cg } = extractFromSources(sources);

  // Build final token aggregate
  const merged = buildToken(pools, cg, solPriceUsd);

  // If you want to also return normalized pools for debugging, you can attach them here
  // return { ...merged, pools };

  return merged;
}

module.exports = {
  mergeTokenLists,
};
