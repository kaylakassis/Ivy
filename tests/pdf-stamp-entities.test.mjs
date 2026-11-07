// The signed-PDF renderer survives any text a signer types. A numeric HTML
// entity outside Unicode (e.g. "&#99999999;") used to throw a RangeError
// inside clean(), so the executed copy was never built or emailed.
// Run: node --import ./tests/bootstrap.mjs ./tests/pdf-stamp-entities.test.mjs
import { renderWrittenPdf } from '../api/_lib/pdfStamp.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function render(value, html = '<p>Terms</p>', docName = 'Agreement') {
  try {
    const bytes = await renderWrittenPdf({
      doc: { id: 'd1', name: docName, content_html: html, completed_at: new Date() },
      fields: [{ id: 'f1', type: 'text', label: 'Your note', signerIndex: 0 }, { id: 'f2', type: 'signature', label: 'Signature', signerIndex: 0 }],
      signers: [{ order_index: 0, name: 'Sam', email: 'sam@example.com', signed_at: new Date(), field_values: [{ id: 'f1', value }, { id: 'f2', value }] }],
      hash: 'abc',
      business: 'Glow',
    });
    return { bytes };
  } catch (err) {
    return { err };
  }
}

console.log('\n[1] out-of-range numeric entities in signer text');
for (const v of ['&#99999999;', '&#x7FFFFFFF;', 'ok &#1114112; ok']) {
  const r = await render(v);
  assert(!r.err && r.bytes && r.bytes.length > 500, `PDF built for ${JSON.stringify(v)}${r.err ? ` (${r.err.message})` : ''}`);
}

console.log('\n[2] same in the document body');
const r2 = await render('fine', '<p>Clause &#99999999; here</p>', 'Agreement &#x110000;');
assert(!r2.err && r2.bytes, `PDF built with a bad entity in the body${r2.err ? ` (${r2.err.message})` : ''}`);

console.log('\n[3] normal entities still decode');
const r3 = await render('Kay &amp; Co &#233;');
assert(!r3.err && r3.bytes, 'PDF built for ordinary entities');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
