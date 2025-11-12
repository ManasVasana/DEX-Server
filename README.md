<h2>How to Run</h2>

<h3>1. Install dependencies</h3>
<pre><code>npm install
</code></pre>

<h3>2. Start the server</h3>
<pre><code>node server.js
</code></pre>

<h3>3. Test the API</h3>
<pre><code>curl "http://localhost:3000/fetch-all"
</code></pre>
</p>

<hr style="border:0; border-top:1px solid #1a2430;" />

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

<h3>6. Background Worker</h3>
<p>
The backend includes a dedicated background worker (loaded automatically by <code>server.js</code>) that runs on a scheduled interval.
It fetches fresh token data, merges and normalizes it, computes diffs against the previous snapshot, updates the Redis cache, and publishes
only meaningful changes to the <code>token_updates</code> channel. This ensures real-time updates without requiring clients to repeatedly poll the API,
and it also keeps the cache continuously refreshed and ready to serve fast responses whenever a new client calls the API.
</p>

<h3>7. Rate Limiting</h3>
<p>
All external API calls use exponential backoff and retry on 429 responses which makes the worker to never hit 429, even if it calls the api for every 15s.
</p>
