// Messages with no signal: the last conversations saved on this phone,
// read-only, text only. Sending waits for signal.
import React, { useState } from 'react';
import { Icons } from '../Icons.jsx';
import { useSnapshotBar } from '../../lib/useOffline.js';
import { OFFLINE_MESSAGE } from '../../lib/offline.js';
import OfflineNotice from './OfflineNotice.jsx';

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function OfflineMessages({ snapshot }) {
  const [openId, setOpenId] = useState(null);
  useSnapshotBar(snapshot?.savedAt);
  if (!snapshot) return <div style={{ padding: 16 }}><OfflineNotice/></div>;
  const threads = snapshot.items || [];
  const open = openId ? threads.find((t) => t.id === openId) : null;

  if (open) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <button type="button" className="btn btn-ghost" onClick={() => setOpenId(null)} aria-label="Back" style={{ padding: 6 }}><Icons.ArrowLeft size={16}/></button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{open.clientName || 'Client'}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Saved on this phone</div>
          </div>
        </div>
        <div className="scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 14px', background: 'var(--page)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {open.messages.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 40 }}>Open this conversation with signal once and Ivy will keep its last messages here.</div>
          ) : open.messages.map((m) => {
            const mine = m.sender !== 'client';
            return (
              <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
                <div style={{
                  padding: '9px 12px', borderRadius: 14, fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                  background: mine ? 'var(--accent)' : 'var(--surface)', color: mine ? 'var(--accent-ink)' : 'var(--fg)',
                  border: mine ? 'none' : '1px solid var(--border)',
                }}>{m.text || '(attachment, not saved offline)'}</div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, textAlign: mine ? 'right' : 'left' }}>{when(m.createdAt)}</div>
              </div>
            );
          })}
        </div>
        <div role="status" style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Clock size={13}/> {OFFLINE_MESSAGE}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Conversations</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Saved on this phone. {OFFLINE_MESSAGE}</div>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {threads.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>No conversations saved yet.</div>
        ) : threads.map((t) => (
          <button key={t.id} type="button" onClick={() => setOpenId(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '12px 16px',
            background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'inherit', cursor: 'pointer',
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: t.unreadBiz ? 700 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.clientName || 'Client'}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{when(t.lastMessageAt)}</span>
              </span>
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.lastPreview || ''}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
