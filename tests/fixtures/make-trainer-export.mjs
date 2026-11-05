// Builds tests/fixtures/trainer-export-300.csv: a 300-row client export in
// the style of a personal-training app (PTminder / FutureForm style column
// names; not a copy of either app's real file), plus the truth for every
// row in trainer-export-300.expected.json, so tests can check that each
// field and status landed where it should.
//
// Mixed statuses (Active, Inactive, Paused, Prospect, Lead, Former,
// Cancelled, Archived, blank, and an unknown "VIP"), birthdays in several
// formats (US month-first, ISO, "March 4, 1985", no year, unreadable),
// US addresses, emergency contacts, a "Goals" column, blank fields, two
// repeated emails and one row with no name. Deterministic (seeded).
//
//   node tests/fixtures/make-trainer-export.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let seed = 20261105;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Emma', 'Ethan', 'Zoe', 'Lucas', 'Chloe', 'Mason', 'Isla', 'Leo', 'Ruby', 'Owen', 'Nora', 'Jack', 'Lily', 'Eli', 'Grace', 'Kai', 'Hazel', 'Theo', 'Ivy', 'Finn', 'Sofia', 'Jude', 'Aria', 'Miles', 'Layla', 'Ezra'];
const LAST = ['Nguyen', 'Garcia', 'Smith', "O'Brien", 'Patel', 'Kim', 'Johnson', 'Lopez', 'Brown', 'Davis', 'Martinez', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Clark', 'Lewis', 'Walker', 'Young', 'Hall'];
const CITIES = [['Austin', 'TX', '787'], ['Denver', 'CO', '802'], ['Portland', 'OR', '972'], ['Raleigh', 'NC', '276'], ['Tampa', 'FL', '336'], ['Boise', 'ID', '837']];
const STREETS = ['Oak St', 'Maple Ave', 'Cedar Ln', 'Pine Rd', 'Elm Dr', 'Lakeview Blvd'];
const GOALS = ['Lose 10 lb before the wedding', 'Run a half marathon', 'Build strength after knee surgery', 'Get back into shape, 3x a week', 'Deadlift 1.5x bodyweight', 'Improve posture, desk job'];
const RELS = ['Partner', 'Mother', 'Father', 'Sister', 'Brother', 'Friend', 'Spouse'];
const GENDERS = ['Female', 'Male', 'Non-binary', 'she/her', 'he/him', ''];
const JOBS = ['Teacher', 'Nurse', 'Software engineer', 'Accountant', 'Barista', '', '', 'Acme Corp'];

// Status → count. Truth stage for each.
const STATUS_PLAN = [
  ['Active', 110, 'active'], ['Inactive', 114, 'paused'], ['Paused', 12, 'paused'], ['Prospect', 20, 'lead'],
  ['Lead', 10, 'lead'], ['Former', 10, 'paused'], ['Cancelled', 8, 'paused'], ['Archived', 6, 'paused'],
  ['', 6, null], ['VIP', 4, null],
];
const statuses = STATUS_PLAN.flatMap(([label, n, stage]) => Array.from({ length: n }, () => ({ label, stage })));
// Shuffle so statuses are mixed through the file.
for (let i = statuses.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [statuses[i], statuses[j]] = [statuses[j], statuses[i]]; }

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const headers = ['Client ID', 'First Name', 'Last Name', 'Email', 'Mobile', 'Status', 'Date of Birth', 'Gender',
  'Address 1', 'Suburb', 'State', 'Postcode', 'Country', 'Emergency Contact Name', 'Emergency Contact Phone',
  'Emergency Contact Relationship', 'Occupation', 'Goals', 'Notes', 'Created Date'];
const csv = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const lines = [headers.map(csv).join(',')];
const expected = [];
for (let i = 0; i < 300; i++) {
  const first = FIRST[i % FIRST.length];
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
  let email = `${first}.${last}.${i}@example.com`.toLowerCase().replace(/'/g, '');
  const phone = i % 9 === 4 ? '' : `(512) 555-${String(1000 + i).slice(-4)}`;
  if (i % 23 === 7) email = '';                       // phone-only clients
  const st = statuses[i];
  // Birthday truth + how it is written.
  const y = 1955 + Math.floor(rnd() * 50); const m = 1 + Math.floor(rnd() * 12); const d = 1 + Math.floor(rnd() * 28);
  let dob; let bday;
  switch (i % 10) {
    case 0: dob = ''; bday = null; break;                                     // blank
    case 1: dob = `${y}-${pad(m)}-${pad(d)}`; bday = `${y}-${pad(m)}-${pad(d)}`; break; // ISO
    case 2: dob = `${MONTHS[m - 1]} ${d}, ${y}`; bday = `${y}-${pad(m)}-${pad(d)}`; break;
    case 3: dob = `${pad(m)}/${pad(d)}`; bday = `--${pad(m)}-${pad(d)}`; break; // no year
    case 9: dob = i % 20 === 9 ? 'ask her' : `${m}/${d}/${String(y).slice(2)}`; bday = i % 20 === 9 ? 'unreadable' : `${y}-${pad(m)}-${pad(d)}`; break;
    default: dob = `${pad(m)}/${pad(d)}/${y}`; bday = `${y}-${pad(m)}-${pad(d)}`; // US, often ambiguous
  }
  const [city, state, zip3] = pick(CITIES);
  const hasAddr = i % 6 !== 5;
  const street = hasAddr ? `${100 + i} ${pick(STREETS)}` : '';
  const postcode = hasAddr ? `${zip3}${pad(i % 100)}` : '';
  const hasEm = i % 4 !== 3;
  const emName = hasEm ? `${pick(FIRST)} ${last}` : '';
  const emPhone = hasEm ? `512-555-${String(5000 + i).slice(-4)}` : '';
  const emRel = hasEm ? pick(RELS) : '';
  const gender = GENDERS[i % GENDERS.length];
  const job = JOBS[i % JOBS.length];
  const goals = i % 3 === 2 ? '' : GOALS[i % GOALS.length];
  const notes = i % 5 === 0 ? 'Prefers mornings. Bad left shoulder, no overhead press.' : '';
  const created = `2023-${pad(1 + (i % 12))}-${pad(1 + (i % 27))}`;
  let firstOut = first; let lastOut = last;
  if (i === 150) { firstOut = ''; lastOut = ''; }      // no name: left out
  const row = [`PT${10000 + i}`, firstOut, lastOut, email, phone, st.label, dob, gender,
    street, hasAddr ? city : '', hasAddr ? state : '', postcode, hasAddr ? 'United States' : '',
    emName, emPhone, emRel, job, goals, notes, created];
  lines.push(row.map(csv).join(','));
  expected.push({
    row: i + 1, name: i === 150 ? null : `${first} ${last}`, email: email || null, phone: phone || null,
    status: st.label, stage: st.stage, birthday: bday, birthdayWritten: dob,
    address: hasAddr ? { street, city, region: state, postalCode: postcode, country: 'United States' } : null,
    emergency: hasEm ? { name: emName, phone: emPhone, relationship: emRel } : null,
    pronouns: gender || null, occupation: job || null, goals: goals || null, notes: notes || null, clientId: `PT${10000 + i}`, created,
  });
}
// Two people repeated later in the file with the same email (skipped as
// duplicates): rows 299 and 300 copy rows 11 and 12's emails.
for (const [dst, src] of [[298, 10], [299, 11]]) {
  if (!expected[src].email) continue;
  const cells = lines[dst + 1].split(',');
  // Email is column 4; this row's cells hold no commas before it.
  cells[3] = expected[src].email;
  lines[dst + 1] = cells.join(',');
  expected[dst].email = expected[src].email;
  expected[dst].duplicateOf = src + 1;
}

fs.writeFileSync(path.join(dir, 'trainer-export-300.csv'), lines.join('\r\n') + '\r\n');
fs.writeFileSync(path.join(dir, 'trainer-export-300.expected.json'), JSON.stringify(expected, null, 1) + '\n');
console.log('wrote', lines.length - 1, 'rows');
