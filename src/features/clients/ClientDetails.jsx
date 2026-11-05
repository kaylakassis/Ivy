// "Details" block in the client profile (ClientDrawer): address, birthday,
// gender or pronouns, emergency contact, preferred contact, work, how they
// found you, and the business's custom fields. Read view first; "Edit"
// opens the same fields as the Add client form. Kept out of ClientDrawer so
// the drawer only renders it.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { useClientFields } from './clientFields.js';
import { DetailsFields, draftFrom, detailsPatch, draftProblem, detailLines } from './ClientDetailsForm.jsx';
import CustomFieldsSettings from './CustomFieldsSettings.jsx';

export default function ClientDetails({ client, onSave }) {
  const { fields } = useClientFields();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(client));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => { if (!editing) setDraft(draftFrom(client)); }, [client, editing]);

  const lines = detailLines(client, fields);

  const save = async () => {
    const problem = draftProblem(draft);
    if (problem) { setErr(problem); return; }
    const patch = detailsPatch(draft, draftFrom(client), fields);
    if (!Object.keys(patch).length) { setEditing(false); return; }
    setBusy(true); setErr(null);
    try {
      await onSave(patch);
      setEditing(false);
    } catch (e) {
      setErr(e.message || 'Could not save. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div className="metric-label" style={{ flex: 1 }}>Details</div>
        {!editing && (
          <button type="button" className="btn btn-ghost" onClick={() => { setErr(null); setEditing(true); }}
            style={{ padding: '4px 8px', fontSize: 12.5 }}>
            <Icons.Edit size={12}/> {lines.length ? 'Edit' : 'Add details'}
          </button>
        )}
      </div>

      {!editing && (
        lines.length ? (
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            {lines.map((l, i) => (
              <div key={l.label + i} style={{
                display: 'grid', gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.6fr)', gap: 10,
                padding: '8px 12px', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 13,
              }}>
                <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{l.label}</span>
                <span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{l.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Address, birthday, emergency contact and your own fields. Only you see these.
          </div>
        )
      )}

      {editing && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <DetailsFields draft={draft} onChange={setDraft} fields={fields}/>
          {err && <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="button" className="btn btn-outline" onClick={() => { setEditing(false); setErr(null); }} disabled={busy}
              style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}
              style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save details'}</button>
          </div>
        </div>
      )}

      <button type="button" className="btn btn-ghost" onClick={() => setSettingsOpen(true)}
        style={{ padding: '6px 4px', fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        <Icons.Settings size={12}/> {fields.length ? 'Edit your custom fields' : 'Add your own fields (like goals or injuries)'}
      </button>
      {settingsOpen && <CustomFieldsSettings onClose={() => setSettingsOpen(false)}/>}
    </div>
  );
}
