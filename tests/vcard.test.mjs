// Unit tests for the browser-side contacts file reader (src/lib/vcard.js).
// Pure, DB-free.
import assert from 'node:assert';
import { parseVCards, VCARD_MAX_BYTES, VCARD_MAX_CONTACTS } from '../src/lib/vcard.js';

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok - ${label}`); };

check('vCard 3.0 from iPhone: FN, preferred email, mobile phone', () => {
  const v = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Rivera;Maya;;;',
    'FN:Maya Rivera',
    'item1.EMAIL;type=INTERNET;type=HOME:maya.home@example.com',
    'item2.EMAIL;type=INTERNET;type=WORK;type=pref:Maya@Example.com',
    'TEL;type=HOME;type=VOICE:(555) 111-2222',
    'TEL;type=CELL;type=VOICE:(555) 333-4444',
    'END:VCARD',
  ].join('\r\n');
  const r = parseVCards(v);
  assert.strictEqual(r.contacts.length, 1);
  assert.deepStrictEqual(r.contacts[0], { name: 'Maya Rivera', email: 'maya@example.com', phone: '(555) 333-4444', org: '' });
});

check('vCard 4.0: PREF=1 wins, tel: and mailto: URIs stripped', () => {
  const v = [
    'BEGIN:VCARD', 'VERSION:4.0', 'FN:Sam Lee',
    'EMAIL;TYPE=work:sam@work.example',
    'EMAIL;PREF=1:mailto:sam@home.example',
    'TEL;VALUE=uri;TYPE="voice,home":tel:+1-555-000-1111',
    'TEL;VALUE=uri;PREF=1;TYPE="voice,work":tel:+1-555-000-2222',
    'END:VCARD',
  ].join('\n');
  const c = parseVCards(v).contacts[0];
  assert.strictEqual(c.email, 'sam@home.example');
  assert.strictEqual(c.phone, '+1-555-000-2222');
});

check('vCard 2.1: bare params and quoted-printable name with soft line break', () => {
  const v = [
    'BEGIN:VCARD', 'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BC=',
    'rgen;;;',
    'TEL;CELL;PREF:+49 30 1234567',
    'TEL;HOME:+49 30 7654321',
    'EMAIL;INTERNET:jm@example.de',
    'END:VCARD',
  ].join('\r\n');
  const c = parseVCards(v).contacts[0];
  assert.strictEqual(c.name, 'Jürgen Müller');
  assert.strictEqual(c.phone, '+49 30 1234567');
  assert.strictEqual(c.email, 'jm@example.de');
});

check('folded lines are joined', () => {
  const v = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alexandra Catherine\r\n  Worthington\r\nEMAIL:alex@exa\r\n mple.com\r\nEND:VCARD\r\n';
  const c = parseVCards(v).contacts[0];
  assert.strictEqual(c.name, 'Alexandra Catherine Worthington');
  assert.strictEqual(c.email, 'alex@example.com');
});

check('N is used when FN is missing; ORG when both are missing', () => {
  const v = 'BEGIN:VCARD\nVERSION:3.0\nN:Okafor;Ada;Chi;Dr.;\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nORG:Bloom Studio;Front desk\nTEL:555 9000\nEND:VCARD';
  const r = parseVCards(v);
  assert.strictEqual(r.contacts[0].name, 'Ada Chi Okafor');
  assert.strictEqual(r.contacts[1].name, 'Bloom Studio');
  assert.strictEqual(r.contacts[1].phone, '555 9000');
});

check('backslash escapes are undone', () => {
  const c = parseVCards('BEGIN:VCARD\nVERSION:3.0\nFN:Smith\\, Jo\nEND:VCARD').contacts[0];
  assert.strictEqual(c.name, 'Smith, Jo');
});

check('multiple cards, PHOTO data skipped, invalid email dropped', () => {
  const v = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:One', 'PHOTO;ENCODING=b;TYPE=JPEG:' + 'A'.repeat(5000), ' ' + 'B'.repeat(5000), 'EMAIL:not-an-email', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Two', 'EMAIL:two@example.com', 'END:VCARD',
  ].join('\n');
  const r = parseVCards(v);
  assert.strictEqual(r.contacts.length, 2);
  assert.strictEqual(r.contacts[0].email, '');
  assert.strictEqual(r.contacts[1].email, 'two@example.com');
});

check('a card with no name at all is counted as skipped', () => {
  const r = parseVCards('BEGIN:VCARD\nVERSION:3.0\nTEL:555\nEND:VCARD');
  assert.strictEqual(r.contacts.length, 0);
  assert.strictEqual(r.skipped, 1);
});

check('control characters and HTML-looking names stay inert text', () => {
  const c = parseVCards('BEGIN:VCARD\nFN:<img src=x onerror=alert(1)>\u0007Bob\nEND:VCARD').contacts[0];
  assert.ok(!/\u0007/.test(c.name));
  // The parser does not interpret markup; the UI renders it as text.
  assert.ok(c.name.includes('<img'));
});

check('garbage, empty and non-string input never throw', () => {
  for (const bad of [null, undefined, '', 'hello', 42, 'BEGIN:VCARD', 'END:VCARD\nEND:VCARD', ':::\n;;;', 'BEGIN:VCARD\nFN\nEMAIL;;;;:\nEND:VCARD']) {
    const r = parseVCards(bad);
    assert.ok(Array.isArray(r.contacts));
  }
});

check('nested AGENT card does not leak into the outer contact', () => {
  const v = 'BEGIN:VCARD\nFN:Outer\nAGENT:\nBEGIN:VCARD\nFN:Inner\nEMAIL:inner@example.com\nEND:VCARD\nEMAIL:outer@example.com\nEND:VCARD';
  const r = parseVCards(v);
  assert.strictEqual(r.contacts.length, 1);
  assert.strictEqual(r.contacts[0].name, 'Outer');
  assert.strictEqual(r.contacts[0].email, 'outer@example.com');
});

check('files over 5 MB are refused with a friendly error', () => {
  const r = parseVCards('x'.repeat(VCARD_MAX_BYTES + 1));
  assert.strictEqual(r.contacts.length, 0);
  assert.match(r.error, /5 MB/);
});

check('contact count is capped and reported as truncated', () => {
  const one = 'BEGIN:VCARD\nFN:P\nEND:VCARD\n';
  const r = parseVCards(one.repeat(VCARD_MAX_CONTACTS + 10));
  assert.strictEqual(r.contacts.length, VCARD_MAX_CONTACTS);
  assert.strictEqual(r.truncated, true);
});

check('pathological input finishes quickly', () => {
  const t0 = Date.now();
  parseVCards('BEGIN:VCARD\nFN;' + '"'.repeat(200000) + ':x\n' + 'N:' + ';'.repeat(200000) + '\nEMAIL:' + 'a@'.repeat(100000) + '\nEND:VCARD');
  parseVCards('BEGIN:VCARD\nN;ENCODING=QUOTED-PRINTABLE:' + '=\n'.repeat(50000) + 'END:VCARD');
  assert.ok(Date.now() - t0 < 2000, 'took too long');
});

console.log(`\nvcard: ${passed} passed`);
process.exit(0);
