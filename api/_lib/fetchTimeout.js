// fetch() wrapped with an AbortController timeout. Without this, a slow or
// hung third-party (Stripe/Twilio/etc.) pins the serverless function until
// the platform's hard timeout - at scale that exhausts the concurrency pool
// and cascades into an outage. Default 8s: comfortably above normal API
// latency, well under Vercel's function ceiling.
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error(`Upstream request timed out after ${timeoutMs}ms`);
      e.code = 'fetch_timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
