// Right-side drawer for editing one client.
import React, { useState, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';

export default function ClientDrawer({ client, onClose, onUpdate, onDelete }) {
  const initials = client.name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  const [noteDraft, setNoteDraft] = useState(client.notes || '');
  const [tagInput,  setTagInput]  = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => { setNoteDraft(client.notes || ''); }, [client.id, client.notes]);

  const stageButton = (s) => ({
    flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 550,
    textTransform: 'capitalize', cursor: 'pointer',
    border: '1px solid ' + (client.stage === s ? 'var(--accent)' : 'var(--border)'),
    background: client.stage === s ? 'var(--accent-soft)' : 'var(--surface)',
    color: client.stage === s ? 'var(--accent)' : 'var(--fg-2)',
  });

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if ((client.tags || []).includes(t)) { setTagInput(''); return; }
    onUpdate({ tags: [...(client.tags || []), t] });
    setTagInput('');
  };
  const removeTag = (t) => onUpdate({ tags: (client.tags || []).filter((x) => x !== t) });

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
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 99, flexShrink: 0,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 600,
          }}>{initials || '?'}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{client.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{client.email || '—'}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Stage switch */}
          <div>
            <Section label="Stage"/>
            <div style={{ display: 'flex', gap: 6 }}>
              {['active', 'lead', 'paused'].map((s) => (
                <button key={s} onClick={() => onUpdate({ stage: s })} style={stageButton(s)}>{s}</button>
              ))}
            </div>
          </div>

          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <MiniStat label="Lifetime"  value={client.lifetimeValue > 0 ? '$' + client.lifetimeValue.toLocaleString() : '—'}/>
            <MiniStat label="Since"     value={client.joinedAt ? new Date(client.joinedAt).toLocaleDateString([], { month: 'short', year: '2-digit' }) : '—'}/>
            <MiniStat label="Last seen" value={client.lastSeenAt ? Math.round((Date.now() - new Date(client.lastSeenAt).getTime()) / 86400e3) + 'd ago' : '—'}/>
          </div>

          {/* Tags */}
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
                placeholder="+ add tag"
                style={{
                  padding: '3px 10px', borderRadius: 99, border: '1px dashed var(--border-strong)',
                  background: 'transparent', fontSize: 11.5, outline: 0, width: 100, color: 'var(--fg)',
                }}/>
            </div>
          </div>

          {/* Notes */}
          <div>
            <Section label="Private note"/>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={() => noteDraft !== (client.notes || '') && onUpdate({ notes: noteDraft })}
              placeholder="Anything useful to remember about this client…"
              style={{
                width: '100%', padding: 12, borderRadius: 10,
                fontFamily: 'inherit', fontSize: 13,
                border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
                color: 'var(--fg)', minHeight: 70, resize: 'vertical', outline: 0,
              }}/>
          </div>
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>Permanently delete this client?</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ background: 'var(--danger)', color: 'white' }}
                onClick={onDelete}>Delete</button>
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
  return (
    <div className="metric-label" style={{ marginBottom: 8 }}>{label}</div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="metric-label" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono-num" style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{value}</div>
    </div>
  );
}
