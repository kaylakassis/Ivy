// Right-side drawer for editing one client.
// Inline-editable: name, email, lifetime value. Stage, tags, notes also editable.
// Shows a "Saved" / error banner after each save so failures aren't silent.
import React, { useState, useEffect, useRef } from 'react';
import { Icons } from '../../components/Icons.jsx';

export default function ClientDrawer({ client, onClose, onUpdate, onDelete }) {
  const initials = (client.name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  const [confirmDel, setConfirmDel] = useState(false);
  const [busyDel, setBusyDel] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // { kind: 'ok' | 'error', text }
  const statusTimer = useRef(null);

  // Wrap onUpdate so we always show a status indicator for saves.
  const safeUpdate = async (patch) => {
    clearTimeout(statusTimer.current);
    setSaveStatus({ kind: 'pending', text: 'Saving…' });
    try {
      await onUpdate(patch);
      setSaveStatus({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setSaveStatus({ kind: 'error', text: e.message || 'Save failed — try again' });
    } finally {
      statusTimer.current = setTimeout(() => setSaveStatus(null), 2400);
    }
  };

  useEffect(() => () => clearTimeout(statusTimer.current), []);

  const stageButton = (s) => ({
    flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 550,
    textTransform: 'capitalize', cursor: 'pointer',
    border: '1px solid ' + (client.stage === s ? 'var(--accent)' : 'var(--border)'),
    background: client.stage === s ? 'var(--accent-soft)' : 'var(--surface)',
    color: client.stage === s ? 'var(--accent)' : 'var(--fg-2)',
  });

  const handleDelete = async () => {
    setBusyDel(true);
    try {
      await onDelete();
      // Parent closes the drawer on successful delete.
    } catch (e) {
      setBusyDel(false);
      setSaveStatus({ kind: 'error', text: e.message || 'Delete failed — try again' });
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 560, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header — name + email inline-editable */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 99, flexShrink: 0,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 600,
          }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <InlineText
              value={client.name || ''}
              onSave={(v) => safeUpdate({ name: v.trim() || client.name })}
              placeholder="Name"
              style={{ fontSize: 18, fontWeight: 600 }}
              editStyle={{ fontSize: 18, fontWeight: 600 }}
              required
            />
            <InlineText
              value={client.email || ''}
              onSave={(v) => safeUpdate({ email: v.trim() || null })}
              placeholder="Add email"
              style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}
              editStyle={{ fontSize: 13 }}
              type="email"
            />
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {/* Status banner */}
        {saveStatus && (
          <div style={{
            padding: '8px 24px', fontSize: 12.5, fontWeight: 500,
            background: saveStatus.kind === 'error'
              ? 'rgba(155,44,44,0.10)'
              : saveStatus.kind === 'ok'
                ? 'color-mix(in srgb, var(--ok) 12%, transparent)'
                : 'var(--surface-2)',
            color: saveStatus.kind === 'error' ? 'var(--danger)'
                  : saveStatus.kind === 'ok' ? 'var(--ok)'
                  : 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {saveStatus.kind === 'ok'   && <Icons.Check size={13} sw={2.4}/>}
            {saveStatus.kind === 'error' && <Icons.X size={13} sw={2.4}/>}
            {saveStatus.text}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Stage */}
          <div>
            <Section label="Stage"/>
            <div style={{ display: 'flex', gap: 6 }}>
              {['active', 'lead', 'paused'].map((s) => (
                <button key={s} onClick={() => safeUpdate({ stage: s })} style={stageButton(s)}>{s}</button>
              ))}
            </div>
          </div>

          {/* KPIs — lifetime value editable, others read-only */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <EditableMoneyStat
              label="Lifetime"
              value={client.lifetimeValue || 0}
              onSave={(v) => safeUpdate({ lifetimeValue: v })}
            />
            <MiniStat label="Since"     value={client.joinedAt ? new Date(client.joinedAt).toLocaleDateString([], { month: 'short', year: '2-digit' }) : '—'}/>
            <MiniStat label="Last seen" value={client.lastSeenAt ? Math.round((Date.now() - new Date(client.lastSeenAt).getTime()) / 86400e3) + 'd ago' : '—'}/>
          </div>

          {/* Tags */}
          <Tags client={client} onSave={safeUpdate}/>

          {/* Notes */}
          <Notes client={client} onSave={safeUpdate}/>
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>Permanently delete this client?</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)} disabled={busyDel}>Cancel</button>
              <button className="btn btn-primary" style={{ background: 'var(--danger)', color: 'white', opacity: busyDel ? 0.6 : 1 }}
                disabled={busyDel} onClick={handleDelete}>
                {busyDel ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}
                style={{ color: 'var(--danger)', padding: '8px 12px' }}>
                <Icons.Trash size={13}/>Delete
              </button>
              <div style={{ flex: 1 }}/>
              <button className="btn btn-outline" disabled style={{ opacity: 0.5 }}>
                <Icons.Chat size={13}/>Message
              </button>
              <button className="btn btn-outline" disabled style={{ opacity: 0.5 }}>
                <Icons.Dollar size={13}/>Invoice
              </button>
              <button className="btn btn-primary" disabled style={{ opacity: 0.5 }}>
                <Icons.Calendar size={13}/>Book
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ label }) {
  return <div className="metric-label" style={{ marginBottom: 8 }}>{label}</div>;
}

function MiniStat({ label, value }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="metric-label" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono-num" style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function EditableMoneyStat({ label, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value || 0)); }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n);
    setEditing(false);
  };

  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: editing ? 'var(--surface)' : 'var(--surface-2)',
      border: editing ? '1px solid var(--accent)' : '1px solid var(--border)',
      cursor: 'text',
    }} onClick={() => !editing && setEditing(true)}>
      <div className="metric-label" style={{ fontSize: 10 }}>{label}</div>
      {editing ? (
        <input
          type="number" min={0} step={1}
          autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') { setDraft(String(value || 0)); setEditing(false); }
          }}
          style={{
            width: '100%', marginTop: 3,
            border: 0, outline: 'none',
            background: 'transparent', color: 'var(--fg)',
            fontSize: 14, fontWeight: 600,
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      ) : (
        <div className="mono-num" style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>
          {value > 0 ? '$' + Number(value).toLocaleString() : '—'}
        </div>
      )}
    </div>
  );
}

// Inline-editable text. Click to edit; Enter or blur saves; Esc cancels.
function InlineText({ value, onSave, placeholder, style, editStyle, required, type = 'text' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => {
    const v = (draft || '').trim();
    if (required && !v) { setDraft(value); setEditing(false); return; }
    if (v !== (value || '')) onSave(v);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type={type}
        autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        placeholder={placeholder}
        style={{
          width: '100%',
          border: 0, outline: 'none',
          background: 'transparent', color: 'var(--fg)',
          padding: '2px 0', borderBottom: '1px solid var(--accent)',
          fontFamily: 'inherit', ...editStyle,
        }}
      />
    );
  }

  return (
    <button onClick={() => setEditing(true)} title="Click to edit" style={{
      display: 'block', width: '100%', textAlign: 'left',
      padding: '2px 0', border: 0, background: 'transparent', cursor: 'text',
      ...style,
    }}>
      {value || <span style={{ color: 'var(--muted-2)', fontStyle: 'italic' }}>{placeholder}</span>}
    </button>
  );
}

function Tags({ client, onSave }) {
  const [tagInput, setTagInput] = useState('');

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if ((client.tags || []).includes(t)) { setTagInput(''); return; }
    onSave({ tags: [...(client.tags || []), t] });
    setTagInput('');
  };
  const removeTag = (t) => onSave({ tags: (client.tags || []).filter((x) => x !== t) });

  return (
    <div>
      <Section label="Tags"/>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {(client.tags || []).map((t) => (
          <span key={t} style={{
            padding: '3px 10px', borderRadius: 99, background: 'var(--surface-2)',
            border: '1px solid var(--border)', fontSize: 11.5,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {t}
            <button onClick={() => removeTag(t)} className="btn btn-ghost" style={{ padding: 0, color: 'var(--muted)' }}>
              <Icons.X size={10}/>
            </button>
          </span>
        ))}
        <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
          onBlur={addTag}
          placeholder="+ add tag"
          style={{
            padding: '3px 10px', borderRadius: 99, border: '1px dashed var(--border-strong)',
            background: 'transparent', fontSize: 11.5, outline: 0, width: 100, color: 'var(--fg)',
          }}/>
      </div>
    </div>
  );
}

function Notes({ client, onSave }) {
  const [draft, setDraft] = useState(client.notes || '');
  useEffect(() => { setDraft(client.notes || ''); }, [client.id, client.notes]);

  return (
    <div>
      <Section label="Private note"/>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== (client.notes || '') && onSave({ notes: draft })}
        placeholder="Anything useful to remember about this client…"
        style={{
          width: '100%', padding: 12, borderRadius: 10,
          fontFamily: 'inherit', fontSize: 13,
          border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
          color: 'var(--fg)', minHeight: 80, resize: 'vertical', outline: 0,
        }}/>
    </div>
  );
}
