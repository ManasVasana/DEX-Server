<h2>Design Choices & Reasoning</h2>

<h3>1. Multi-source aggregation</h3>
<p>
CoinGecko provides canonical pricing and market cap.<br>
DexScreener provides pool-level liquidity, volume, tx counts, and fallback prices.<br>
The merger prioritizes CoinGecko when available and falls back to the highest-liquidity Dex pool.
</p>

<h3>2. Pool merging</h3>
<p>
When a token appears across many pools, pools are normalized and deduplicated, then:
</p>
<ul>
  <li>liquidity, volume, txns are summed</li>
  <li>highest-liquidity pool becomes the “primary”</li>
</ul>

<h3>3. SOL conversions</h3>
<p>
All USD metrics are converted to SOL using a separately fetched SOL price for consistent reporting across pairs.
</p>

<h3>4. Diffing instead of pushing full snapshots</h3>
<p>
The worker computes diffs between the last and current snapshot.<br>
A token publishes an update only when:
</p>
<ul>
  <li>change &gt; threshold (default 2%)</li>
  <li>cooldown time passed (default 15s)</li>
</ul>
<p>This prevents noisy updates.</p>

<h3>5. Redis usage</h3>
<ul>
  <li>Key <code>tokens:merged</code> stores the latest full snapshot.</li>
  <li>Channel <code>token_updates</code> broadcasts patches.</li>
  <li>Server subscribes and pushes updates to WebSocket clients.</li>
</ul>

<h3>6. Rate Limiting</h3>
<p>
All external API calls use exponential backoff and retry on 429 responses.
</p>
