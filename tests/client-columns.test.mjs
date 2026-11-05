// Unit tests for client-list CSV parsing + column auto-detection
// (src/lib/clientColumns.js). Pure, DB-free. Header sets mirror what the
// apps owners switch from put in their exports.
import assert from 'node:assert';
import {
  parseCSVRecords, parseClientCSV, detectColumns, buildClientRows, fileKind, firstEmail, cleanPhone,
} from '../src/lib/clientColumns.js';

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok - ${label}`); };

const fieldsOf = (headers) => {
  const m = detectColumns(headers);
  const o = {};
  m.forEach((f, i) => { if (f) o[f] = headers[i]; });
  return o;
};

check('Square customer export', () => {
  const h = ['Reference ID', 'First Name', 'Last Name', 'Email Address', 'Phone Number', 'Nickname', 'Company Name',
    'Street Address 1', 'Birthday', 'Memo', 'Square Customer ID', 'Creation Source', 'First Visit', 'Last Visit',
    'Transaction Count', 'Email Subscription Status', 'Groups'];
  assert.deepStrictEqual(fieldsOf(h), {
    firstName: 'First Name', lastName: 'Last Name', email: 'Email Address', phone: 'Phone Number',
    notes: 'Memo', tags: 'Groups',
    // The richer client record (address, birthday, company) is kept too.
    occupation: 'Company Name', street: 'Street Address 1', birthday: 'Birthday',
  });
});

check('Acuity client export', () => {
  assert.deepStrictEqual(fieldsOf(['First Name', 'Last Name', 'Phone', 'Email', 'Notes', 'Days Since Last Appointment']), {
    firstName: 'First Name', lastName: 'Last Name', phone: 'Phone', email: 'Email', notes: 'Notes',
  });
});

check('Vagaro style: mobile beats home phone', () => {
  const f = fieldsOf(['Customer Name', 'Email', 'Home Phone', 'Cell Phone', 'Work Phone', 'Customer Since']);
  assert.strictEqual(f.name, 'Customer Name');
  assert.strictEqual(f.phone, 'Cell Phone');
  assert.strictEqual(f.email, 'Email');
});

check('Calendly scheduled events export', () => {
  const f = fieldsOf(['Invitee Name', 'Invitee First Name', 'Invitee Last Name', 'Invitee Email', 'Text Reminder Number', 'Event Type Name', 'Start Date & Time']);
  assert.strictEqual(f.name, 'Invitee Name');
  assert.strictEqual(f.email, 'Invitee Email');
  assert.strictEqual(f.phone, 'Text Reminder Number');
});

check('Fresha / Mindbody style headers', () => {
  const f = fieldsOf(['Client ID', 'First Name', 'Last Name', 'Mobile Number', 'Telephone', 'Email', 'Gender', 'Added']);
  assert.strictEqual(f.phone, 'Mobile Number');
  assert.strictEqual(f.email, 'Email');
  assert.ok(!f.name, 'Client ID must not become the name');
  const m = fieldsOf(['Client', 'Email', 'Mobile Phone']);
  assert.strictEqual(m.name, 'Client');
});

check('Google Contacts CSV', () => {
  const f = fieldsOf(['First Name', 'Middle Name', 'Last Name', 'E-mail 1 - Label', 'E-mail 1 - Value', 'Phone 1 - Label', 'Phone 1 - Value', 'Notes']);
  assert.strictEqual(f.email, 'E-mail 1 - Value');
  assert.strictEqual(f.phone, 'Phone 1 - Value');
  assert.strictEqual(f.notes, 'Notes');
});

check('looser matches: "Client Email Address", "Mobile phone (primary)"', () => {
  const f = fieldsOf(['Full name', 'Client Email Address', 'Mobile phone (primary)', 'Email opt-in']);
  assert.strictEqual(f.name, 'Full name');
  assert.strictEqual(f.email, 'Client Email Address');
  assert.strictEqual(f.phone, 'Mobile phone (primary)');
});

check('each field is claimed once', () => {
  const m = detectColumns(['Email', 'Email Address', 'Phone', 'Phone Number']);
  assert.strictEqual(m.filter((x) => x === 'email').length, 1);
  assert.strictEqual(m.filter((x) => x === 'phone').length, 1);
});

check('first + last are joined when there is no full name', () => {
  const p = parseClientCSV('First Name,Last Name,Email Address,Phone Number\nMaya,Rivera,MAYA@example.com,(555) 123-4567\nJo,,jo@example.com,\n,,,555 0000\n');
  const { rows, dropped } = buildClientRows(p.records, p.mapping, { stage: 'active', tags: ['moved'] });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(dropped, 1);
  assert.deepStrictEqual(rows[0], { name: 'Maya Rivera', sourceIndex: 0, email: 'maya@example.com', phone: '(555) 123-4567', stage: 'active', tags: ['moved'] });
  assert.strictEqual(rows[1].name, 'Jo');
  assert.ok(!('phone' in rows[1]));
});

check('full name column is used, first/last only as fallback', () => {
  const p = parseClientCSV('Name,First Name,Last Name\nMaya R,Maya,Rivera\n,Sam,Lee\n');
  const { rows } = buildClientRows(p.records, p.mapping, {});
  assert.deepStrictEqual(rows.map((r) => r.name), ['Maya R', 'Sam Lee']);
});

check('"Last Name, First Name" column is flipped', () => {
  const p = parseClientCSV('"Last Name, First Name",Email\n"Doe, Jane",jane@example.com\n');
  assert.strictEqual(p.mapping[0], 'nameLastFirst');
  assert.strictEqual(buildClientRows(p.records, p.mapping, {}).rows[0].name, 'Jane Doe');
});

check('unknown stage values fall back to the chosen default', () => {
  const p = parseClientCSV('Name,Status\nA,Active\nB,VIP\n');
  const { rows } = buildClientRows(p.records, p.mapping, { stage: 'lead' });
  assert.deepStrictEqual(rows.map((r) => r.stage), ['active', 'lead']);
});

check('semicolon and tab delimited files', () => {
  const s = parseClientCSV('Vorname;Nachname;Name;E-Mail\nA;B;Anna B;anna@example.de\n');
  assert.strictEqual(s.mapping[3], 'email');
  assert.strictEqual(s.records[0][2], 'Anna B');
  const t = parseClientCSV('Name\tEmail\nTab Person\ttab@example.com\n');
  assert.deepStrictEqual(t.mapping, ['name', 'email']);
});

check('title rows above the header are skipped', () => {
  const p = parseClientCSV('Customer List Report\nJan 1 - Dec 31\nCustomer Name,Email\nAna,ana@example.com\n');
  assert.deepStrictEqual(p.headers, ['Customer Name', 'Email']);
  assert.strictEqual(p.records.length, 1);
});

check('quoted cells with commas, quotes and newlines', () => {
  const recs = parseCSVRecords('Name,Notes\r\n"Lee, Sam","Likes ""quiet"" rooms\nand tea"\r\n');
  assert.deepStrictEqual(recs[1], ['Lee, Sam', 'Likes "quiet" rooms\nand tea']);
});

check('cells with several emails or phones keep the first', () => {
  assert.strictEqual(firstEmail('a@example.com; b@example.com'), 'a@example.com');
  assert.strictEqual(firstEmail('Maya <maya@example.com>'), 'maya@example.com');
  assert.strictEqual(firstEmail('none'), '');
  assert.strictEqual(cleanPhone('555-1111 / 555-2222'), '555-1111');
  assert.strictEqual(cleanPhone('n/a'), '');
});

check('malformed input never throws and is bounded', () => {
  for (const bad of [null, undefined, '', '"', '"""', ',,,,\n,,,', '\uFEFF', 'a'.repeat(10000)]) {
    const p = parseClientCSV(bad);
    assert.ok(Array.isArray(p.records));
  }
  const t0 = Date.now();
  const huge = 'Name,Email\n' + 'x,y@z.co\n'.repeat(100000);
  const p = parseClientCSV(huge);
  assert.ok(p.records.length <= 2000, 'rows are capped');
  const wide = parseCSVRecords(Array.from({ length: 5000 }, (_, i) => `c${i}`).join(','));
  assert.ok(wide[0].length <= 200, 'columns are capped');
  parseCSVRecords('"' + 'a'.repeat(3_000_000));
  assert.ok(Date.now() - t0 < 3000, 'took too long');
});

check('fileKind routes files to the right flow', () => {
  assert.strictEqual(fileKind({ name: 'clients.csv' }), 'csv');
  assert.strictEqual(fileKind({ name: 'Contacts.VCF' }), 'vcf');
  assert.strictEqual(fileKind({ name: 'cal.ics' }), 'ics');
  assert.strictEqual(fileKind({ name: 'export.xlsx' }), 'excel');
  assert.strictEqual(fileKind({ name: 'x', type: 'text/vcard' }), 'vcf');
  assert.strictEqual(fileKind({ name: 'photo.png', type: 'image/png' }), 'unknown');
});

console.log(`\nclient-columns: ${passed} passed`);
process.exit(0);
