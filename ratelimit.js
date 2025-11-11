async function withBackoff(taskFn, base = 300, cap = 5000) {
  let attempt = 0;

  while (true) {
    try {
      return await taskFn();
    } catch (err) {
      const status = err?.response?.status;

      if (status !== 429) throw err;

      const delay = Math.min(cap, base * Math.pow(2, attempt));

      console.log(`[429 backoff] waiting ${delay}ms (attempt ${attempt + 1})`);

      await new Promise(res => setTimeout(res, delay));
      attempt++;
    }
  }
}

module.exports = { withBackoff };
