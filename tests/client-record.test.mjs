// The richer client record and the import mapping that fills it.
//
//   [1] POST/PATCH /api/clients: address parts, birthday (with or without a
//       year), pronouns, emergency contact, preferred contact, occupation,
//       notes on create; validation; the old one-line address; iPhone 1.0.4
//       payloads and response fields unchanged.
//   [2] Custom fields: owner-only definitions, caps, dropdown choices, type
//       cannot change, values validated per type, delete strips values,
//       another business can neither see nor touch them.
//   [3] Helper redaction: a helper without the clients permission never
//       sees the new fields; one with it does.
//   [4] POST /api/clients/import: details, statuses, new custom fields from
//       columns (all or nothing under the cap), unreadable values kept in
//       notes, quiet still sends nothing.
//   [5] Column detection, status suggestions and date parsing (pure).
//   [6] The 300-row trainer export fixture, mapped with the same code the
//       preview uses, imported through the real endpoint, every field and
//       status checked against the fixture's truth file.
//   [7] Client portal: /api/me/profile birthday + emergency contact, and
//       /api/me/export carries them for the client's own record only,
//       never the business's notes or custom fields.
//   [8] Ivy tools: add_client, update_client, import_clients_from_list
//       accept the new fields.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-record.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import clientsHandler from '../api/clients/index.js';
import clientById from '../api/clients/[id].js';
import fieldsHandler from '../api/clients/fields.js';
import importHandler from '../api/clients/import.js';
import profileHandler from '../api/me/profile.js';
import { buildClientPortalExport } from '../api/_lib/clientExport.js';
import { runApprovedTool, IVY_TOOLS } from '../api/_lib/ivyTools.js';
import { parseBirthday, CUSTOM_FIELD_MAX } from '../api/_lib/clientDetails.js';
import {
  parseClientCSV, detectColumns, defaultKeeps, statusSummary, defaultStatusMap, buildClientRows, newFieldsFor,
  parseDateLoose, dateToApi, suggestStage, ambiguousDateCount, KEEP_NOTES, KEEP_NEW_FIELD, CUSTOM_PREFIX,
} from '../src/lib/clientColumns.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || 'GET' });
  return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
let ip = 0;
async function call(handler, { method = 'POST', body = {}, query = {}, userId, headers = {} }) {
  const res = mockRes();
  ip++;
  await handler({
    method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', host: 'localhost:3001',
      'x-forwarded-for': `203.0.113.${(ip % 200) + 20}`, cookie: `ivy_session=${signSession(userId)}`, ...headers },
  }, res);
  return res;
}
async function mkUser(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`crec-${tag}-${S}@example.com`}, 'x', ${`User ${tag}`}, NOW()) RETURNING id, email`;
  return u.rows[0];
}
async function mkOwner(tag) {
  const u = await mkUser(tag);
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.id, email: u.email, workspaceId: w.rows[0].id };
}
const OLD_FIELDS = ['id', 'name', 'email', 'phone', 'smsConsentAt', 'smsStoppedAt', 'stage', 'tags', 'notes', 'lifetimeValue',
  'source', 'referredByClientId', 'address', 'photoUrl', 'attachments', 'galleryPhotos', 'joinedAt', 'lastSeenAt',
  'createdAt', 'updatedAt', 'inviteSentAt', 'hasClaimedPortal', 'moveAnnouncedAt'];
const NEW_FIELDS = ['addressParts', 'birthday', 'pronouns', 'emergencyContact', 'preferredContact', 'occupation', 'customFields'];

async function run() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'clients-import:%' OR key LIKE 'client-fields:%'`.catch(() => {});
  const A = await mkOwner('a');
  const B = await mkOwner('b');

  console.log('\n[1] create and update with the richer record');
  let r = await call(clientsHandler, { userId: A.userId, body: {
    name: 'Rich Client', email: `rich-${S}@example.com`, phone: '(415) 555-0100', stage: 'active', sendInvite: false,
    notes: 'Left knee: no lunges',
    addressParts: { street: '12 Oak St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'United States' },
    birthday: '1990-03-04', pronouns: 'she/her', occupation: 'Nurse', preferredContact: 'text',
    emergencyContact: { name: 'Sam Rich', phone: '512-555-0101', relationship: 'Partner' },
  } });
  assert(r.statusCode === 201, `create with details answers 201 (${r.statusCode} ${r.body?.error || ''})`);
  let c = r.body?.client || {};
  assert(c.addressParts?.city === 'Austin' && c.addressParts?.postalCode === '78701', 'address parts stored');
  assert(c.address === '12 Oak St, Austin, TX 78701, United States', `one-line address kept in sync for older apps (${c.address})`);
  assert(c.birthday === '1990-03-04' && c.pronouns === 'she/her' && c.occupation === 'Nurse' && c.preferredContact === 'text', 'birthday, pronouns, work, preferred contact stored');
  assert(c.emergencyContact?.name === 'Sam Rich' && c.emergencyContact?.relationship === 'Partner', 'emergency contact stored');
  assert(c.notes === 'Left knee: no lunges', 'notes on create are kept');
  assert(OLD_FIELDS.every((k) => k in c), 'every field the 1.0.4 app reads is still in the response');
  const richId = c.id;

  r = await call(clientsHandler, { userId: A.userId, body: { name: 'Old App', email: `old-${S}@example.com`, source: 'Referral', stage: 'lead', sendInvite: false } });
  assert(r.statusCode === 201 && r.body.client.stage === 'lead' && r.body.client.source === 'Referral', '1.0.4 create payload still works');
  assert(NEW_FIELDS.every((k) => k in r.body.client) && r.body.client.birthday === null && r.body.client.addressParts === null && JSON.stringify(r.body.client.customFields) === '{}', 'new fields read empty for it');
  const oldId = r.body.client.id;

  for (const [bad, label] of [
    [{ birthday: '1990-02-30' }, 'Feb 30'], [{ birthday: '13/04/1990' }, 'not ISO'], [{ birthday: '1850-01-01' }, 'year 1850'],
    [{ birthday: '2999-01-01' }, 'future year'], [{ preferredContact: 'pigeon' }, 'preferred contact'],
  ]) {
    r = await call(clientsHandler, { userId: A.userId, body: { name: 'Bad', phone: '4155550111', ...bad } });
    assert(r.statusCode === 400, `create rejects a bad ${label} (${r.statusCode})`);
  }
  r = await call(clientsHandler, { userId: A.userId, body: { name: 'Leap', phone: '4155550112', birthday: '--02-29', sendInvite: false } });
  assert(r.statusCode === 201 && r.body.client.birthday === '--02-29', 'Feb 29 without a year is fine');
  r = await call(clientsHandler, { userId: A.userId, body: { name: 'Long', phone: '4155550113', pronouns: 'x'.repeat(500), occupation: 'y'.repeat(900), addressParts: { street: 'z'.repeat(900) } } });
  assert(r.statusCode === 201 && r.body.client.pronouns.length === 60 && r.body.client.occupation.length === 120 && r.body.client.addressParts.street.length === 200, 'long values are capped');

  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: oldId }, body: { name: 'Old App Renamed', stage: 'active', notes: 'n' } });
  assert(r.statusCode === 200 && r.body.client.name === 'Old App Renamed' && r.body.client.notes === 'n', '1.0.4 PATCH payload still works');
  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { birthday: '--07-15', emergencyContact: { name: '', phone: '', relationship: '' } } });
  assert(r.statusCode === 200 && r.body.client.birthday === '--07-15' && r.body.client.emergencyContact === null, 'PATCH sets a birthday without a year and clears the emergency contact');
  assert(r.body.client.addressParts?.city === 'Austin', 'fields left out of the PATCH are untouched');
  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { address: '1 New Rd, Dallas' } });
  assert(r.body.client.address === '1 New Rd, Dallas' && r.body.client.addressParts === null, 'an old-style one-line address replaces the parts');
  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { birthday: 'tomorrow' } });
  assert(r.statusCode === 400, 'PATCH rejects a bad birthday');
  r = await call(clientById, { method: 'PATCH', userId: B.userId, query: { id: richId }, body: { birthday: '1990-01-01' } });
  assert(r.statusCode === 404, 'another business cannot edit the client');

  console.log('\n[2] custom fields');
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'Goals', type: 'text' } });
  assert(r.statusCode === 201 && r.body.field.type === 'text', `owner creates a text field (${r.statusCode})`);
  const goals = r.body.field;
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'goals', type: 'number' } });
  assert(r.statusCode === 400, 'a second field with the same name is refused');
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'Level', type: 'select', options: ['Beginner', 'Intermediate', 'Advanced', 'beginner'] } });
  const level = r.body.field;
  assert(r.statusCode === 201 && level.options.length === 3, 'dropdown choices are deduped');
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'Bad', type: 'select', options: Array.from({ length: 31 }, (_, i) => `o${i}`) } });
  assert(r.statusCode === 400, 'a dropdown with too many choices is refused');
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'Bad', type: 'colour' } });
  assert(r.statusCode === 400, 'an unknown type is refused');
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'x'.repeat(61), type: 'text' } });
  assert(r.statusCode === 400, 'a long name is refused');
  const sessions = (await call(fieldsHandler, { userId: A.userId, body: { label: 'Sessions left', type: 'number' } })).body.field;
  const waiver = (await call(fieldsHandler, { userId: A.userId, body: { label: 'Waiver signed', type: 'boolean' } })).body.field;
  const started = (await call(fieldsHandler, { userId: A.userId, body: { label: 'Started', type: 'date' } })).body.field;
  r = await call(fieldsHandler, { method: 'PATCH', userId: A.userId, body: { id: sessions.id, type: 'text' } });
  assert(r.statusCode === 400, "a field's type cannot change");
  r = await call(fieldsHandler, { method: 'PATCH', userId: A.userId, body: { id: goals.id, label: 'Training goals' } });
  assert(r.statusCode === 200 && r.body.field.label === 'Training goals', 'owner renames a field');

  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { customFields: {
    [goals.id]: 'Run a 10k', [level.id]: 'intermediate', [sessions.id]: '12', [waiver.id]: 'yes', [started.id]: '2026-01-15',
    'not-a-field': 'ignored',
  } } });
  c = r.body?.client || {};
  assert(r.statusCode === 200 && c.customFields[goals.id] === 'Run a 10k' && c.customFields[level.id] === 'Intermediate'
    && c.customFields[sessions.id] === 12 && c.customFields[waiver.id] === true && c.customFields[started.id] === '2026-01-15',
  `custom values stored by type (${JSON.stringify(c.customFields)})`);
  assert(!('not-a-field' in c.customFields), 'unknown keys are dropped');
  for (const [k, v, label] of [[level.id, 'Expert', 'a choice not in the list'], [sessions.id, 'lots', 'a non-number'], [waiver.id, 'maybe', 'a non yes/no'], [started.id, '15/01/2026', 'a non-ISO date']]) {
    r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { customFields: { [k]: v } } });
    assert(r.statusCode === 400, `rejects ${label}`);
  }
  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { customFields: { [goals.id]: 'z'.repeat(5000) } } });
  assert(r.statusCode === 200 && r.body.client.customFields[goals.id].length === 1000, 'text values are capped at 1000');
  r = await call(clientById, { method: 'PATCH', userId: A.userId, query: { id: richId }, body: { customFields: { [level.id]: null } } });
  assert(!(level.id in r.body.client.customFields) && r.body.client.customFields[sessions.id] === 12, 'null clears one value and keeps the rest');

  // Another business: cannot see, edit, delete or use A's fields.
  r = await call(fieldsHandler, { method: 'GET', userId: B.userId });
  assert(r.statusCode === 200 && !r.body.fields.some((f) => f.id === goals.id), "B's list does not include A's fields");
  r = await call(fieldsHandler, { method: 'PATCH', userId: B.userId, body: { id: goals.id, label: 'Hacked' } });
  assert(r.statusCode === 404, "B cannot rename A's field");
  r = await call(fieldsHandler, { method: 'DELETE', userId: B.userId, query: { id: goals.id } });
  assert(r.statusCode === 404, "B cannot delete A's field");
  const bClient = (await call(clientsHandler, { userId: B.userId, body: { name: 'B Person', phone: '4155550199', sendInvite: false } })).body.client;
  r = await call(clientById, { method: 'PATCH', userId: B.userId, query: { id: bClient.id }, body: { customFields: { [goals.id]: 'sneaky' } } });
  assert(r.statusCode === 200 && JSON.stringify(r.body.client.customFields) === '{}', "A's field id means nothing on B's client");

  // Cap.
  const have = (await call(fieldsHandler, { method: 'GET', userId: A.userId })).body.fields.length;
  for (let i = have; i < CUSTOM_FIELD_MAX; i++) await call(fieldsHandler, { userId: A.userId, body: { label: `Extra ${i}`, type: 'text' } });
  r = await call(fieldsHandler, { userId: A.userId, body: { label: 'One too many', type: 'text' } });
  assert(r.statusCode === 400 && /up to 25/.test(r.body.error), `field ${CUSTOM_FIELD_MAX + 1} is refused`);
  const extras = (await call(fieldsHandler, { method: 'GET', userId: A.userId })).body.fields.filter((f) => f.label.startsWith('Extra '));
  for (const f of extras) await call(fieldsHandler, { method: 'DELETE', userId: A.userId, query: { id: f.id } });
  r = await call(fieldsHandler, { method: 'DELETE', userId: A.userId, query: { id: waiver.id } });
  assert(r.statusCode === 204, 'owner deletes a field');
  const after = (await sql`SELECT custom_fields FROM clients WHERE id = ${richId}`).rows[0].custom_fields;
  assert(!(waiver.id in after) && after[sessions.id] === 12, "deleting a field removes its values from clients, others stay");
  r = await call(fieldsHandler, { method: 'GET', userId: A.userId });
  assert(r.body.dateOrder === 'mdy' && r.body.max === CUSTOM_FIELD_MAX, 'GET gives the date order (US by default) and the cap');
  await sql`INSERT INTO workspace_profile (workspace_id, location_country) VALUES (${B.workspaceId}, 'United Kingdom')
            ON CONFLICT (workspace_id) DO UPDATE SET location_country = 'United Kingdom', location_state = NULL`;
  r = await call(fieldsHandler, { method: 'GET', userId: B.userId });
  assert(r.body.dateOrder === 'dmy', 'a UK business reads 03/04 as 3 April');

  console.log('\n[3] helpers');
  const hUser = await mkUser('helper');
  const staff = (await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed, user_id, permissions)
    VALUES (${A.workspaceId}, 'Helper H', ${`crec-hs-${S}@example.com`}, TRUE, TRUE, ${hUser.id}, ${JSON.stringify({ schedule: true })}::jsonb) RETURNING id`).rows[0].id;
  const asA = { 'x-helper-workspace': A.workspaceId };
  r = await call(clientsHandler, { method: 'GET', userId: hUser.id, headers: asA });
  const seen = (r.body?.clients || []).find((x) => x.id === richId);
  assert(r.statusCode === 200 && seen, `schedule-only helper can list clients (${r.statusCode})`);
  assert(seen && NEW_FIELDS.every((k) => !(k in seen)) && !('address' in seen) && !('notes' in seen), 'but sees none of the sensitive fields');
  r = await call(clientById, { method: 'GET', userId: hUser.id, headers: asA, query: { id: richId } });
  assert(r.statusCode === 200 && NEW_FIELDS.every((k) => !(k in r.body.client)), 'nor on the single-client read');
  r = await call(fieldsHandler, { method: 'GET', userId: hUser.id, headers: asA });
  assert(r.statusCode === 403, `schedule-only helper cannot read the custom field list (${r.statusCode})`);
  r = await call(clientById, { method: 'PATCH', userId: hUser.id, headers: asA, query: { id: richId }, body: { birthday: '1990-01-01' } });
  assert(r.statusCode === 403, 'nor edit a birthday');
  await sql`UPDATE staff_members SET permissions = ${JSON.stringify({ schedule: true, clients: true })}::jsonb WHERE id = ${staff}`;
  // The helper's memberships are cached in-process; drop the entry like a
  // permission change from the owner's Staff page does.
  const { invalidate } = await import('../api/_lib/hotCache.js');
  invalidate(`helps:${hUser.id}`);
  r = await call(clientById, { method: 'GET', userId: hUser.id, headers: asA, query: { id: richId } });
  assert(r.statusCode === 200 && 'customFields' in r.body.client && r.body.client.customFields[sessions.id] === 12, 'a helper with the clients permission sees the full record');
  r = await call(fieldsHandler, { method: 'POST', userId: hUser.id, headers: asA, body: { label: 'Helper field', type: 'text' } });
  assert(r.statusCode === 403, `helpers cannot create custom fields, even with the clients permission (${r.statusCode})`);

  console.log('\n[4] import with details, statuses and new fields');
  let m = calls.length;
  r = await call(importHandler, { userId: A.userId, body: { quiet: true,
    newFields: [{ ref: 'col:9', label: 'Injuries', type: 'text' }, { ref: 'col:10', label: 'Training goals', type: 'text' }],
    rows: [
      { name: 'Imp One', email: `imp1-${S}@example.com`, stage: 'paused', birthday: '1985-12-01',
        addressParts: { street: '5 Elm', city: 'Boise', region: 'ID', postalCode: '83702', country: 'US' },
        emergencyContact: { name: 'Kim', phone: '208-555-0100', relationship: 'Mother' }, pronouns: 'he/him',
        customFields: { 'col:9': 'Bad back', 'col:10': 'Bench 100kg', [sessions.id]: '8' } },
      { name: 'Imp Two', phone: '208-555-0101', stage: 'lead', birthday: 'next Tuesday', customFields: { [sessions.id]: 'many' } },
      { name: 'Imp Three', phone: '208-555-0102', preferredContact: 'fax' },
    ] } });
  assert(r.statusCode === 200 && r.body.summary.created === 3, `import with details answers 200 (${r.statusCode} ${r.body?.error || ''})`);
  const imp = new Map((await sql`SELECT * FROM clients WHERE id = ANY(${r.body.importedIds}::uuid[])`).rows.map((x) => [x.name, x]));
  const defsA = (await call(fieldsHandler, { method: 'GET', userId: A.userId })).body.fields;
  const injuries = defsA.find((f) => f.label === 'Injuries');
  assert(injuries && defsA.filter((f) => f.label === 'Training goals').length === 1, 'a new field was created; an existing one with the same name was reused');
  const one = imp.get('Imp One');
  assert(one.stage === 'paused' && one.birth_year === 1985 && one.birth_month === 12 && one.address_city === 'Boise' && one.emergency_name === 'Kim' && one.pronouns === 'he/him', 'details and status stored');
  assert(one.custom_fields[injuries.id] === 'Bad back' && one.custom_fields[goals.id] === 'Bench 100kg' && one.custom_fields[sessions.id] === 8, 'custom values land in the right fields');
  const two = imp.get('Imp Two');
  assert(two.stage === 'lead' && two.birth_month === null && /Birthday as written: next Tuesday/.test(two.notes || '') && /Sessions left: many/.test(two.notes || ''), 'unreadable values are kept in notes, not lost');
  assert(/Preferred contact as written: fax/.test(imp.get('Imp Three').notes || ''), 'an unknown preferred contact is kept in notes');
  assert(calls.length === m, 'quiet import with details sent nothing');
  const cnt = async () => Number((await sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${A.workspaceId}`).rows[0].n);
  const before = await cnt();
  r = await call(importHandler, { userId: A.userId, body: { quiet: true,
    newFields: Array.from({ length: CUSTOM_FIELD_MAX }, (_, i) => ({ ref: `col:${i}`, label: `Col ${i}` })),
    rows: [{ name: 'Cap Test', phone: '208-555-0199' }] } });
  assert(r.statusCode === 400 && await cnt() === before, 'too many new fields: refused and nothing imported');
  r = await call(importHandler, { userId: B.userId, body: { quiet: true, rows: [{ name: 'B Imp', phone: '208-555-0177', customFields: { [sessions.id]: '3' } }] } });
  const bImp = (await sql`SELECT custom_fields FROM clients WHERE id = ${r.body.importedIds[0]}`).rows[0];
  assert(JSON.stringify(bImp.custom_fields) === '{}', "an import into B cannot write A's custom fields");

  console.log('\n[5] column detection, statuses and dates');
  const hdr = ['Client ID', 'First Name', 'Last Name', 'Email', 'Mobile', 'Client Status', 'DOB', 'Gender', 'Address Line 1', 'Address Line 2',
    'Suburb', 'State', 'Postcode', 'Country', 'Emergency Contact', 'Emergency Contact Phone', 'Relationship', 'Occupation', 'Goals', 'Created Date'];
  const det = detectColumns(hdr);
  const f = Object.fromEntries(det.map((x, i) => [hdr[i], x]));
  assert(f.Mobile === 'phone' && f['Emergency Contact Phone'] === 'emergencyPhone', `the emergency phone is not taken as the client's phone (${f.Mobile}/${f['Emergency Contact Phone']})`);
  assert(f['Client Status'] === 'stage' && f.DOB === 'birthday' && f.Gender === 'pronouns' && f['Emergency Contact'] === 'emergencyName' && f.Relationship === 'emergencyRelationship', 'status, DOB, gender, emergency contact detected');
  assert(f['Address Line 1'] === 'street' && f['Address Line 2'] === 'street2' && f.Suburb === 'city' && f.State === 'region' && f.Postcode === 'postalCode' && f.Country === 'country', 'address parts detected');
  assert(!f['Client ID'] && !f.Goals && !f['Created Date'], 'other columns are not guessed');
  for (const [h, want] of [['Membership Status', 'stage'], ['Member Status', 'stage'], ['Active', 'stage'], ['Date of Birth', 'birthday'], ['Birthdate', 'birthday'], ['Email Subscription Status', ''], ['Zip Code', 'postalCode'], ['Emergency Contact Name', 'emergencyName'], ['ICE Phone', 'emergencyPhone'], ['Year of birth', '']]) {
    const got = detectColumns(['Name', h])[1];
    assert(got === want, `"${h}" → ${want || 'nothing'} (${got || 'nothing'})`);
  }
  const keeps = defaultKeeps(hdr, det, [hdr.map((h) => `${h} value`)], [{ id: 'abc', label: 'goals' }]);
  assert(keeps[0] === '' && keeps[hdr.indexOf('Goals')] === `${CUSTOM_PREFIX}abc` && keeps[hdr.indexOf('Created Date')] === KEEP_NOTES, 'unmapped columns: ids left out, a same-name custom field matched, the rest kept in notes');
  const emptyKeeps = defaultKeeps(['Name', 'Empty'], ['name', ''], [['A', ''], ['B', '']]);
  assert(emptyKeeps[1] === '', 'an empty column is left out');
  for (const [v, st] of [['Active', 'active'], ['ACTIVE MEMBER', 'active'], ['Inactive', 'paused'], ['Paused', 'paused'], ['Former', 'paused'], ['Cancelled', 'paused'], ['Canceled', 'paused'], ['Archived', 'paused'], ['Expired', 'paused'], ['On Hold', 'paused'], ['Lead', 'lead'], ['Prospect', 'lead'], ['Free trial', 'lead'], ['Yes', 'active'], ['No', 'paused'], ['Inactive - moved away', 'paused'], ['VIP', null], ['', null]]) {
    assert(suggestStage(v) === st, `status "${v}" → ${st}`);
  }
  const now = new Date('2026-11-05T12:00:00Z');
  const pd = (v, o = 'mdy') => dateToApi(parseDateLoose(v, o, { now }));
  assert(pd('03/04/1990') === '1990-03-04' && pd('03/04/1990', 'dmy') === '1990-04-03', '03/04/1990 follows the business locale');
  assert(parseDateLoose('03/04/1990', 'mdy', { now }).ambiguous === true && parseDateLoose('13/04/1990', 'mdy', { now }).ambiguous === false, 'ambiguity is flagged');
  assert(pd('13/04/1990') === '1990-04-13' && pd('04/13/1990', 'dmy') === '1990-04-13', 'an unambiguous date ignores the order');
  assert(pd('1990-03-04') === '1990-03-04' && pd('1990-03-04T00:00:00Z') === '1990-03-04' && pd('1990/3/4') === '1990-03-04', 'ISO forms');
  assert(pd('March 4, 1990') === '1990-03-04' && pd('4 Mar 1990') === '1990-03-04' && pd('4-Mar-90') === '1990-03-04' && pd('Sun, March 4, 1990') === '1990-03-04', 'month names');
  assert(pd('3/4/88') === '1988-03-04' && pd('3/4/05') === '2005-03-04' && pd('3/4/30') === '1930-03-04', 'two-digit years');
  assert(pd('03/04') === '--03-04' && pd('Mar 4') === '--03-04', 'no year');
  assert(pd('02/30/1990') === '' && pd('1990-13-01') === '' && pd('ask her') === '' && pd('31.31.1990') === '' && pd('') === '', 'impossible or unreadable dates give nothing');
  assert(pd('29/02/2001', 'dmy') === '' && pd('29/02/2000', 'dmy') === '2000-02-29', 'leap years');
  const t0 = Date.now();
  parseDateLoose(`${'1'.repeat(30000)}/`, 'mdy'); parseDateLoose(`${'a '.repeat(20000)}`, 'mdy');
  assert(Date.now() - t0 < 200, 'hostile date strings are cheap');
  assert(parseBirthday('--02-29').day === 29 && (() => { try { parseBirthday('2001-02-29'); return false; } catch { return true; } })(), 'server birthday check knows leap years');

  console.log('\n[6] the 300-row trainer export, end to end');
  const csvText = fs.readFileSync(path.join(here, 'fixtures', 'trainer-export-300.csv'), 'utf8');
  const truth = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'trainer-export-300.expected.json'), 'utf8'));
  const C = await mkOwner('fixture');
  const parsed = parseClientCSV(csvText);
  assert(parsed.records.length === 300, `300 rows parsed (${parsed.records.length})`);
  let mapping = defaultKeeps(parsed.headers, parsed.mapping, parsed.records, []);
  const col = (h) => parsed.headers.indexOf(h);
  assert(mapping[col('Status')] === 'stage' && mapping[col('Date of Birth')] === 'birthday' && mapping[col('Mobile')] === 'phone', 'status, birthday and phone columns found');
  assert(mapping[col('Goals')] === KEEP_NOTES && mapping[col('Created Date')] === KEEP_NOTES && mapping[col('Client ID')] === '', 'Goals and Created Date default to notes, Client ID left out');
  mapping = mapping.slice();
  mapping[col('Goals')] = KEEP_NEW_FIELD; // the owner keeps Goals as a field
  const summary = statusSummary(parsed.records, mapping);
  const byLabel = Object.fromEntries(summary.map((s) => [s.label || '(blank)', s]));
  assert(byLabel.Inactive.count === 114 && byLabel.Inactive.suggested === 'paused', 'status table: Inactive (114) → Paused');
  assert(byLabel.Active.count === 110 && byLabel.Prospect.suggested === 'lead' && byLabel.Former.suggested === 'paused' && byLabel.VIP.suggested === null && byLabel['(blank)'].count === 6, 'and the rest of the statuses');
  assert(ambiguousDateCount(parsed.records, mapping) > 20, 'the file has dates that can be read two ways');
  const unknownStage = 'lead';
  const { rows, dropped } = buildClientRows(parsed.records, mapping, {
    stage: unknownStage, statusMap: defaultStatusMap(summary), dateOrder: 'mdy', headers: parsed.headers,
  });
  assert(dropped === 1 && rows.length === 299, `one row with no name is left out (${dropped})`);
  const newFields = newFieldsFor(parsed.headers, mapping);
  assert(newFields.length === 1 && newFields[0].label === 'Goals', 'Goals becomes a new custom field');
  m = calls.length;
  r = await call(importHandler, { userId: C.userId, body: { quiet: true, sendInvites: false, newFields, rows: rows.map(({ sourceIndex, ...x }) => x) } }); // eslint-disable-line no-unused-vars
  assert(r.statusCode === 200, `fixture import answers 200 (${r.statusCode} ${r.body?.error || ''})`);
  const sm = r.body.summary;
  assert(sm.created === 297 && sm.skipped === 2 && sm.invalid === 0, `297 added, 2 repeated emails skipped (${JSON.stringify(sm)})`);
  assert(calls.length === m, 'nothing was sent to 297 people');
  const goalsDef = (await call(fieldsHandler, { method: 'GET', userId: C.userId })).body.fields.find((x) => x.label === 'Goals');
  const db = (await sql`SELECT * FROM clients WHERE workspace_id = ${C.workspaceId}`).rows;
  const byEmail = new Map(db.filter((x) => x.email).map((x) => [x.email, x]));
  const byPhoneName = new Map(db.map((x) => [`${x.name}|${x.phone || ''}`, x]));
  const stageCounts = {};
  for (const x of db) stageCounts[x.stage] = (stageCounts[x.stage] || 0) + 1;
  let checked = 0; const bad = [];
  const norm = (p) => (p ? `+1${String(p).replace(/\D/g, '')}` : null);
  for (const t of truth) {
    if (!t.name || t.duplicateOf) continue;
    const row = t.email ? byEmail.get(t.email) : byPhoneName.get(`${t.name}|${norm(t.phone) || ''}`);
    if (!row) { bad.push(`row ${t.row}: missing`); continue; }
    checked++;
    const wantStage = t.stage || unknownStage;
    if (row.stage !== wantStage) bad.push(`row ${t.row}: stage ${row.stage} != ${wantStage} (${t.status})`);
    const gotB = row.birth_month ? (row.birth_year ? `${row.birth_year}-${String(row.birth_month).padStart(2, '0')}-${String(row.birth_day).padStart(2, '0')}` : `--${String(row.birth_month).padStart(2, '0')}-${String(row.birth_day).padStart(2, '0')}`) : null;
    if (t.birthday === 'unreadable') {
      if (gotB || !(row.notes || '').includes(`Birthday as written: ${t.birthdayWritten}`)) bad.push(`row ${t.row}: unreadable birthday not in notes`);
    } else if (gotB !== t.birthday) bad.push(`row ${t.row}: birthday ${gotB} != ${t.birthday} (${t.birthdayWritten})`);
    const addr = t.address;
    if (addr) {
      if (row.address_street !== addr.street || row.address_city !== addr.city || row.address_region !== addr.region || row.address_postal_code !== addr.postalCode || row.address_country !== addr.country) bad.push(`row ${t.row}: address`);
    } else if (row.address_street || row.address_city) bad.push(`row ${t.row}: unexpected address`);
    const em = t.emergency;
    if (em) {
      if (row.emergency_name !== em.name || row.emergency_phone !== em.phone || row.emergency_relationship !== em.relationship) bad.push(`row ${t.row}: emergency contact`);
    } else if (row.emergency_name) bad.push(`row ${t.row}: unexpected emergency contact`);
    if ((row.pronouns || null) !== t.pronouns) bad.push(`row ${t.row}: pronouns`);
    if ((row.occupation || null) !== t.occupation) bad.push(`row ${t.row}: occupation`);
    if ((row.custom_fields?.[goalsDef.id] || null) !== t.goals) bad.push(`row ${t.row}: goals`);
    if (t.notes && !(row.notes || '').startsWith(t.notes)) bad.push(`row ${t.row}: notes`);
    if (!(row.notes || '').includes(`Created Date: ${t.created}`)) bad.push(`row ${t.row}: Created Date not kept`);
    if ((row.notes || '').includes(t.clientId)) bad.push(`row ${t.row}: Client ID should be left out`);
    if (t.phone && row.phone !== norm(t.phone)) bad.push(`row ${t.row}: phone`);
  }
  assert(checked === 297 && bad.length === 0, `every field of all 297 clients matches the fixture (${checked} checked; ${bad.slice(0, 5).join('; ')})`);
  const wantActive = truth.filter((t) => t.name && !t.duplicateOf && t.stage === 'active').length;
  assert(stageCounts.active === wantActive && stageCounts.active < 297, `not everyone is Active: ${JSON.stringify(stageCounts)}`);

  console.log('\n[7] client portal profile and data export');
  const P = await mkUser('portal');
  const portalRow = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id, notes, custom_fields)
    VALUES (${A.workspaceId}, 'Portal Person', ${P.email}, 'active', ${P.id}, 'owner-only note', ${JSON.stringify({ [goals.id]: 'owner-only goal' })}::jsonb) RETURNING id`).rows[0].id;
  r = await call(profileHandler, { method: 'PATCH', userId: P.id, body: { birthday: '--05-06', emergencyContact: { name: 'Pat', phone: '555-0100', relationship: 'Friend' } } });
  assert(r.statusCode === 200 && r.body.profile.birthday === '--05-06' && r.body.profile.emergencyContact?.name === 'Pat', 'the client sets their own birthday and emergency contact');
  assert(!('notes' in r.body.profile) && !('customFields' in r.body.profile), 'their profile never shows the owner notes or custom fields');
  r = await call(profileHandler, { method: 'PATCH', userId: P.id, body: { birthday: '1990-02-31' } });
  assert(r.statusCode === 400, 'a bad birthday is refused there too');
  const ownerView = (await call(clientById, { method: 'GET', userId: A.userId, query: { id: portalRow } })).body.client;
  assert(ownerView.birthday === '--05-06' && ownerView.emergencyContact?.relationship === 'Friend', 'the owner sees what the client entered');
  r = await call(profileHandler, { method: 'PATCH', userId: P.id, body: { phone: '+14155550123' } });
  assert(r.body.profile.birthday === '--05-06', 'an old-app profile save (no birthday key) leaves the birthday alone');
  const ex = await buildClientPortalExport({ id: P.id, email: P.email });
  assert(ex.profile?.birthday === '--05-06' && ex.profile?.emergencyContact?.name === 'Pat', 'their data export includes their birthday and emergency contact');
  const exJson = JSON.stringify(ex);
  assert(!exJson.includes('owner-only note') && !exJson.includes('owner-only goal'), 'and never the owner notes or custom fields');
  assert(!exJson.includes('Rich Client') && !exJson.includes('Sam Rich'), "and nobody else's record");

  console.log('\n[8] Ivy tools');
  const props = (n) => IVY_TOOLS.find((t) => t.name === n)?.input_schema?.properties || {};
  assert(props('add_client').birthday && props('update_client').emergency_contact && props('import_clients_from_list').clients.items.properties.address, 'add_client, update_client and import_clients_from_list offer the new fields');
  const ivyCtx = { workspaceId: A.workspaceId, userId: A.userId };
  let out = await runApprovedTool('add_client', { name: 'Ivy Added', phone: '+14155550160', birthday: '1992-06-07', address: { city: 'Reno', region: 'NV' }, pronouns: 'they/them' }, ivyCtx);
  const ivyRow = (await sql`SELECT * FROM clients WHERE id = ${out.client?.id}`).rows[0] || {};
  assert(ivyRow.birth_year === 1992 && ivyRow.address_city === 'Reno' && ivyRow.pronouns === 'they/them', `add_client stores the details (${JSON.stringify(out).slice(0, 120)})`);
  out = await runApprovedTool('update_client', { client_id: ivyRow.id, emergency_contact: { name: 'Lee', phone: '555', relationship: 'Brother' }, occupation: 'Chef' }, ivyCtx);
  const ivyRow2 = (await sql`SELECT * FROM clients WHERE id = ${ivyRow.id}`).rows[0];
  assert(ivyRow2.emergency_name === 'Lee' && ivyRow2.occupation === 'Chef' && ivyRow2.birth_year === 1992, 'update_client stores them and leaves the rest');
  out = await runApprovedTool('update_client', { client_id: ivyRow.id, birthday: 'soon' }, ivyCtx);
  assert(!!out.error, 'update_client refuses a bad birthday');
  out = await runApprovedTool('import_clients_from_list', { clients: [{ name: 'Ivy Listed', phone: '+14155550161', birthday: '--09-10', emergency_contact: { name: 'Mo' } }] }, ivyCtx);
  const listed = (await sql`SELECT * FROM clients WHERE workspace_id = ${A.workspaceId} AND name = 'Ivy Listed'`).rows[0] || {};
  assert(out.added === 1 && listed.birth_month === 9 && listed.birth_year === null && listed.emergency_name === 'Mo', 'import_clients_from_list stores them');
  out = await runApprovedTool('update_client', { client_id: bClient.id, occupation: 'Thief' }, ivyCtx);
  assert(!!out.error, "Ivy in business A cannot touch business B's client");

  // Cleanup.
  for (const w of [A, B, C]) await sql`DELETE FROM workspaces WHERE id = ${w.workspaceId}`.catch(() => {});

  console.log(`\nclient-record: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
