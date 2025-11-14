function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return secs * 1000;
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

async function withBackoff(taskFn, { retries = 5, base = 400, cap = 12000 } = {}) {
  let attempt = 0;
  let left = retries;

  while (true) {
    try {
      return await taskFn();
    } catch (err) {
      const status = err?.response?.status;
      const headers = err?.response?.headers || {};
      const retryAfterMs = parseRetryAfter(headers['retry-after']);

      const isNetworkish = !status;
      const isTimeout    = status === 408;
      const isServerErr  = status >= 500 && status < 600;
      const isTooMany    = status === 429;

      if (!isTooMany && !isNetworkish && !isTimeout && !isServerErr) {
        throw err;
      }

      const backoffNoJitter = Math.min(cap, base * (2 ** attempt));
      let delay = retryAfterMs != null ? retryAfterMs : backoffNoJitter;
      delay = Math.floor(Math.random() * (delay + 1));

      const label =
        isTooMany ? '429'
        : isTimeout ? '408'
        : isServerErr ? `${status}`
        : isNetworkish ? 'network'
        : 'other';
      console.log(`[backoff] ${label}: waiting ${delay}ms (attempt ${attempt + 1})`);

      await new Promise(r => setTimeout(r, delay));
      attempt += 1;

      if (!isTooMany) {
        left -= 1;
        if (left < 0) throw err;
      }
    }
  }
}

module.exports = { withBackoff };
