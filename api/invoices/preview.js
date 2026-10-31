// GET /api/invoices/preview?id=<invoice id>
// What the client will get for this invoice, before it is sent: the
// invoice as the public page renders it (with the owner's design) and
// the exact email, subject and body, the send button would deliver.
// Owner-only; the invoice must belong to the caller's workspace.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { fetchOwnedInvoice, serializeInvoicePublic, computeTotals } from '../_lib/finance.js';
import { fetchBranding, invoiceBusinessMeta } from '../_lib/branding.js';
import { renderInvoiceSent } from '../_lib/emailRenderers.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const id = String(req.query?.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest(res, 'id is required');
    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return notFound(res, 'Invoice not found');
    const [business, branding] = await Promise.all([invoiceBusinessMeta(workspaceId), fetchBranding(workspaceId)]);
    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const email = renderInvoiceSent({
      clientName: inv.client_name || 'there', businessName: branding.businessName,
      number: inv.number, total: totals.total, dueDate: inv.due_date,
      items: inv.items, viewUrl: `${appUrl()}/invoice/preview`, branding,
    });
    return ok(res, {
      invoice: serializeInvoicePublic(inv, { business }),
      email: { subject: email.subject, html: email.html },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
