// The import hub: every way an owner can bring their book over from another
// app, reached from Clients (Import), the dashboard "Switching from another
// app?" card, /clients?import=1, and the onboarding "Switching to Ivy?" step.
//
//   A file from another app       CSV / spreadsheet export (columns matched
//                                 automatically, src/lib/clientColumns.js),
//                                 also routes .vcf and .ics files
//   Phone contacts                .vcf or the browser contact picker
//   A screenshot or photo         hands off to Ivy with the photo menu open
//   Appointments, calendar file   .ics → review → bookings
//   Appointments, Google Calendar connected calendar → review → bookings
//
// Imports are QUIET: POST /api/clients/import with quiet: true, so no
// automations run and nobody is emailed, unless the owner ticks "Run my new
// client automations" (quiet: false). Portal invites are never sent from
// here. Afterwards the owner can send the "I've moved" email to the people
// they choose (AnnounceMoveSheet).
//
// Existing clients (same email, then same phone) are skipped by the server,
// never overwritten.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import {
  parseClientCSV, buildClientRows, fileKind, CSV_MAX_BYTES,
} from '../../lib/clientColumns.js';
import { parseVCards } from '../../lib/vcard.js';
import { openIvy } from '../ivy/openIvy.js';
import { SWITCH_SOURCE_BY_ID, screenshotPrompt } from '../onboarding/switchSources.js';
import { Sheet, Note, QuietNote, AutomationsOptIn, plural } from './import/parts.jsx';
import ContactsImport, { contactPickerSupported } from './import/ContactsImport.jsx';
import { IcsImport, GoogleImport, ICS_MAX_BYTES } from './import/AppointmentsImport.jsx';
import { AnnounceMove } from './AnnounceMoveSheet.jsx';

// Order matters - drives the dropdown options in the column editor.
const FIELD_OPTIONS = [
  { value: '',          label: 'Ignore this column' },
  { value: 'name',      label: 'Full name' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName',  label: 'Last name' },
  { value: 'nameLastFirst', label: 'Name (Last, First)' },
  { value: 'email',     label: 'Email' },
  { value: 'phone',     label: 'Phone' },
  { value: 'stage',     label: 'Stage' },
  { value: 'notes',     label: 'Notes' },
  { value: 'source',    label: 'Source' },
  { value: 'tags',      label: 'Tags (comma-separated)' },
];

const TITLES = {
  menu: 'Bring your clients over',
  file: 'A file from another app',
  csv: 'Check your columns',
  contacts: 'Phone contacts',
  ics: 'Appointments from a calendar file',
  google: 'Appointments from Google Calendar',
  done: 'All set',
  announce: 'Let your clients know',
};

// inWizard: opened from onboarding, where /clients is not reachable yet.
export default function ImportClientsModal({ onClose, onComplete, initialMode = 'menu', switchFrom, onScreenshot, inWizard = false }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState(initialMode);
  const [history, setHistory] = useState([]);
  const [parsed, setParsed] = useState(null);           // CSV { headers, mapping, records }
  const [vcfContacts, setVcfContacts] = useState(null); // from a .vcf picked in "A file"
  const [icsText, setIcsText] = useState(null);         // from an .ics picked in "A file"
  const [busy, setBusy] = useState(false);
  const [importErr, setImportErr] = useState(null);
  const [result, setResult] = useState(null);
  const [announceIds, setAnnounceIds] = useState(null);

  const go = (next) => { setHistory((h) => [...h, mode]); setMode(next); setImportErr(null); };
  const back = history.length ? () => {
    const h = history.slice();
    const prev = h.pop();
    setHistory(h); setMode(prev); setImportErr(null);
  } : null;

  const screenshot = () => {
    if (onScreenshot) { onScreenshot(); return; }
    onClose();
    openIvy({ prompt: screenshotPrompt(switchFrom), photo: true, navigate });
  };

  // One place that sends client rows, for CSV and contacts alike.
  const importClients = async (rows, { quiet, source }) => {
    setBusy(true); setImportErr(null);
    try {
      const clean = rows.map(({ sourceIndex, ...r }) => r); // eslint-disable-line no-unused-vars
      const r = await api.post('/clients/import', { rows: clean, quiet, sendInvites: false });
      const importedIds = Array.isArray(r.importedIds) ? r.importedIds
        : (r.inserted || []).map((c) => c.id).filter(Boolean);
      const done = {
        kind: 'clients',
        summary: r.summary || { created: 0, skipped: 0, invalid: 0 },
        errors: r.errors || [],
        importedIds,
        noEmail: clean.filter((x) => !x.email).length,
        quiet,
        source,
      };
      setResult(done);
      onComplete?.(done);
      go('done');
    } catch (e) {
      setImportErr(e.message || 'Import failed. Nothing was added.');
    } finally {
      setBusy(false);
    }
  };

  const bookingsDone = (r) => {
    setResult(r);
    onComplete?.(r);
    go('done');
  };

  const title = TITLES[mode] || TITLES.menu;
  const icon = mode === 'ics' || mode === 'google' ? 'Calendar' : mode === 'announce' ? 'Mail' : 'Users';

  return (
    <Sheet title={title} icon={icon} onClose={onClose} onBack={mode === 'done' ? null : back}>
      {mode === 'menu' && <Menu go={go} onScreenshot={screenshot}/>}

      {mode === 'file' && (
        <FileStep
          switchFrom={switchFrom}
          onScreenshot={screenshot}
          onCSV={(p) => { setParsed(p); go('csv'); }}
          onVCF={(list) => { setVcfContacts(list); go('contacts'); }}
          onICS={(t) => { setIcsText(t); go('ics'); }}/>
      )}

      {mode === 'csv' && parsed && (
        <CsvPreview parsed={parsed} busy={busy} error={importErr}
          onSubmit={(rows, opts) => importClients(rows, { ...opts, source: 'file' })}/>
      )}

      {mode === 'contacts' && (
        <ContactsImport initialContacts={vcfContacts} busy={busy} error={importErr}
          onSubmit={(rows, opts) => importClients(rows, { ...opts, source: 'contacts' })}/>
      )}

      {mode === 'ics' && <IcsImport initialText={icsText} onDone={bookingsDone}/>}
      {mode === 'google' && <GoogleImport onDone={bookingsDone}/>}

      {mode === 'done' && result && (
        <DoneStep result={result} onClose={onClose} inWizard={inWizard}
          onAnnounce={() => { setAnnounceIds(result.kind === 'clients' ? result.importedIds : null); go('announce'); }}
          onMore={() => { setHistory([]); setResult(null); setMode('menu'); }}/>
      )}

      {mode === 'announce' && <AnnounceMove clientIds={announceIds} onClose={onClose}/>}
    </Sheet>
  );
}

// ── Menu ─────────────────────────────────────────────────────────────

function Menu({ go, onScreenshot }) {
  const [google, setGoogle] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/calendar/google/status')
      .then((r) => live && setGoogle(r))
      .catch(() => live && setGoogle({ configured: false, connected: false }));
    return () => { live = false; };
  }, []);
  const picker = contactPickerSupported();

  const options = [
    { id: 'file', icon: 'Doc', title: 'A file from another app',
      sub: 'A CSV or spreadsheet file from Square, Acuity, Vagaro and others. Contacts files work too.' },
    { id: 'contacts', icon: 'Phone', title: 'Phone contacts',
      sub: picker ? 'Pick people from your contacts, or upload a contacts file.' : 'Upload a contacts file (.vcf) from your iPhone or iCloud.' },
    { id: 'photo', icon: 'Camera', title: 'A screenshot or photo',
      sub: 'Of your old app or a paper book. Ivy reads the names, you check them before anything is saved.' },
    { id: 'ics', icon: 'Calendar', title: 'Appointments from a calendar file',
      sub: 'A calendar file (.ics) from your old calendar or booking app.' },
  ];
  if (google && google.configured !== false) {
    options.push({ id: 'google', icon: 'Calendar', title: 'Appointments from Google Calendar',
      sub: google.connected ? 'Pick which upcoming events become bookings.' : 'Connect Google Calendar, then pick your appointments.' });
  }

  return (
    <>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Bring in what you have. It only takes a few minutes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {options.map((o) => {
          const I = Icons[o.icon] || Icons.Doc;
          return (
            <button key={o.id} type="button" onClick={() => (o.id === 'photo' ? onScreenshot() : go(o.id))}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', textAlign: 'left',
                borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--fg)', cursor: 'pointer', width: '100%',
              }}>
              <span style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}><I size={17} sw={1.8}/></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{o.title}</span>
                <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45, marginTop: 2 }}>{o.sub}</span>
              </span>
              <Icons.Arrow size={14} stroke="var(--muted)"/>
            </button>
          );
        })}
      </div>
      <QuietNote style={{ marginTop: 14 }}/>
    </>
  );
}

// ── File ─────────────────────────────────────────────────────────────

function FileStep({ switchFrom, onScreenshot, onCSV, onVCF, onICS }) {
  const fileRef = useRef(null);
  const [err, setErr] = useState(null);
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [reading, setReading] = useState(false);
  const source = SWITCH_SOURCE_BY_ID[switchFrom];
  const guide = source && source.guide?.length ? source : null;

  const ingestCSV = (text) => {
    const p = parseClientCSV(text);
    if (!p.records.length) throw new Error("We couldn't find any rows. The first row should be the column names.");
    onCSV(p);
  };

  const onFile = async (file) => {
    if (!file) return;
    setErr(null);
    const kind = fileKind(file);
    if (kind === 'excel') {
      setErr('That is an Excel or Numbers file. Open it and save it as CSV (File, Save As, CSV), then pick that file. Or send Ivy a screenshot.');
      return;
    }
    if (kind === 'zip') { setErr('That is a .zip file. Open it first, then pick the file inside.'); return; }
    if (kind === 'unknown') { setErr('Pick a CSV, contacts (.vcf) or calendar (.ics) file. For a photo or screenshot, send it to Ivy.'); return; }
    const cap = kind === 'ics' ? ICS_MAX_BYTES : CSV_MAX_BYTES;
    if (file.size > cap) { setErr(`That file is over ${Math.round(cap / 1024 / 1024)} MB. Try exporting a smaller list.`); return; }
    setReading(true);
    try {
      const text = await file.text();
      if (kind === 'vcf') {
        const r = parseVCards(text);
        if (r.error) throw new Error(r.error);
        if (!r.contacts.length) throw new Error("We couldn't find any contacts in that file.");
        onVCF(r.contacts);
      } else if (kind === 'ics') {
        if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 5000))) throw new Error("That doesn't look like a calendar file.");
        onICS(text);
      } else {
        ingestCSV(text);
      }
    } catch (e) {
      setErr(e.message || 'Could not read that file.');
    } finally { setReading(false); }
  };

  return (
    <>
      {guide ? (
        <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>From {guide.label}</div>
          {guide.guide.map((l) => <div key={l} style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>{l}</div>)}
        </div>
      ) : (
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Most apps can export your clients as a CSV or spreadsheet file: look for <strong>Export</strong> in your
          Clients or Customers list. Pick that file here and Ivy matches the columns for you.
        </p>
      )}

      <input ref={fileRef} type="file" hidden
        accept=".csv,.tsv,.txt,.vcf,.vcard,.ics,.xlsx,.xls,.numbers,text/csv,text/plain,text/vcard,text/calendar"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }}/>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
        className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '13px 18px' }}>
        <Icons.Doc size={15}/> {reading ? 'Reading…' : 'Choose file'}
      </button>
      <button type="button" onClick={onScreenshot} className="btn btn-outline"
        style={{ width: '100%', justifyContent: 'center', padding: '12px 18px', marginTop: 8 }}>
        <Icons.Camera size={15}/> Send Ivy a screenshot instead
      </button>

      {err && <Note tone="err" style={{ marginTop: 12 }}>{err}</Note>}

      <div style={{ marginTop: 16 }}>
        {!showPaste ? (
          <button type="button" className="btn btn-ghost" onClick={() => setShowPaste(true)}
            style={{ padding: '6px 4px', fontSize: 12.5, color: 'var(--muted)' }}>
            Or paste rows from a spreadsheet
          </button>
        ) : (
          <>
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} className="input"
              placeholder={'Name,Email,Phone\nMaya Rivera,maya@example.com,555 123 4567'}
              aria-label="Paste rows"
              style={{ width: '100%', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}/>
            <button type="button" className="btn btn-outline" disabled={!paste.trim()}
              onClick={() => { setErr(null); try { ingestCSV(paste); } catch (e) { setErr(e.message); } }}
              style={{ marginTop: 8, justifyContent: 'center' }}>
              Use these rows
            </button>
          </>
        )}
      </div>
    </>
  );
}

// ── CSV preview + column mapping ─────────────────────────────────────

function CsvPreview({ parsed, onSubmit, busy, error }) {
  const [mapping, setMapping] = useState(parsed.mapping);
  const [batchTags, setBatchTags] = useState('');
  const [defaultStage, setDefaultStage] = useState('active');
  const [runAutomations, setRunAutomations] = useState(false);
  const [showColumns, setShowColumns] = useState(() => !hasName(parsed.mapping));

  const tags = useMemo(() => batchTags.split(/[,;]/).map((t) => t.trim()).filter(Boolean).slice(0, 20), [batchTags]);
  const { rows, dropped } = useMemo(
    () => buildClientRows(parsed.records, mapping, { tags, stage: defaultStage }),
    [parsed.records, mapping, tags, defaultStage],
  );
  const claimed = useMemo(() => {
    const m = new Map();
    mapping.forEach((f, i) => { if (f) m.set(f, i); });
    return m;
  }, [mapping]);
  const named = hasName(mapping);
  const sample = rows.slice(0, 6);
  const matched = parsed.headers.map((h, i) => (mapping[i] ? h : null)).filter(Boolean);

  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Found <strong>{plural(parsed.records.length, 'row')}</strong>.
        {named
          ? <> Ivy matched {plural(matched.length, 'column')}. Here is how the first few look.</>
          : <> Tell Ivy which column has the names.</>}
      </p>

      {/* A stacked list (not a table) so it reads at 390px without
          sideways scrolling. */}
      <div style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: 260 }}>
        {sample.map((r, i) => (
          <div key={i} style={{ padding: '8px 12px', borderTop: i ? '1px solid var(--border)' : 'none', minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[r.email || 'No email', r.phone || 'No phone'].join('  ·  ')}
              {r.notes ? `  ·  ${r.notes}` : ''}
            </div>
          </div>
        ))}
        {sample.length === 0 && (
          <div style={{ padding: 14, fontSize: 12.5, textAlign: 'center', color: 'var(--muted)' }}>
            No names yet. Pick the name column below.
          </div>
        )}
        {rows.length > sample.length && (
          <div style={{ padding: '6px 10px', fontSize: 11.5, color: 'var(--muted)', textAlign: 'center' }}>
            +{rows.length - sample.length} more
          </div>
        )}
      </div>
      {dropped > 0 && named && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
          {plural(dropped, 'row')} with no name will be left out.
        </div>
      )}

      <button type="button" className="btn btn-ghost" onClick={() => setShowColumns((v) => !v)}
        style={{ padding: '6px 4px', fontSize: 12.5, color: 'var(--accent)', marginBottom: 8 }}>
        {showColumns ? 'Hide columns' : 'Something wrong? Fix the columns'}
      </button>

      {showColumns && (
        <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', padding: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '6px 10px', alignItems: 'center' }}>
            {parsed.headers.map((h, i) => (
              <React.Fragment key={i}>
                <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h}>
                  {h || <em style={{ color: 'var(--muted)' }}>(blank)</em>}
                </div>
                <select value={mapping[i] || ''} aria-label={`Column ${h}`}
                  onChange={(e) => { const next = mapping.slice(); next[i] = e.target.value; setMapping(next); }}
                  style={{ padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--fg)', fontSize: 13, minWidth: 0 }}>
                  {FIELD_OPTIONS.map((opt) => {
                    const used = opt.value && claimed.has(opt.value) && claimed.get(opt.value) !== i;
                    return <option key={opt.value} value={opt.value} disabled={used}>{opt.label}{used ? ' (used)' : ''}</option>;
                  })}
                </select>
              </React.Fragment>
            ))}
          </div>
          <div className="form-2col" style={{ marginTop: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Tag everyone</div>
              <input className="input" value={batchTags} onChange={(e) => setBatchTags(e.target.value)}
                placeholder="e.g. from-square" style={{ width: '100%', fontSize: 14 }}/>
            </label>
            <label style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Add them as</div>
              <select value={defaultStage} onChange={(e) => setDefaultStage(e.target.value)}
                style={{ width: '100%', padding: '8px', borderRadius: 7, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--fg)', fontSize: 14 }}>
                <option value="active">Active clients</option>
                <option value="lead">Leads</option>
                <option value="paused">Paused</option>
              </select>
            </label>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        <AutomationsOptIn checked={runAutomations} onChange={setRunAutomations}/>
        {!runAutomations && <QuietNote/>}
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          People already in Ivy (same email or phone) are skipped, never overwritten, so trying again is safe.
        </div>
      </div>

      {error && <Note tone="err" style={{ marginBottom: 12 }}>{error}</Note>}

      <button type="button" onClick={() => onSubmit(rows, { quiet: !runAutomations })}
        disabled={busy || !named || rows.length === 0} className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', padding: '12px 14px', opacity: (busy || !named || rows.length === 0) ? 0.6 : 1 }}>
        {busy ? 'Adding…' : !named ? 'Pick the name column to continue' : `Add ${plural(rows.length, 'client')}`}
      </button>
    </>
  );
}

function hasName(mapping) {
  return mapping.includes('name') || mapping.includes('firstName') || mapping.includes('lastName') || mapping.includes('nameLastFirst');
}

// ── Done ─────────────────────────────────────────────────────────────

function csvCell(value) {
  const s = value == null ? '' : String(value);
  // Neutralise spreadsheet formulas in the download (=, +, -, @ at the start).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  if (/[",\r\n]/.test(safe)) return '"' + safe.replace(/"/g, '""') + '"';
  return safe;
}

function downloadErrors(errors) {
  const lines = [['Row', 'Problem'].join(',')];
  for (const e of errors) lines.push([csvCell(e.row), csvCell(e.error)].join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `client-import-problems-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DoneStep({ result, onClose, onAnnounce, onMore, inWizard }) {
  const navigate = useNavigate();
  const isClients = result.kind === 'clients';
  const created = isClients ? (result.summary.created || 0) : (result.created || 0);
  const skipped = isClients ? (result.summary.skipped || 0) : (result.skipped || 0);
  const invalid = isClients ? (result.summary.invalid || 0) : 0;
  const missingEmail = isClients ? result.noEmail : (result.missingEmail || []).length;
  const canAnnounce = isClients ? (result.importedIds || []).length > 0 : created > 0;
  const errors = isClients ? result.errors || [] : [];

  const goMissing = () => { onClose(); navigate('/clients?filter=missing-email'); };

  return (
    <>
      <div style={{
        width: 52, height: 52, borderRadius: 99, margin: '4px auto 12px',
        background: 'var(--ok)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Check size={26} sw={2.4}/></div>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <h3 className="page-title" style={{ margin: 0, fontSize: 22 }}>
          {created
            ? (isClients ? `${plural(created, 'client')} added` : `${plural(created, 'appointment')} added`)
            : 'Nothing new to add'}
        </h3>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          {skipped > 0 && <>{skipped} already in Ivy, skipped. </>}
          {invalid > 0 && <>{invalid} could not be added. </>}
          {result.quiet === false ? 'Your new client automations are running for them.' : 'Nobody was emailed.'}
        </p>
      </div>

      {missingEmail > 0 && inWizard && (
        <Note tone="warn" style={{ marginBottom: 10 }}>
          <strong>{plural(missingEmail, 'person', 'people')} {missingEmail === 1 ? 'has' : 'have'} no email</strong>, so they will not get
          reminders. Once you finish setup, Clients shows a Missing email list.
        </Note>
      )}
      {missingEmail > 0 && !inWizard && (
        <button type="button" onClick={goMissing} style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
          padding: '10px 12px', borderRadius: 10, marginBottom: 10, cursor: 'pointer', color: 'var(--fg)',
          border: '1px solid color-mix(in srgb, var(--warn) 35%, var(--border))',
          background: 'color-mix(in srgb, var(--warn) 8%, var(--surface))',
        }}>
          <Icons.Mail size={16} stroke="var(--warn)"/>
          <span style={{ flex: 1, fontSize: 13, lineHeight: 1.45 }}>
            <strong>{plural(missingEmail, 'person', 'people')} {missingEmail === 1 ? 'has' : 'have'} no email</strong>, so they will not get reminders. Add their emails.
          </span>
          <Icons.Arrow size={13} stroke="var(--muted)"/>
        </button>
      )}

      {errors.length > 0 && (
        <details style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', marginBottom: 10, fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{plural(errors.length, 'row')} could not be added</summary>
          <ul style={{ margin: '8px 0 0 18px', padding: 0, color: 'var(--fg-2)' }}>
            {errors.slice(0, 20).map((e, i) => <li key={i} style={{ margin: '2px 0' }}>Row {String(e.row)}: {String(e.error)}</li>)}
          </ul>
          <button type="button" className="btn btn-ghost" onClick={() => downloadErrors(errors)}
            style={{ padding: '6px 4px', fontSize: 12, marginTop: 6 }}>
            <Icons.ArrowDown size={12} sw={2}/> Download the list
          </button>
        </details>
      )}

      {canAnnounce && (
        <div style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid var(--border)', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Let your clients know you moved</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 10px', lineHeight: 1.5 }}>
            A short, ready-to-send email with your new booking link. You choose who gets it.
          </div>
          <button type="button" className="btn btn-outline" onClick={onAnnounce} style={{ width: '100%', justifyContent: 'center' }}>
            <Icons.Mail size={14}/> Write the email
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-outline" onClick={onMore} style={{ flex: 1, justifyContent: 'center' }}>
          Bring in more
        </button>
        <button type="button" className="btn btn-primary" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>
          Done
        </button>
      </div>
    </>
  );
}

