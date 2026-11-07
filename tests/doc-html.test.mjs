// Document body HTML goes through one allowlist (src/lib/docHtml.js) on
// save and on load, in the editor, the preview, the signing page and the PDF.
//
//   [1] the allowlist: editor formatting kept; scripts, event handlers,
//       styles, iframes, unsafe links (javascript:, data:, hidden schemes)
//       removed; http/https/mailto links kept; running it twice changes
//       nothing.
//   [2] the built-in templates come out the same (only a bare "&" is
//       written as "&amp;", which displays the same).
//   [3] the API saves the clean body (create, edit, from a template), and a
//       body stored before this check is shown clean to the owner and the
//       signer while the stored text (what the completion hash covers) is
//       left as it was.
//
// The rendered result for every distinct body in the test database and every
// template was also compared in Chromium against the old sign-page filter:
// identical (see the 1.0.6 code review notes).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/doc-html.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { sanitizeDocHtml } from '../src/lib/docHtml.js';
import { DOCUMENT_TEMPLATES } from '../api/_lib/documentTemplates.js';
import docsIndex from '../api/documents/index.js';
import docById from '../api/documents/[id].js';
import templatesHandler from '../api/documents/templates.js';
import sendHandler from '../api/documents/send.js';
import signHandler from '../api/sign/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('api.resend.com')) {
    const body = JSON.parse(init.body || '{}');
    outbox.push({ to: [].concat(body.to).join(','), html: body.html || '' });
    return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
const call = async (handler, { method = 'GET', body = {}, query = {}, cookie } = {}) => {
  ipN++;
  const r = mockRes();
  await handler({ method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'user-agent': 'test-agent', 'x-forwarded-for': `198.18.7.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } }, r);
  return r;
};

const S = Date.now();
const EVIL = '<h2 onclick="steal()">Terms</h2><p style="x">Pay <b>now</b> <i>please</i></p>'
  + '<img src=x onerror="fetch(\'//evil\')"><script>alert(document.cookie)</script>'
  + '<p><a href="javascript:alert(1)">click</a> <a href="https://example.com/t?a=1&b=2" onmouseover="x()">terms</a></p>'
  + '<iframe src="https://evil.example"></iframe><ul><li>one</li></ul>';
const CLEAN = '<h2>Terms</h2><p>Pay <strong>now</strong> <em>please</em></p>'
  + '<p><a>click</a> <a href="https://example.com/t?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">terms</a></p>'
  + '<ul><li>one</li></ul>';

async function run() {
  console.log('\n[1] the allowlist');
  assert(sanitizeDocHtml(EVIL) === CLEAN, `mixed body cleaned (${sanitizeDocHtml(EVIL)})`);
  const editor = '<h2>Agreement</h2>\n<p>Hi <strong>Mia</strong>, <em>welcome</em> &amp; thanks&nbsp;!</p><ol><li>a<br></li></ol><h3>Sub</h3><p><br></p><p><u>Note</u></p>';
  assert(sanitizeDocHtml(editor) === editor, 'everything the editor produces is kept as is');
  assert(sanitizeDocHtml('<div>Line</div><b>B</b><i>I</i>') === '<p>Line</p><strong>B</strong><em>I</em>', 'div/b/i become p/strong/em, like the editor does on save');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x09;ascript:alert(1)', 'java&Tab;script:alert(1)',
    '&#106;avascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//evil.example', '/relative', ' javascript:alert(1)']) {
    assert(sanitizeDocHtml(`<a href="${bad}">x</a>`) === '<a>x</a>', `link refused: ${bad}`);
  }
  assert(/href="mailto:hi@example\.com"/.test(sanitizeDocHtml('<a href="mailto:hi@example.com">mail</a>')), 'mailto link kept');
  assert(/href="http:\/\/example\.com"/.test(sanitizeDocHtml("<a href='http://example.com'>web</a>")), 'http link kept');
  assert(sanitizeDocHtml('<svg onload=alert(1)><circle/></svg><style>*{}</style><!-- hi -->ok') === 'ok', 'svg, style and comments removed with their contents');
  assert(sanitizeDocHtml('a < b & c <3') === 'a &lt; b &amp; c &lt;3', 'stray < and & are escaped (they show the same)');
  assert(sanitizeDocHtml('<p>cut <img src=x onerror=alert(1)') === '<p>cut ', 'a tag cut off at the end is dropped');
  assert(sanitizeDocHtml('<p title="a>b" onclick="x">t</p>') === '<p>t</p>', 'a ">" inside a quoted attribute does not leak the rest');
  assert(sanitizeDocHtml(null) === '' && sanitizeDocHtml('') === '', 'empty stays empty');
  for (const s of [EVIL, editor, '<a href="https://x.example/?q=1&amp;r=2">k</a>', 'a < b & c']) {
    assert(sanitizeDocHtml(sanitizeDocHtml(s)) === sanitizeDocHtml(s), `running twice changes nothing (${s.slice(0, 30)})`);
  }

  console.log('\n[2] built-in templates');
  for (const t of DOCUMENT_TEMPLATES) {
    const out = sanitizeDocHtml(t.body);
    assert(out.replace(/&amp;/g, '&') === t.body.replace(/&amp;/g, '&'), `${t.id}: unchanged (apart from & written as &amp;)`);
  }

  console.log('\n[3] API: saved clean, shown clean, stored legacy text untouched');
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`dochtml-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const userId = u.rows[0].id;
  const cookie = `ivy_session=${signSession(userId)}`;
  const ws = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${userId}, 'Doc WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${ws}, 'Doc Biz', ${`dochtml-${S}`}, 'UTC') ON CONFLICT (workspace_id) DO NOTHING`;
  const clientId = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${ws}, 'Sig Ner', ${`dochtml-signer-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
  try {
    let r = await call(docsIndex, { method: 'POST', cookie, body: { name: 'Evil', kind: 'written', contentHtml: EVIL } });
    const created = r.body?.document;
    assert(r.statusCode === 201 && created?.contentHtml === CLEAN, 'create: response is clean');
    assert((await sql`SELECT content_html FROM documents WHERE id = ${created.id}`).rows[0].content_html === CLEAN, 'create: stored clean');
    r = await call(docById, { method: 'PATCH', cookie, query: { id: created.id }, body: { contentHtml: `${EVIL}<p>more</p>` } });
    assert(r.statusCode === 200 && (await sql`SELECT content_html FROM documents WHERE id = ${created.id}`).rows[0].content_html === `${CLEAN}<p>more</p>`,
      'edit: stored clean');
    r = await call(templatesHandler, { method: 'POST', cookie, body: { templateId: 'photo-release' } });
    const tpl = DOCUMENT_TEMPLATES.find((t) => t.id === 'photo-release');
    assert(r.body?.document?.contentHtml === sanitizeDocHtml(tpl.body), 'from a template: same body');

    // A body saved before this check (written straight to the table).
    const legacy = (await sql`INSERT INTO documents (workspace_id, name, kind, content_html, fields, is_template)
      VALUES (${ws}, 'Legacy', 'written', ${EVIL},
        ${JSON.stringify([{ id: 'sig', type: 'signature', label: 'Signature', required: true, value: '', signerIndex: 0 }])}::jsonb, FALSE)
      RETURNING id`).rows[0].id;
    r = await call(docById, { cookie, query: { id: legacy } });
    assert(r.statusCode === 200 && r.body.document.contentHtml === CLEAN, 'owner load: shown clean');
    r = await call(sendHandler, { method: 'POST', cookie, body: { id: legacy, recipients: [{ clientId }] } });
    assert(r.statusCode === 200, `legacy document sends (${r.statusCode})`);
    const mail = outbox.find((m) => m.to.includes(`dochtml-signer-${S}@example.com`));
    const token = mail && (mail.html.match(/\/sign\/([^"'\s<?]+)/) || [])[1];
    r = await call(signHandler, { query: { token } });
    assert(r.statusCode === 200 && r.body?.document?.contentHtml === CLEAN, 'signer load: shown clean');
    assert(!JSON.stringify(r.body).includes('onerror') && !JSON.stringify(r.body).includes('<script'), 'nothing executable reaches the signer');
    r = await call(signHandler, { method: 'POST', query: { token }, body: { consent: true, fields: [{ id: 'sig', type: 'signature', value: 'Sig Ner' }] } });
    const after = (await sql`SELECT status, content_html, completion_hash FROM documents WHERE id = ${legacy}`).rows[0];
    assert(r.statusCode === 200 && after.status === 'completed' && /^[0-9a-f]{64}$/.test(after.completion_hash || ''), 'legacy document signs and completes');
    assert(after.content_html === EVIL, 'stored text left as it was, so the completion hash covers what was stored');
  } finally {
    await sql`DELETE FROM workspaces WHERE id = ${ws}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
