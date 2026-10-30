// Branded invoices: design settings save and validate, the client-facing
// invoice carries the design, the owner preview returns the invoice and
// the exact email, and the sent email uses the brand font, logo and color.
// Run: node --import ./tests/bootstrap.mjs ./tests/invoice-design.test.mjs
import crypto from 'node:crypto';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { fetchBranding, invalidateBranding, invoiceBusinessMeta } from '../api/_lib/branding.js';
import { renderInvoiceSent } from '../api/_lib/emailRenderers.js';
import brandingHandler from '../api/account/branding.js';
import previewHandler from '../api/invoices/preview.js';
import viewHandler from '../api/invoice-view/[token].js';
import { INVOICE_FONTS, INVOICE_LAYOUTS, inkFor, DEFAULT_DESIGN } from '../src/lib/invoiceDesign.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mkRes = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } });
const asUser = async (userId, method, url, body) => {
  const token = await signSession(userId);
  const req = { method, url, headers: { cookie: `ivy_session=${token}`, origin: 'http://localhost', host: 'localhost' }, query: Object.fromEntries(new URL(url, 'http://x').searchParams), body: body == null ? undefined : JSON.stringify(body) };
  return req;
};

async function main() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`design-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const owner = u.rows[0].id;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${owner}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  const wid = w.rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, 'Glow Studio', ${`glow-${S}`}) ON CONFLICT (workspace_id) DO UPDATE SET biz_name = 'Glow Studio'`;

  console.log('\n[1] catalog');
  assert(Object.keys(INVOICE_FONTS).length >= 6 && INVOICE_FONTS.system && INVOICE_FONTS.fraunces, 'fonts listed');
  assert(Object.keys(INVOICE_LAYOUTS).join() === 'classic,bold,minimal', 'three layouts');
  assert(inkFor('#2E3168') === '#ffffff' && inkFor('#ffffff') === '#111111', 'ink picks white on dark, black on light');

  console.log('\n[2] defaults before anything is set');
  let b = await fetchBranding(wid);
  assert(b.font === 'system' && b.invoiceLayout === 'classic' && b.invoiceFooter === DEFAULT_DESIGN.footer && b.contact === '', `defaults (${b.font}, ${b.invoiceLayout})`);
  assert(typeof b.fontStack === 'string' && /Helvetica/.test(b.fontStack), 'email font stack for the default font');

  console.log('\n[3] saving a design');
  let res = mkRes();
  await brandingHandler(await asUser(owner, 'PATCH', '/api/account/branding', { font: 'fraunces', invoiceLayout: 'bold', invoiceFooter: 'Thanks for choosing Glow.', contact: '12 Elm St\nAustin, TX\n(512) 555-0100', accentColor: '#0F766E' }), res);
  assert(res.statusCode === 200 && res.body?.branding?.font === 'fraunces' && res.body.branding.invoiceLayout === 'bold', `saved (${res.statusCode} ${JSON.stringify(res.body?.branding?.font)})`);
  invalidateBranding(wid);
  b = await fetchBranding(wid);
  assert(b.font === 'fraunces' && b.invoiceLayout === 'bold' && b.invoiceFooter === 'Thanks for choosing Glow.' && /Elm St/.test(b.contact) && b.accentColor === '#0F766E', 'branding carries the design');
  assert(/Georgia/.test(b.fontStack), 'serif font maps to a serif email stack');
  res = mkRes();
  await brandingHandler(await asUser(owner, 'PATCH', '/api/account/branding', { font: 'comic-sans' }), res);
  assert(res.statusCode === 400, 'unknown font rejected');
  res = mkRes();
  await brandingHandler(await asUser(owner, 'PATCH', '/api/account/branding', { invoiceLayout: 'wild' }), res);
  assert(res.statusCode === 400, 'unknown layout rejected');
  res = mkRes();
  await brandingHandler(await asUser(owner, 'PATCH', '/api/account/branding', { invoiceFooter: 'x'.repeat(1000) }), res);
  assert(res.statusCode === 200 && res.body.branding.invoiceFooter.length === 300, 'footer capped at 300 characters');
  await brandingHandler(await asUser(owner, 'PATCH', '/api/account/branding', { invoiceFooter: 'Thanks for choosing Glow.' }), mkRes());
  invalidateBranding(wid);

  console.log('\n[4] the business block a client invoice carries');
  const meta = await invoiceBusinessMeta(wid);
  assert(meta.name === 'Glow Studio' && meta.font === 'fraunces' && meta.layout === 'bold' && meta.accentColor === '#0F766E' && /Elm/.test(meta.contact) && meta.footer === 'Thanks for choosing Glow.', 'name, font, layout, color, contact, footer');
  assert(!('ownerEmail' in meta) && !('replyTo' in meta), 'no owner email in the public block');

  console.log('\n[5] owner preview: invoice + the exact email');
  const raw = crypto.randomBytes(16).toString('hex');
  const inv = (await sql`INSERT INTO invoices (workspace_id, client_name, client_email, number, status, items, tax_rate, discount, due_date, view_token_hash, sent_at)
    VALUES (${wid}, 'Casey Roberts', ${`casey-${S}@example.com`}, 'INV-7001', 'sent', ${JSON.stringify([{ id: 'a', description: 'Strategy session', quantity: 2, rate: 120 }, { id: 'b', description: 'Notes', quantity: 1, rate: 30 }])}::jsonb, 8.25, 10, NOW() + INTERVAL '14 days', ${sha(raw)}, NOW()) RETURNING id`).rows[0].id;
  res = mkRes();
  await previewHandler(await asUser(owner, 'GET', `/api/invoices/preview?id=${inv}`), res);
  assert(res.statusCode === 200, `200 (${res.statusCode} ${JSON.stringify(res.body).slice(0, 120)})`);
  const pv = res.body;
  assert(pv.invoice?.number === 'INV-7001' && pv.invoice.business?.font === 'fraunces' && pv.invoice.business.layout === 'bold', 'invoice carries the design');
  assert(pv.invoice.items?.length === 2 && Math.abs(pv.invoice.total - ((270 - 10) * 1.0825)) < 0.02, `totals computed (${pv.invoice.total})`);
  assert(/INV-7001/.test(pv.email.subject) && /Glow Studio/.test(pv.email.subject), `email subject: ${pv.email.subject}`);
  assert(/Strategy session/.test(pv.email.html) && /Georgia/.test(pv.email.html) && /#0F766E/i.test(pv.email.html), 'email has the line items, the brand font stack and the brand color');
  assert(!('id' in pv.invoice) && !pv.invoice.viewToken, 'no internal ids in the preview payload');
  const other = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`other-${S}@example.com`}, 'x', 'Other', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${other}, 'Other', 'active', NOW() + INTERVAL '30 days', NOW())`;
  res = mkRes();
  await previewHandler(await asUser(other, 'GET', `/api/invoices/preview?id=${inv}`), res);
  assert(res.statusCode === 404, `another owner cannot preview it (${res.statusCode})`);
  res = mkRes();
  await previewHandler({ method: 'GET', url: `/api/invoices/preview?id=${inv}`, headers: {}, query: { id: inv } }, res);
  assert(res.statusCode === 401, `signed out: 401 (${res.statusCode})`);

  console.log('\n[6] the client page gets the same design');
  res = mkRes();
  await viewHandler({ method: 'GET', url: `/api/invoice-view/${raw}`, headers: { host: 'localhost' }, query: { token: raw } }, res);
  assert(res.statusCode === 200 && res.body?.invoice?.business?.layout === 'bold' && res.body.invoice.business.font === 'fraunces' && res.body.invoice.business.footer === 'Thanks for choosing Glow.', `client view carries layout/font/footer (${res.statusCode})`);

  console.log('\n[7] sent email renderer with branding');
  const e = renderInvoiceSent({ clientName: 'Casey Roberts', businessName: 'Glow Studio', number: 'INV-7001', total: 281.45, dueDate: new Date(), items: [{ description: 'Strategy session', quantity: 2, rate: 120 }], viewUrl: 'https://www.joinivy.ai/invoice/x', branding: { ...b, logoUrl: 'https://cdn.example.com/logo.png' } });
  assert(/cdn\.example\.com\/logo\.png/.test(e.html) && /#0F766E/i.test(e.html) && /Georgia/.test(e.html), 'logo, color and font in the email');
  assert(!/—/.test(e.subject) && !/claude|anthropic/i.test(e.html), 'copy rules');

  console.log('\n[8] every invoice carries the discreet attribution');
  const docSrc = (await import('node:fs')).readFileSync('src/features/finance/InvoiceDocument.jsx', 'utf8');
  assert(/Powered by Ivy: For Solo Businesses/.test(docSrc) && /joinivy\.ai/.test(docSrc), 'document renderer prints "Powered by Ivy: For Solo Businesses"');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
