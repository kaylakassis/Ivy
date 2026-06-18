// PII redaction for log output.
//
// Most of our logs are short (`[booking-reminder 123/120] email failed: ...`)
// and don't include user data directly. But some places - error messages
// from Postgres, error stacks that include query params - can leak
// emails, phone numbers, and access tokens into Vercel function logs.
// These logs end up in third-party log aggregators where any insider
// at that vendor can read them.
//
// redact(text): returns the text with common PII patterns masked.
// Idempotent + cheap (regex pass over a usually-short string).
//
// Patterns we mask:
//   • email addresses          → e***@example.com
//   • phone numbers (E.164)    → +1***234 (last 4 only)
//   • bearer tokens / API keys → bearer ***
//   • Stripe-style sk_/pk_/whsec_ → keeps prefix, masks rest
//   • UUIDs                    → kept (not PII, useful for debugging)
//
// Numbers, IDs, statuses, and other non-PII shapes are intentionally
// untouched - over-aggressive redaction makes logs useless for
// debugging.
//
// Use in any log line that may carry user-supplied or sensitive data:
//   console.error('[handler]', redact(err.message));

const EMAIL_RE = /([a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const PHONE_RE = /(\+?[1-9]\d{1,3})[\s().-]?(\d{2,4})[\s().-]?(\d{2,4})[\s().-]?(\d{2,6})/g;
const BEARER_RE = /\b(bearer\s+)([A-Za-z0-9._\-]+)/gi;
const STRIPE_KEY_RE = /\b((?:sk|pk|whsec|rk)_(?:test|live)?_)[A-Za-z0-9]+/g;
const PASSWORD_FIELD_RE = /("?(?:password|passwd|pwd|secret|token|api_?key)"?\s*[:=]\s*"?)[^",\s}]+/gi;

export function redact(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : String(input);
  // Order matters - mask longer patterns first so their bytes don't
  // get partially-matched by the shorter ones.
  s = s.replace(PASSWORD_FIELD_RE, '$1***');
  s = s.replace(STRIPE_KEY_RE, '$1***');
  s = s.replace(BEARER_RE, '$1***');
  s = s.replace(EMAIL_RE, (_m, first, domain) => `${first}***${domain}`);
  s = s.replace(PHONE_RE, (m) => {
    // Keep the country code + last 4 digits; mask the middle.
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7) return m;
    const last4 = digits.slice(-4);
    return digits.startsWith('1') || digits.length > 10
      ? `+${digits[0]}***${last4}`
      : `***${last4}`;
  });
  return s;
}

// Redact an arbitrary object's stringifiable fields. Walks one level
// deep; recursing further is wasted work for typical log payloads.
export function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = redact(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Stringify nested objects then redact the whole string so
      // emails inside { details: { email: 'x@y.com' } } get caught.
      try { out[k] = JSON.parse(redact(JSON.stringify(v))); }
      catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}
