// Mirror every new waitlist signup into the operator's Google Sheet.
//
// Setup (one time, about two minutes):
//   1. Create a Google Sheet. Row 1 headers: Joined, First name, Last name,
//      Email, Phone, Consent, Source.
//   2. Extensions → Apps Script, paste the script from docs/waitlist-sheet.md,
//      Deploy → New deployment → Web app, "Execute as: Me", "Who has
//      access: Anyone", copy the Web app URL.
//   3. Add WAITLIST_SHEET_WEBHOOK_URL=<that URL> in Vercel → Settings →
//      Environment Variables and redeploy.
//
// Best-effort and fire-and-forget: a slow or broken sheet never delays or
// fails the signup, and the row is always in waitlist_signups regardless.
export function sheetConfigured() {
  return /^https:\/\//.test(process.env.WAITLIST_SHEET_WEBHOOK_URL || '');
}

export async function mirrorToSheet(row) {
  const url = process.env.WAITLIST_SHEET_WEBHOOK_URL;
  if (!sheetConfigured()) return { skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joined: row.createdAt || new Date().toISOString(),
        firstName: row.firstName || '',
        lastName: row.lastName || '',
        email: row.email || '',
        phone: row.phone || '',
        consent: row.consent ? 'yes' : 'no',
        source: row.source || '',
      }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[waitlist] sheet mirror failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
