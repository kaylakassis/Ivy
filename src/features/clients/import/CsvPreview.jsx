// CSV preview for the import hub: how the first rows will look, the status
// mapping ("Inactive (114) → Paused"), how dates like 03/04/1990 are read,
// and where every other column goes (notes, a custom field, or left out),
// so nothing is dropped without the owner seeing it.
//
// Status: Ivy has three stages. Active and Lead map straight across;
// inactive, paused, former, cancelled, archived and the like go to Paused.
// When the file has a status column, nobody is added as Active just because
// of the default: each value is mapped, and only blank or unknown values
// follow the owner's "anything else" choice.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../../components/Icons.jsx';
import {
  buildClientRows, statusSummary, defaultStatusMap, defaultKeeps, newFieldsFor, ambiguousDateCount,
  parseDateLoose, dateToApi, birthdayLabel, KEEP_NOTES, KEEP_NEW_FIELD, CUSTOM_PREFIX,
} from '../../../lib/clientColumns.js';
import { useClientFields } from '../clientFields.js';
import { Note, QuietNote, AutomationsOptIn, plural } from './parts.jsx';

const STAGE_LABELS = { active: 'Active', lead: 'Lead', paused: 'Paused' };
const STAGE_SHORT = { active: 'Active', lead: 'Lead', paused: 'Paused' };

// Order matters - drives the dropdown options in the column editor.
const FIELD_OPTIONS = [
  { value: '',          label: 'Leave out' },
  { value: 'name',      label: 'Full name' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName',  label: 'Last name' },
  { value: 'nameLastFirst', label: 'Name (Last, First)' },
  { value: 'email',     label: 'Email' },
  { value: 'phone',     label: 'Phone' },
  { value: 'stage',     label: 'Status' },
  { value: 'notes',     label: 'Notes' },
  { value: 'birthday',  label: 'Birthday' },
  { value: 'street',    label: 'Street address' },
  { value: 'street2',   label: 'Address line 2' },
  { value: 'city',      label: 'City' },
  { value: 'region',    label: 'State or region' },
  { value: 'postalCode', label: 'Postal code' },
  { value: 'country',   label: 'Country' },
  { value: 'pronouns',  label: 'Gender or pronouns' },
  { value: 'emergencyName', label: 'Emergency contact name' },
  { value: 'emergencyPhone', label: 'Emergency contact phone' },
  { value: 'emergencyRelationship', label: 'Emergency contact relationship' },
  { value: 'occupation', label: 'Company or occupation' },
  { value: 'preferredContact', label: 'Best way to reach them' },
  { value: 'source',    label: 'How they found you' },
  { value: 'tags',      label: 'Tags (comma-separated)' },
  { value: KEEP_NOTES,  label: 'Add to their notes' },
  { value: KEEP_NEW_FIELD, label: 'Keep as a new custom field' },
];
const MULTI = new Set(['', KEEP_NOTES, KEEP_NEW_FIELD]);

const selS = {
  padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border-strong)', background: 'var(--surface)',
  color: 'var(--fg)', fontSize: 13, minWidth: 0, width: '100%',
};
const cardS = { marginBottom: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12 };
const headS = { fontSize: 13.5, fontWeight: 600, marginBottom: 4 };
const subS = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 10 };

export function hasName(mapping) {
  return mapping.includes('name') || mapping.includes('firstName') || mapping.includes('lastName') || mapping.includes('nameLastFirst');
}

export default function CsvPreview({ parsed, onSubmit, busy, error }) {
  const { fields, max, dateOrder: bizOrder, loading: fieldsLoading } = useClientFields();
  const [mapping, setMapping] = useState(() => defaultKeeps(parsed.headers, parsed.mapping, parsed.records, fields));
  const touched = useRef(false);
  // Custom fields arrive after the first render: match columns to them once.
  useEffect(() => {
    if (!fieldsLoading && !touched.current && fields.length) {
      setMapping(defaultKeeps(parsed.headers, parsed.mapping, parsed.records, fields));
    }
  }, [fieldsLoading, fields, parsed]);
  const setCol = (i, v) => { touched.current = true; setMapping((m) => { const n = m.slice(); n[i] = v; return n; }); };

  const [batchTags, setBatchTags] = useState('');
  const [defaultStage, setDefaultStage] = useState('active');
  const [unknownStage, setUnknownStage] = useState('lead');
  const [tagOldStatus, setTagOldStatus] = useState(false);
  const [order, setOrder] = useState(null);
  const dateOrder = order || bizOrder || 'mdy';
  const [runAutomations, setRunAutomations] = useState(false);
  const [showColumns, setShowColumns] = useState(() => !hasName(parsed.mapping));

  const statusCol = mapping.indexOf('stage');
  const summary = useMemo(() => statusSummary(parsed.records, mapping), [parsed.records, mapping]);
  const [statusMap, setStatusMap] = useState(() => defaultStatusMap(statusSummary(parsed.records, parsed.mapping)));
  // A newly picked status column gets its own suggestions.
  const lastStatusCol = useRef(statusCol);
  useEffect(() => {
    if (lastStatusCol.current !== statusCol) {
      lastStatusCol.current = statusCol;
      setStatusMap(defaultStatusMap(summary));
    }
  }, [statusCol, summary]);
  // With a status column, blank and unknown values follow `unknownStage`;
  // without one, everyone gets `defaultStage`.
  const effectiveMap = useMemo(() => {
    const m = {};
    for (const s of summary) m[s.key] = s.key ? (statusMap[s.key] || unknownStage) : unknownStage;
    return m;
  }, [summary, statusMap, unknownStage]);

  const tags = useMemo(() => batchTags.split(/[,;]/).map((t) => t.trim()).filter(Boolean).slice(0, 20), [batchTags]);
  const { rows, dropped } = useMemo(
    () => buildClientRows(parsed.records, mapping, {
      tags, stage: statusCol === -1 ? defaultStage : unknownStage,
      statusMap: statusCol === -1 ? null : effectiveMap,
      tagOldStatus: statusCol !== -1 && tagOldStatus, dateOrder, headers: parsed.headers,
    }),
    [parsed.records, parsed.headers, mapping, tags, defaultStage, unknownStage, effectiveMap, statusCol, tagOldStatus, dateOrder],
  );
  const claimed = useMemo(() => {
    const m = new Map();
    mapping.forEach((f, i) => { if (f && !MULTI.has(f)) m.set(f, i); });
    return m;
  }, [mapping]);
  const named = hasName(mapping);
  const sample = rows.slice(0, 6);

  const bdayCol = mapping.indexOf('birthday');
  const ambiguous = useMemo(() => ambiguousDateCount(parsed.records, mapping), [parsed.records, mapping]);
  const ambExample = useMemo(() => {
    if (bdayCol === -1) return null;
    const cell = parsed.records.map((r) => r[bdayCol]).find((v) => parseDateLoose(v, 'mdy')?.ambiguous);
    return cell || null;
  }, [parsed.records, bdayCol]);
  const unreadableDates = useMemo(() => {
    if (bdayCol === -1) return 0;
    return parsed.records.filter((r) => String(r[bdayCol] || '').trim() && !parseDateLoose(r[bdayCol], dateOrder)).length;
  }, [parsed.records, bdayCol, dateOrder]);

  const newFields = useMemo(() => newFieldsFor(parsed.headers, mapping), [parsed.headers, mapping]);
  const overCap = fields.length + newFields.filter((f) => !fields.some((d) => d.label.toLowerCase() === f.label.toLowerCase())).length > max;

  // Columns not mapped to a built-in field: where each one goes.
  const others = parsed.headers.map((h, i) => ({ h, i, m: mapping[i] || '' }))
    .filter((c) => c.m === '' || c.m === KEEP_NOTES || c.m === KEEP_NEW_FIELD || c.m.startsWith(CUSTOM_PREFIX));

  const canSubmit = !busy && named && rows.length > 0 && !overCap;

  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Found <strong>{plural(parsed.records.length, 'row')}</strong>.
        {named ? <> Here is how the first few look.</> : <> Tell Ivy which column has the names.</>}
      </p>

      {/* A stacked list (not a table) so it reads at 390px without
          sideways scrolling. */}
      <div style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: 300 }}>
        {sample.map((r, i) => (
          <div key={i} style={{ padding: '8px 12px', borderTop: i ? '1px solid var(--border)' : 'none', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{r.name}</span>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, flexShrink: 0,
                background: r.stage === 'active' ? 'color-mix(in srgb, var(--ok) 14%, transparent)' : 'var(--surface-2)',
                color: r.stage === 'active' ? 'var(--ok)' : 'var(--fg-2)', border: '1px solid var(--border)',
              }}>{STAGE_SHORT[r.stage]}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[r.email || 'No email', r.phone || 'No phone'].join('  ·  ')}
            </div>
            {(r.birthday || r.addressParts || r.emergencyContact) && (
              <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[
                  r.birthday ? `Birthday ${birthdayLabel(r.birthday) || `"${r.birthday}" (kept in notes)`}` : '',
                  r.addressParts ? [r.addressParts.city, r.addressParts.region].filter(Boolean).join(', ') || r.addressParts.street : '',
                  r.emergencyContact?.name ? `Emergency: ${r.emergencyContact.name}` : '',
                ].filter(Boolean).join('  ·  ')}
              </div>
            )}
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

      {/* Status mapping */}
      {statusCol !== -1 ? (
        <div style={cardS} data-testid="status-map">
          <div style={headS}>Status</div>
          <div style={subS}>
            From the <strong>{parsed.headers[statusCol] || 'status'}</strong> column. Check where each one goes. Paused is for inactive, former and cancelled clients.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', gap: '6px 8px', alignItems: 'center' }}>
            {summary.map((s) => (
              <React.Fragment key={s.key || '(blank)'}>
                <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.label}>
                  {s.key ? s.label : <em style={{ color: 'var(--muted)' }}>Blank</em>} <span style={{ color: 'var(--muted)' }}>({s.count})</span>
                </div>
                <Icons.Arrow size={12} stroke="var(--muted)"/>
                {s.key ? (
                  <select value={statusMap[s.key] || ''} aria-label={`Status ${s.label}`} style={selS}
                    onChange={(e) => setStatusMap((m) => ({ ...m, [s.key]: e.target.value || undefined }))}>
                    <option value="">Like anything else ({STAGE_SHORT[unknownStage]})</option>
                    {['active', 'lead', 'paused'].map((st) => <option key={st} value={st}>{STAGE_LABELS[st]}</option>)}
                  </select>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{STAGE_LABELS[unknownStage]}</div>
                )}
              </React.Fragment>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <span style={{ flexShrink: 0 }}>Blank or anything else:</span>
            <select value={unknownStage} onChange={(e) => setUnknownStage(e.target.value)} aria-label="Blank or unknown status" style={{ ...selS, width: 'auto', flex: 1 }}>
              {['active', 'lead', 'paused'].map((st) => <option key={st} value={st}>{STAGE_LABELS[st]}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, fontSize: 12.5, color: 'var(--fg-2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={tagOldStatus} onChange={(e) => setTagOldStatus(e.target.checked)} style={{ marginTop: 2 }}/>
            <span>Also tag each person with their old status (like "Former"), so you can still tell them apart.</span>
          </label>
        </div>
      ) : (
        <div style={cardS}>
          <div style={headS}>No status column</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <span style={{ flexShrink: 0 }}>Add everyone as:</span>
            <select value={defaultStage} onChange={(e) => setDefaultStage(e.target.value)} aria-label="Add everyone as" style={{ ...selS, width: 'auto', flex: 1 }}>
              {['active', 'lead', 'paused'].map((st) => <option key={st} value={st}>{STAGE_LABELS[st]}</option>)}
            </select>
          </label>
          <div style={{ ...subS, marginTop: 8, marginBottom: 0 }}>If a column says who is active, set it to Status under "Fix the columns".</div>
        </div>
      )}

      {/* Dates like 03/04/1990 */}
      {bdayCol !== -1 && (ambiguous > 0 || unreadableDates > 0) && (
        <div style={cardS} data-testid="date-order">
          <div style={headS}>Birthdays</div>
          {ambiguous > 0 && (
            <>
              <div style={subS}>
                {plural(ambiguous, 'birthday')} like <strong>{ambExample}</strong> could be read two ways. In this file, dates are written:
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[['mdy', 'Month first'], ['dmy', 'Day first']].map(([id, label]) => {
                  const on = dateOrder === id;
                  const ex = ambExample ? birthdayLabel(dateToApi(parseDateLoose(ambExample, id))) : '';
                  return (
                    <button key={id} type="button" onClick={() => setOrder(id)} aria-pressed={on} style={{
                      padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
                      border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                      background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent)' : 'var(--fg-2)',
                    }}>{label}{ex ? ` (${ex})` : ''}</button>
                  );
                })}
              </div>
            </>
          )}
          {unreadableDates > 0 && (
            <div style={{ ...subS, marginTop: ambiguous ? 8 : 0, marginBottom: 0 }}>
              {plural(unreadableDates, 'birthday')} could not be read as a date. They are kept in those clients' notes as written.
            </div>
          )}
        </div>
      )}

      {/* Every other column */}
      {others.length > 0 && named && (
        <div style={cardS} data-testid="other-columns">
          <div style={headS}>Other columns</div>
          <div style={subS}>Ivy keeps these so nothing is lost. Choose where each one goes.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', gap: '6px 10px', alignItems: 'center' }}>
            {others.map(({ h, i, m }) => (
              <React.Fragment key={i}>
                <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h}>
                  {h || <em style={{ color: 'var(--muted)' }}>(no name)</em>}
                </div>
                <select value={m} aria-label={`Column ${h}`} onChange={(e) => setCol(i, e.target.value)} style={selS}>
                  <option value={KEEP_NOTES}>Add to their notes</option>
                  <option value={KEEP_NEW_FIELD}>Keep as a custom field</option>
                  {fields.map((f) => {
                    const used = mapping.some((x, j) => x === CUSTOM_PREFIX + f.id && j !== i);
                    return <option key={f.id} value={CUSTOM_PREFIX + f.id} disabled={used}>Put in "{f.label}"{used ? ' (used)' : ''}</option>;
                  })}
                  <option value="">Leave out</option>
                </select>
              </React.Fragment>
            ))}
          </div>
          {newFields.length > 0 && (
            <div style={{ ...subS, marginTop: 8, marginBottom: 0 }}>
              New custom {newFields.length === 1 ? 'field' : 'fields'}: {newFields.map((f) => f.label).join(', ')}.
              They show on each client's profile.
            </div>
          )}
          {overCap && <Note tone="err" style={{ marginTop: 8 }}>A business can have up to {max} custom fields. Add some of these to notes instead.</Note>}
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
                <select value={mapping[i] || ''} aria-label={`Field for ${h}`} onChange={(e) => setCol(i, e.target.value)} style={selS}>
                  {FIELD_OPTIONS.map((opt) => {
                    const used = !MULTI.has(opt.value) && claimed.has(opt.value) && claimed.get(opt.value) !== i;
                    return <option key={opt.value || 'none'} value={opt.value} disabled={used}>{opt.label}{used ? ' (used)' : ''}</option>;
                  })}
                  {fields.map((f) => {
                    const v = CUSTOM_PREFIX + f.id;
                    const used = claimed.has(v) && claimed.get(v) !== i;
                    return <option key={f.id} value={v} disabled={used}>Custom: {f.label}{used ? ' (used)' : ''}</option>;
                  })}
                </select>
              </React.Fragment>
            ))}
          </div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-2)', marginTop: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>Tag everyone</div>
            <input className="input" value={batchTags} onChange={(e) => setBatchTags(e.target.value)}
              placeholder="e.g. from-ptminder" style={{ width: '100%', fontSize: 14 }}/>
          </label>
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

      <button type="button" onClick={() => onSubmit(rows, { quiet: !runAutomations, newFields })}
        disabled={!canSubmit} className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', padding: '12px 14px', opacity: canSubmit ? 1 : 0.6 }}>
        {busy ? 'Adding…' : !named ? 'Pick the name column to continue' : `Add ${plural(rows.length, 'client')}`}
      </button>
    </>
  );
}
