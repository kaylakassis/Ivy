// Bulk-import clients from a CSV. Three steps:
//   1. Upload / paste CSV → parse + auto-detect headers
//   2. Preview the first 10 rows + show field mapping → confirm
//   3. POST to /api/clients/import → show summary
//
// Parser handles:
//   • Quoted fields with embedded commas
//   • Doubled quotes ("") as escaped quote
//   • CRLF or LF line endings
//   • A header row (case-insensitive match against name/email/stage/notes/source)
//
// Existing clients (matched by email) are SKIPPED — never silently overwritten.
import React, { useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const FIELD_ALIASES = {
  name:   ['name', 'full name', 'client name', 'client', 'first name', 'firstname'],
  email:  ['email', 'email address', 'e-mail'],
  stage:  ['stage', 'status'],
  notes:  ['notes', 'note', 'description'],
  source: ['source', 'how they found you', 'lead source'],
};

const VALID_STAGES = new Set(['lead', 'active', 'paused']);

// Parses a CSV string into { headers, rows } where rows are objects with
// header-keyed values. Tolerates the quirks listed at the top of the file.
function parseCSV(input) {
  const text = String(input || '').replace(/^﻿/, '');  // strip BOM
  if (!text.trim()) return { headers: [], rows: [] };

  const records = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); field = '';
        if (cur.some((v) => v !== '')) records.push(cur);
        cur = [];
      } else field += c;
    }
  }
  // flush last field/record
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    if (cur.some((v) => v !== '')) records.push(cur);
  }
  if (records.length === 0) return { headers: [], rows: [] };

  // First non-empty record is treated as the header row — map raw headers
  // to canonical field names via FIELD_ALIASES.
  const rawHeaders = records[0].map((h) => h.trim());
  const mapped = rawHeaders.map((h) => {
    const lower = h.toLowerCase();
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.includes(lower)) return field;
    }
    return null; // unknown column — ignored on import
  });

  const rows = records.slice(1).map((cells) => {
    const obj = {};
    mapped.forEach((field, idx) => {
      if (!field) return;
      const v = (cells[idx] || '').trim();
      if (v) obj[field] = v;
    });
    return obj;
  }).filter((o) => Object.keys(o).length > 0);

  return { headers: rawHeaders, mapped, rows };
}

export default function ImportClientsModal({ onClose, onComplete }) {
  const [stage, setStage] = useState('upload'); // 'upload' | 'preview' | 'done'
  const [parsed, setParsed] = useState({ headers: [], mapped: [], rows: [] });
  const [pasteText, setPasteText] = useState('');
  const [parseErr, setParseErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [importErr, setImportErr] = useState(null);
  const fileRef = useRef(null);

  const onFile = async (file) => {
    if (!file) return;
    setParseErr(null);
    try {
      const text = await file.text();
      const data = parseCSV(text);
      if (!data.rows.length) throw new Error('No data rows found.');
      setParsed(data);
      setStage('preview');
    } catch (e) {
      setParseErr(e.message || 'Could not read that file.');
    }
  };

  const onPaste = () => {
    setParseErr(null);
    try {
      const data = parseCSV(pasteText);
      if (!data.rows.length) throw new Error('No data rows found.');
      setParsed(data);
      setStage('preview');
    } catch (e) {
      setParseErr(e.message || 'Could not parse that.');
    }
  };

  const submit = async () => {
    setBusy(true); setImportErr(null);
    try {
      const r = await api.post('/clients/import', { rows: parsed.rows });
      setResult(r);
      setStage('done');
    } catch (e) {
      setImportErr(e.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    onComplete?.(result);
    onClose();
  };

  return (
    <div onClick={onClose} role="dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 640, padding: 24, maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Users size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Import clients from CSV</h3>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {stage === 'upload' && (
          <UploadStep
            fileRef={fileRef}
            onFile={onFile}
            pasteText={pasteText}
            setPasteText={setPasteText}
            onPaste={onPaste}
            error={parseErr}
          />
        )}

        {stage === 'preview' && (
          <PreviewStep parsed={parsed}
            onBack={() => setStage('upload')}
            onSubmit={submit}
            busy={busy}
            error={importErr}/>
        )}

        {stage === 'done' && result && (
          <DoneStep result={result} onClose={finish}/>
        )}
      </div>
    </div>
  );
}

function UploadStep({ fileRef, onFile, pasteText, setPasteText, onPaste, error }) {
  return (
    <>
      <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Pick a <strong>CSV file</strong> (or paste rows below). The first row must be
        column headers. We'll match these names automatically:
        <code style={{ marginLeft: 4, fontSize: 12, color: 'var(--accent)' }}>
          name, email, stage, notes, source
        </code>.
      </p>

      <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])}
        style={{ display: 'none' }}/>
      <button onClick={() => fileRef.current?.click()}
        className="btn btn-outline" style={{ width: '100%', justifyContent: 'center', padding: '14px 20px' }}>
        <Icons.Plus size={14} sw={2}/> Choose CSV file
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0', color: 'var(--muted)', fontSize: 11 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
        OR
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
      </div>

      <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6}
        placeholder={'name,email,stage\nAlice Doe,alice@example.com,active\nBob Smith,bob@example.com,lead'}
        style={{
          width: '100%', padding: 12, borderRadius: 10,
          border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
          color: 'var(--fg)', fontSize: 12, fontFamily: 'monospace',
          outline: 'none', resize: 'vertical',
        }}/>
      <button onClick={onPaste} disabled={!pasteText.trim()}
        className="btn btn-primary" style={{ marginTop: 8, justifyContent: 'center' }}>
        Parse pasted CSV
      </button>

      {error && (
        <div style={{
          marginTop: 14, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{error}</div>
      )}
    </>
  );
}

function PreviewStep({ parsed, onBack, onSubmit, busy, error }) {
  const recognized = useMemo(() =>
    parsed.headers.map((h, i) => ({ raw: h, mapped: parsed.mapped?.[i] })),
    [parsed],
  );
  const recognizedCount = recognized.filter((c) => c.mapped).length;
  const sample = parsed.rows.slice(0, 8);

  return (
    <>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Found <strong>{parsed.rows.length}</strong> rows.{' '}
        {recognizedCount}/{recognized.length} columns matched. Anything unmatched
        will be ignored — we only import name / email / stage / notes / source.
      </p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {recognized.map((c, i) => (
          <span key={i} style={{
            padding: '3px 8px', borderRadius: 99, fontSize: 11,
            background: c.mapped ? 'var(--accent-soft)' : 'var(--surface-2)',
            color: c.mapped ? 'var(--accent)' : 'var(--muted)',
            border: '1px solid ' + (c.mapped ? 'var(--accent)' : 'var(--border)'),
            fontWeight: 600,
          }}>
            {c.raw} {c.mapped && <>→ {c.mapped}</>}
          </span>
        ))}
      </div>

      <div className="table-scroll" style={{
        marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: 280,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Stage</th>
              <th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {sample.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{i + 1}</td>
                <td style={td}>{r.name || <span style={{ color: 'var(--danger)' }}>missing</span>}</td>
                <td style={td}>{r.email || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td style={td}>{VALID_STAGES.has(r.stage) ? r.stage : 'lead'}</td>
                <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.notes || ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {parsed.rows.length > sample.length && (
          <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
            +{parsed.rows.length - sample.length} more rows
          </div>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.55 }}>
        Existing clients with the same email will be <strong>skipped</strong> — they won't be overwritten.
      </div>

      {error && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }}>
          Back
        </button>
        <button onClick={onSubmit} disabled={busy}
          className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Importing…' : `Import ${parsed.rows.length} client${parsed.rows.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </>
  );
}

function DoneStep({ result, onClose }) {
  const { summary, errors } = result;
  return (
    <>
      <div style={{
        width: 56, height: 56, borderRadius: 99, alignSelf: 'center',
        background: 'var(--ok)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '4px auto 16px',
      }}>
        <Icons.Check size={28} sw={2.4}/>
      </div>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <h3 className="page-title" style={{ margin: 0, fontSize: 22 }}>Imported</h3>
        <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--fg-2)' }}>
          {summary.created} created · {summary.skipped} skipped (duplicates) ·{' '}
          {summary.invalid} invalid
        </p>
      </div>

      {errors.length > 0 && (
        <details style={{
          padding: 10, borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          marginBottom: 14, fontSize: 12,
        }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {errors.length} error{errors.length === 1 ? '' : 's'} · click to expand
          </summary>
          <ul style={{ margin: '8px 0 0 18px', padding: 0, color: 'var(--fg-2)' }}>
            {errors.map((e, i) => (
              <li key={i} style={{ margin: '2px 0' }}>Row {e.row}: {e.error}</li>
            ))}
          </ul>
        </details>
      )}

      <button onClick={onClose} className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', padding: '12px 14px' }}>
        Open my clients
      </button>
    </>
  );
}

const th = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' };
const td = { padding: '8px 10px', verticalAlign: 'top', color: 'var(--fg-2)' };
