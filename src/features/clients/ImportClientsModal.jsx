// Bulk-import clients from a CSV. Three steps:
//   1. Upload / paste CSV → parse + auto-detect headers
//   2. Preview, fix any wrong column mappings, set batch-wide tags / default stage
//   3. POST to /api/clients/import → summary + downloadable error CSV
//
// Parser handles:
//   • Quoted fields with embedded commas
//   • Doubled quotes ("") as escaped quote
//   • CRLF or LF line endings
//   • A header row (case-insensitive match against name/email/stage/notes/source/tags)
//
// Existing clients (matched by email) are SKIPPED - never silently overwritten.
import React, { useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const FIELD_ALIASES = {
  name:   ['name', 'full name', 'client name', 'client', 'first name', 'firstname'],
  email:  ['email', 'email address', 'e-mail'],
  stage:  ['stage', 'status'],
  notes:  ['notes', 'note', 'description'],
  source: ['source', 'how they found you', 'lead source', 'referral'],
  tags:   ['tags', 'tag', 'labels'],
};

// Order matters - drives the dropdown options in Preview.
const FIELD_OPTIONS = [
  { value: '',       label: 'Ignore this column' },
  { value: 'name',   label: 'Name' },
  { value: 'email',  label: 'Email' },
  { value: 'stage',  label: 'Stage' },
  { value: 'notes',  label: 'Notes' },
  { value: 'source', label: 'Source' },
  { value: 'tags',   label: 'Tags (comma-separated)' },
];

const VALID_STAGES = new Set(['lead', 'active', 'paused']);

// Parses a CSV string into { headers, mapping, records } - records are still
// raw cell arrays so we can re-apply mapping when the user fixes a column.
// Tolerates the quirks listed at the top of the file.
function parseCSV(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');  // strip BOM
  if (!text.trim()) return { headers: [], mapping: [], records: [] };

  const allRecords = [];
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
        if (cur.some((v) => v !== '')) allRecords.push(cur);
        cur = [];
      } else field += c;
    }
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    if (cur.some((v) => v !== '')) allRecords.push(cur);
  }
  if (allRecords.length === 0) return { headers: [], mapping: [], records: [] };

  // First non-empty record is the header row.
  const rawHeaders = allRecords[0].map((h) => h.trim());
  const mapping = rawHeaders.map((h) => {
    const lower = h.toLowerCase();
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.includes(lower)) return field;
    }
    return ''; // unknown column - user can override in Preview
  });

  const records = allRecords.slice(1).map((cells) =>
    cells.map((c) => (c || '').trim()),
  );
  return { headers: rawHeaders, mapping, records };
}

// Apply a mapping (raw-header-index → canonical field) + batch defaults to
// the raw records. Returns the row objects we actually POST to the server.
function buildRows(records, mapping, defaults) {
  const { tags: defaultTags, stage: defaultStage } = defaults;
  return records.map((cells) => {
    const obj = {};
    mapping.forEach((field, idx) => {
      if (!field) return;
      const v = cells[idx] || '';
      if (!v) return;
      if (field === 'tags') {
        const parts = v.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
        if (parts.length) obj.tags = [...(obj.tags || []), ...parts];
      } else {
        obj[field] = v;
      }
    });
    if (defaultTags.length) obj.tags = Array.from(new Set([...(obj.tags || []), ...defaultTags]));
    if (defaultStage && !obj.stage) obj.stage = defaultStage;
    return obj;
  }).filter((o) => o.name); // drop totally-empty / nameless rows
}

export default function ImportClientsModal({ onClose, onComplete }) {
  const [stage, setStage] = useState('upload'); // 'upload' | 'preview' | 'done'
  const [parsed, setParsed] = useState({ headers: [], mapping: [], records: [] });
  const [mapping, setMapping] = useState([]); // editable copy of parsed.mapping
  const [batchTags, setBatchTags] = useState('');
  const [defaultStage, setDefaultStage] = useState('lead');
  const [pasteText, setPasteText] = useState('');
  const [parseErr, setParseErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [importErr, setImportErr] = useState(null);
  const fileRef = useRef(null);

  const tagsParsed = useMemo(
    () => batchTags.split(/[,;]/).map((t) => t.trim()).filter(Boolean).slice(0, 20),
    [batchTags],
  );

  const rows = useMemo(
    () => buildRows(parsed.records, mapping, { tags: tagsParsed, stage: defaultStage }),
    [parsed.records, mapping, tagsParsed, defaultStage],
  );

  const ingestParsed = (data) => {
    if (!data.records.length) throw new Error('No data rows found.');
    setParsed(data);
    setMapping(data.mapping);
    setStage('preview');
  };

  const onFile = async (file) => {
    if (!file) return;
    setParseErr(null);
    try {
      const text = await file.text();
      ingestParsed(parseCSV(text));
    } catch (e) {
      setParseErr(e.message || 'Could not read that file.');
    }
  };

  const onPaste = () => {
    setParseErr(null);
    try {
      ingestParsed(parseCSV(pasteText));
    } catch (e) {
      setParseErr(e.message || 'Could not parse that.');
    }
  };

  const submit = async () => {
    setBusy(true); setImportErr(null);
    try {
      const r = await api.post('/clients/import', { rows });
      setResult({ ...r, sourceRecords: parsed.records, sourceHeaders: parsed.headers });
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
          <PreviewStep
            parsed={parsed}
            mapping={mapping}
            setMapping={setMapping}
            batchTags={batchTags}
            setBatchTags={setBatchTags}
            defaultStage={defaultStage}
            setDefaultStage={setDefaultStage}
            rows={rows}
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

function PreviewStep({
  parsed, mapping, setMapping,
  batchTags, setBatchTags,
  defaultStage, setDefaultStage,
  rows, onBack, onSubmit, busy, error,
}) {
  const setMappingAt = (idx, value) => {
    const next = mapping.slice();
    next[idx] = value;
    setMapping(next);
  };

  // Each canonical field can only map to one column. Disable the other
  // selects' option once a column claims it.
  const claimed = useMemo(() => {
    const m = new Map();
    mapping.forEach((field, idx) => { if (field) m.set(field, idx); });
    return m;
  }, [mapping]);

  const nameMapped = mapping.includes('name');
  const sample = rows.slice(0, 8);

  return (
    <>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Found <strong>{parsed.records.length}</strong> rows.
        Match each column to a field - anything left as "Ignore" won't be imported.
      </p>

      {/* Per-column mapping editor */}
      <div style={{
        marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10,
        background: 'var(--surface-2)', padding: 10,
      }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 8 }}>
          Column mapping
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '6px 10px', alignItems: 'center' }}>
          {parsed.headers.map((h, i) => (
            <React.Fragment key={i}>
              <div style={{ fontSize: 12.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h || <em style={{ color: 'var(--muted)' }}>(blank header)</em>}
              </div>
              <Icons.Arrow size={12} sw={2} style={{ color: 'var(--muted)' }}/>
              <select
                value={mapping[i] || ''}
                onChange={(e) => setMappingAt(i, e.target.value)}
                style={{
                  padding: '5px 8px', borderRadius: 7,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--surface)', color: 'var(--fg)',
                  fontSize: 12, fontFamily: 'inherit',
                }}
              >
                {FIELD_OPTIONS.map((opt) => {
                  const isClaimed = opt.value && claimed.has(opt.value) && claimed.get(opt.value) !== i;
                  return (
                    <option key={opt.value} value={opt.value} disabled={isClaimed}>
                      {opt.label}{isClaimed ? ' (used)' : ''}
                    </option>
                  );
                })}
              </select>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Batch defaults */}
      <div style={{
        marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10,
        background: 'var(--surface-2)', padding: 10,
      }} className="form-2col">
        <label style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
          <div style={{ marginBottom: 4, fontWeight: 600 }}>Tag everyone in this batch</div>
          <input
            value={batchTags}
            onChange={(e) => setBatchTags(e.target.value)}
            placeholder="e.g. spring-2026, referral"
            style={{
              width: '100%', padding: '6px 8px', borderRadius: 7,
              border: '1px solid var(--border-strong)',
              background: 'var(--surface)', color: 'var(--fg)', fontSize: 12.5,
            }}
          />
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>Comma-separated. Optional.</div>
        </label>
        <label style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
          <div style={{ marginBottom: 4, fontWeight: 600 }}>Default stage</div>
          <select
            value={defaultStage}
            onChange={(e) => setDefaultStage(e.target.value)}
            style={{
              width: '100%', padding: '6px 8px', borderRadius: 7,
              border: '1px solid var(--border-strong)',
              background: 'var(--surface)', color: 'var(--fg)', fontSize: 12.5,
            }}
          >
            <option value="lead">Lead</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>Used only when a row has no Stage column.</div>
        </label>
      </div>

      {/* Live preview of resolved rows */}
      <div className="table-scroll" style={{
        marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: 260,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Stage</th>
              <th style={th}>Tags</th>
            </tr>
          </thead>
          <tbody>
            {sample.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{i + 1}</td>
                <td style={td}>{r.name || <span style={{ color: 'var(--danger)' }}>missing</span>}</td>
                <td style={td}>{r.email || <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                <td style={td}>{VALID_STAGES.has(r.stage) ? r.stage : defaultStage}</td>
                <td style={{ ...td, maxWidth: 220 }}>
                  {(r.tags || []).join(', ') || <span style={{ color: 'var(--muted)' }}>-</span>}
                </td>
              </tr>
            ))}
            {sample.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--muted)' }}>
                No rows match the current mapping. Make sure a column is mapped to <strong>Name</strong>.
              </td></tr>
            )}
          </tbody>
        </table>
        {rows.length > sample.length && (
          <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
            +{rows.length - sample.length} more rows
          </div>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.55 }}>
        Existing clients with the same email will be <strong>skipped</strong> - they won't be overwritten,
        so re-importing the same file is safe.
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
        <button onClick={onSubmit} disabled={busy || !nameMapped || rows.length === 0}
          className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', opacity: (busy || !nameMapped || rows.length === 0) ? 0.6 : 1 }}>
          {busy ? 'Importing…'
            : !nameMapped ? 'Map a Name column to continue'
            : `Import ${rows.length} client${rows.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </>
  );
}

// Quote a single CSV cell - wraps in quotes if it contains comma, quote, or
// newline; doubles internal quotes per RFC 4180.
function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildErrorCSV(errors, sourceHeaders, sourceRecords) {
  const headers = [...sourceHeaders, 'Import error'];
  const lines = [headers.map(csvCell).join(',')];
  for (const err of errors) {
    const idx = (err.row || 1) - 1;
    const cells = sourceRecords[idx] || [];
    const padded = sourceHeaders.map((_, i) => cells[i] || '');
    lines.push([...padded, err.error].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

function downloadCSV(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DoneStep({ result, onClose }) {
  const { summary, errors, sourceHeaders = [], sourceRecords = [] } = result;
  const hasErrors = errors.length > 0;
  const stamp = new Date().toISOString().slice(0, 10);

  const onDownloadErrors = () => {
    const csv = buildErrorCSV(errors, sourceHeaders, sourceRecords);
    downloadCSV(`client-import-errors-${stamp}.csv`, csv);
  };

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
          <strong>{summary.created}</strong> created
          {summary.skipped > 0 && <> · {summary.skipped} already in your list (skipped)</>}
          {summary.invalid > 0 && <> · {summary.invalid} couldn't be imported</>}
        </p>
      </div>

      {summary.skipped > 0 && summary.invalid === 0 && (
        <div style={{
          marginBottom: 14, padding: '10px 12px', borderRadius: 8,
          background: 'var(--accent-soft)', border: '1px solid var(--accent)',
          color: 'var(--fg-2)', fontSize: 12.5, lineHeight: 1.5,
        }}>
          The {summary.skipped} skipped row{summary.skipped === 1 ? '' : 's'} matched
          existing client emails. Re-importing the same file later is safe - duplicates
          are never overwritten.
        </div>
      )}

      {hasErrors && (
        <>
          <details style={{
            padding: 10, borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            marginBottom: 10, fontSize: 12,
          }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              {errors.length} row{errors.length === 1 ? '' : 's'} couldn't be imported · click to expand
            </summary>
            <ul style={{ margin: '8px 0 0 18px', padding: 0, color: 'var(--fg-2)' }}>
              {errors.slice(0, 20).map((e, i) => (
                <li key={i} style={{ margin: '2px 0' }}>Row {e.row}: {e.error}</li>
              ))}
              {errors.length > 20 && (
                <li style={{ margin: '6px 0', color: 'var(--muted)', listStyle: 'none' }}>
                  …and {errors.length - 20} more - download the CSV to see them all.
                </li>
              )}
            </ul>
          </details>
          <button onClick={onDownloadErrors} className="btn btn-outline"
            style={{ width: '100%', justifyContent: 'center', marginBottom: 14 }}>
            <Icons.ArrowDown size={13} sw={2}/> Download {errors.length} failed
            row{errors.length === 1 ? '' : 's'} as CSV
          </button>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, marginTop: -6, lineHeight: 1.5 }}>
            Open in your spreadsheet, fix the values in the last column, delete that
            column, then re-upload. Already-imported rows will be skipped automatically.
          </div>
        </>
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
