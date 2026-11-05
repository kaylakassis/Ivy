// emailShell escapes the heading, and callers pass it raw (no double escape).
// Run: node --import ./tests/bootstrap.mjs ./tests/email-shell-escape.test.mjs
import { emailShell } from '../api/_lib/email.js';
import { renderInvoiceOverdue, renderInvoiceSent, renderAdminInviteSponsored } from '../api/_lib/emailRenderers.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const h1 = (html) => (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';

console.log('\n[1] markup in the heading is rendered as text');
const evil = '<img src=x onerror=alert(1)> & "Co"';
let html = emailShell({ heading: evil, body: '<p>hi</p>' });
assert(!/<img/.test(h1(html)) && (html.match(/<img/g) || []).length === 1 && html.includes('email-logo.png'), 'no <img> survives from the heading (the Ivy logo is the only image)');
assert(h1(html).includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;'), 'heading is entity-escaped in the <h1>');
assert(/<title>&lt;img/.test(html), '<title> is escaped too');

console.log('\n[2] plain punctuation stays readable, nothing double-escaped');
html = emailShell({ heading: "You're in, Kay & Co", body: '<p>x</p>' });
assert(h1(html).includes("You're in, Kay &amp; Co"), `apostrophe kept, ampersand escaped once (${h1(html).trim()})`);
assert(!/&amp;amp;/.test(html), 'no &amp;amp;');

console.log('\n[3] callers pass raw text: an invoice number / name with & is escaped exactly once');
const inv = renderInvoiceOverdue({ clientName: 'Sam', number: 'A&B-7', total: 10, dueAt: new Date(), businessName: 'Glow <Studio>' });
assert(h1(inv.html).includes('Invoice A&amp;B-7 is overdue') && !/&amp;amp;/.test(h1(inv.html)), `overdue heading (${h1(inv.html).trim()})`);
const sent = renderInvoiceSent({ clientName: 'Sam', number: 'X<1>', total: 10, businessName: 'Glow' });
assert(h1(sent.html).includes('Invoice X&lt;1&gt;') && !/&amp;lt;/.test(sent.html), `sent heading (${h1(sent.html).trim()})`);
const inv2 = renderAdminInviteSponsored({ firstName: "O'Neil<b>x", name: "O'Neil<b>x Smith" });
assert(h1(inv2.html).includes("Hi O'Neil&lt;b&gt;x,") && !/<b>/.test(h1(inv2.html)), `admin invite greeting (${h1(inv2.html).trim()})`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
