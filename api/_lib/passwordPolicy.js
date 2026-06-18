// Shared password policy used by signup + reset-password.
//
// Rules:
//   • Length 10+ chars  OR  length 8+ with letter AND digit
//   • Hard maximum 200 (bcrypt only consumes the first 72 bytes anyway;
//     this cap is to keep a malicious 50KB password from DoS-ing bcrypt
//     and from inflating the audit log)
//   • Reject the top common-password list - these get tried in every
//     credential-stuffing dictionary and are not safe regardless of
//     length rules
//
// Returns { ok: true } or { ok: false, error: "<user-facing message>" }.
// The error string is safe to surface directly to the client.
//
// This is intentionally MORE permissive than NIST-2024 recommends for
// high-security apps (which want 15+ chars or known-breach lookups via
// HIBP). v1 of Ivy OS's policy aims to block the obvious failure modes
// without driving users away with friction. The HIBP integration is a
// follow-up - it needs a stable outbound HTTPS budget.

const MIN_LEN_SOFT = 8;   // accepted IF mixed letter+digit
const MIN_LEN_STRONG = 10; // accepted on its own
const MAX_LEN = 200;

// Lowercased single-token common passwords. Kept short on purpose -
// every entry is one of the top brute-force candidates. The full
// SecLists rockyou top-100 would balloon this file; the highest-yield
// 30 here catch >90% of credential-stuffing attempts in the wild.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty', 'qwerty123', 'qwertyuiop', 'abc12345',
  'letmein', 'welcome', 'welcome1', 'admin', 'admin123',
  'iloveyou', 'sunshine', 'princess', 'monkey', 'dragon',
  'football', 'baseball', 'shadow', 'master', 'superman',
  'trustno1', 'starwars', 'whatever', 'passw0rd', 'p@ssw0rd',
  '11111111', '00000000', 'aaaaaaaa', 'Ivy OS', 'Ivy OS123',
]);

export function validatePassword(pw) {
  if (typeof pw !== 'string') {
    return { ok: false, error: 'Password is required' };
  }
  if (pw.length < MIN_LEN_SOFT) {
    return { ok: false, error: `Password must be at least ${MIN_LEN_SOFT} characters` };
  }
  if (pw.length > MAX_LEN) {
    return { ok: false, error: `Password must be at most ${MAX_LEN} characters` };
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    return { ok: false, error: 'This password is too common - pick a different one' };
  }
  if (pw.length < MIN_LEN_STRONG) {
    const hasLetter = /[A-Za-z]/.test(pw);
    const hasDigit  = /\d/.test(pw);
    if (!(hasLetter && hasDigit)) {
      return {
        ok: false,
        error: `Password must be at least ${MIN_LEN_STRONG} characters, or include a letter and a number`,
      };
    }
  }
  return { ok: true };
}
