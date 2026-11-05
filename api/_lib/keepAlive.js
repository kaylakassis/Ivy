// Keep the serverless function alive for work that finishes AFTER the
// response is sent.
//
// Many paths fire notifications without awaiting them (a booking cancel
// returns 204, then the email + push go out). On Vercel the function can
// be frozen the moment the response ends, which silently drops whatever
// was still in flight. Vercel exposes a per-request context with
// waitUntil(promise) (the same hook @vercel/functions' waitUntil uses):
// handing the promise to it keeps the invocation running until the
// promise settles. Off Vercel (local dev, tests) there is no context and
// this is a no-op that just returns the promise.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

export function keepAlive(promise) {
  try {
    const ctx = globalThis[REQUEST_CONTEXT]?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') {
      // waitUntil must never see a rejection (it would be reported as an
      // unhandled error); the caller still gets the original promise.
      ctx.waitUntil(Promise.resolve(promise).catch(() => {}));
    }
  } catch {
    /* no request context: nothing to extend */
  }
  return promise;
}
