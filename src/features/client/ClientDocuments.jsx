// /me/documents — pending and signed documents from every business.
// "Open & sign" mints a fresh signing token then opens the existing
// public /sign/:token page in a new tab.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

const STATUS_META = {
  sent:      { label: 'Awaiting your signature', color: 'var(--warn)' },
  completed: { label: 'Signed',                  color: 'var(--ok)' },
  voided:    { label: 'Voided',                  color: 'var(--muted)' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ClientDocuments() {
  const [docs, setDocs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [opening, setOpening] = useState(null);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    api.get('/me/documents')
      .then((r) => live && setDocs(r.documents || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [reloadKey]);

  const open = async (id) => {
    setOpening(id);
    try {
      const r = await api.post('/me/documents/' + id + '/access-link');
      window.open(r.url, '_blank', 'noopener');
    } catch (err) {
      alert('Could not open document: ' + (err.message || 'unknown error'));
    } finally {
      setOpening(null);
    }
  };

  if (loading) return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SkelRowList rows={4}/>
    </div>
  );
  if (error) return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Doc" title="Couldn't load documents"
          hint={error.message || 'Try refreshing.'}
          action={<button className="btn btn-outline" onClick={() => setReloadKey((n) => n + 1)}>Retry</button>}/>
      </div>
    </div>
  );

  const pending  = docs.filter((d) => d.status === 'sent');
  const finished = docs.filter((d) => d.status !== 'sent');

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 'clamp(26px, 4vw, 32px)',
          letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05,
        }}>Documents</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          Forms and agreements from every business you work with — sign once, kept forever.
        </p>
      </div>

      {docs.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Doc" title="No documents yet"
            hint="Waivers, agreements, or intake forms a business sends you will appear here."/>
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <Section title="Action needed" docs={pending} onOpen={open} opening={opening} accent/>
          )}
          {finished.length > 0 && (
            <Section title="Signed & filed" docs={finished} onOpen={open} opening={opening}/>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, docs, onOpen, opening, accent }) {
  return (
    <div>
      <div className="metric-label" style={{ marginBottom: 10, color: accent ? 'var(--accent)' : 'var(--muted)' }}>
        {title} ({docs.length})
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {docs.map((d, i) => {
          const meta = STATUS_META[d.status] || STATUS_META.sent;
          return (
            <div key={d.id} style={{
              padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14,
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              flexWrap: 'wrap',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icons.Doc size={16} sw={1.7}/></div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{d.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  From {d.businessName}
                  {d.status === 'sent' && d.fieldCount > 0 && (
                    <> · {d.fieldCount} field{d.fieldCount === 1 ? '' : 's'} to fill</>
                  )}
                  {d.sentAt && <> · Sent {fmtDate(d.sentAt)}</>}
                  {d.completedAt && <> · Signed {fmtDate(d.completedAt)}</>}
                </div>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 99,
                background: 'color-mix(in srgb, ' + meta.color + ' 14%, transparent)',
                color: meta.color, fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: meta.color }}/>
                {meta.label}
              </div>
              <button onClick={() => onOpen(d.id)} disabled={opening === d.id || d.status === 'voided'}
                className={d.status === 'sent' ? 'btn btn-primary' : 'btn btn-outline'}
                style={{ padding: '6px 12px', fontSize: 12,
                  opacity: (opening === d.id || d.status === 'voided') ? 0.5 : 1 }}>
                {opening === d.id ? 'Opening…' : d.status === 'sent' ? 'Open & sign' : 'View'}
                <Icons.Arrow size={11} sw={2}/>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
