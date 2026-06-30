// GET /api/finance/paypal-return?ws=<workspaceId>&next=<successUrl>
// PayPal redirects the buyer here after they approve an order (we set
// this as the order's return_url in createCheckoutSession). PayPal appends
// ?token=<orderId>&PayerID=... - we CAPTURE the order (this is what
// actually charges the buyer in the redirect flow) and then forward to the
// original success page. The PAYMENT.CAPTURE.COMPLETED webhook then marks
// the invoice/booking paid, exactly like Square.
//
// Public (no session): the buyer arrives straight from paypal.com. Trust
// comes from the orderId being one we created for this workspace's
// merchant; capture is a no-op for anything else.
import { captureOrder } from '../_lib/payments/paypal.js';
import { applyPaymentToInvoice } from '../_lib/paypalApply.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';

// Only forward to a same-origin destination - never an attacker-supplied
// external URL (open-redirect guard). Falls back to the app root.
function safeNext(next) {
  const base = appUrl();
  try {
    const u = new URL(next, base);
    if (u.origin === new URL(base).origin) return u.toString();
  } catch { /* fall through */ }
  return `${base}/`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const q = req.query || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const orderId = first(q.token);
  const ws      = first(q.ws);
  const dest    = new URL(safeNext(first(q.next) || '/'));

  try {
    if (!orderId || !ws) throw new Error('Missing order or workspace');
    const cap = await captureOrder({ orderId, workspaceId: ws });
    // The money has now actually moved. Apply it to the invoice synchronously
    // here instead of relying solely on the PAYMENT.CAPTURE.COMPLETED webhook
    // (which owners frequently never configure) — otherwise the buyer is
    // charged but the invoice stays unpaid forever. Build the same `parsed`
    // shape the webhook produces from the capture response. Idempotent
    // (applyPaymentToInvoice guards on status<>'paid' + matching capture id),
    // so a later webhook can't double-apply. Best-effort: never block the
    // redirect on it.
    try {
      const captureObj = cap?.raw?.purchase_units?.[0]?.payments?.captures?.[0]
        || cap?.raw?.purchase_units?.[0] || {};
      const pu = cap?.raw?.purchase_units?.[0] || {};
      const customId = captureObj.custom_id || pu.custom_id || '';
      let metadata = {};
      try { metadata = customId ? JSON.parse(customId) : {}; } catch { /* not JSON */ }
      const amountCents = captureObj.amount?.value
        ? Math.round(Number(captureObj.amount.value) * 100) : 0;
      await applyPaymentToInvoice({
        workspaceId: ws,
        parsed: {
          paymentId:   captureObj.id || cap?.captureId || null,
          amountCents,
          currency:    (captureObj.amount?.currency_code || 'USD').toUpperCase(),
          metadata,
        },
      });
    } catch (applyErr) {
      // eslint-disable-next-line no-console
      console.error('[paypal-return] apply-to-invoice failed (webhook is the backstop):', applyErr.message);
    }
    dest.searchParams.set('paid', '1');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[paypal-return] capture failed:', err.message);
    dest.searchParams.set('payment', 'error');
    dest.searchParams.set('msg', (err.message || 'Capture failed').slice(0, 160));
  }
  res.writeHead(302, { Location: dest.toString() });
  res.end();
}
