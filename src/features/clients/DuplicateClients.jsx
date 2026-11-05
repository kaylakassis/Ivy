// Possible duplicate clients: the review list, the merge sheet and the
// "Merge with..." picker on a client.
//
//   GET  /api/clients/duplicates           → { total, pairs: [{ key, label, reasons, keepId, a, b }] }
//   POST /api/clients/duplicates { action: 'dismiss', clientIds: [a, b] }  "Not the same person"
//   GET  /api/clients/merge?keepId=&removeId= → both records, the fields that differ, refusal
//   POST /api/clients/merge { keepId, removeId, fieldChoices } → { merged, alreadyMerged, client }
//
// Everything from client records is rendered as React text, never as HTML.
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { Sheet, Note, plural } from './import/parts.jsx';

const STAGE_RANK = { active: 3, paused: 2, lead: 1 };
const STAGE_WORD = { active: 'Active', paused: 'Paused', lead: 'Lead' };

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function joinWords(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function movesPhrase(counts) {
  const c = counts || {};
  const parts = [];
  if (c.bookings) parts.push(plural(c.bookings, 'booking'));
  if (c.invoices) parts.push(plural(c.invoices, 'invoice'));
  if (c.messages) parts.push(plural(c.messages, 'message'));
  if (c.documents) parts.push(plural(c.documents, 'document'));
  if (c.packages) parts.push(plural(c.packages, 'package'));
  return joinWords(parts);
}

// The history on one record, only what it has ("3 bookings", "1 note").
function countsLine(c) {
  const k = c?.counts || {};
  const out = [
    [k.bookings, 'booking'], [k.invoices, 'invoice'], [k.messages, 'message'],
    [k.documents, 'document'], [k.packages, 'package'], [k.notes, 'note'],
  ].filter(([n]) => n > 0).map(([n, w]) => plural(n, w));
  return out.length ? out : ['No history yet'];
}

function ConfidenceChip({ label }) {
  const strong = label === 'Same email' || label === 'Same phone';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 99,
      fontSize: 11.5, fontWeight: 650, whiteSpace: 'nowrap',
      background: strong ? 'var(--accent-soft)' : 'var(--surface-2)',
      color: strong ? 'var(--accent)' : 'var(--fg-2)', border: '1px solid var(--border)',
    }}>{label}</span>
  );
}

// ── side-by-side comparison ─────────────────────────────────────────────
function Compare({ a, b, keepId }) {
  const rows = [
    ['Email', a.email || '-', b.email || '-'],
    ['Phone', a.phone || '-', b.phone || '-'],
    ['Stage', STAGE_WORD[a.stage] || a.stage || '-', STAGE_WORD[b.stage] || b.stage || '-'],
    ['Added', fmtDate(a.createdAt) || '-', fmtDate(b.createdAt) || '-'],
    ['Latest booking', fmtDate(a.lastBooking) || 'None', fmtDate(b.lastBooking) || 'None'],
  ];
  const head = (c) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 650, overflowWrap: 'anywhere' }}>{c.name || 'No name'}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
        {c.id === keepId && <Tag tone="ok">Suggested to keep</Tag>}
        {c.portalClaimed && <Tag>Portal account</Tag>}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', columnGap: 12, rowGap: 6 }}>
      {head(a)}{head(b)}
      {rows.map(([label, x, y]) => (
        <React.Fragment key={label}>
          <div style={{ gridColumn: '1 / -1', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, marginTop: 4 }}>{label}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{x}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{y}</div>
        </React.Fragment>
      ))}
      <div style={{ gridColumn: '1 / -1', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, marginTop: 4 }}>History</div>
      {[a, b].map((c) => (
        <div key={c.id} style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          {countsLine(c).map((t) => <div key={t}>{t}</div>)}
        </div>
      ))}
    </div>
  );
}

function Tag({ children, tone }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 99, whiteSpace: 'nowrap',
      background: tone === 'ok' ? 'color-mix(in srgb, var(--ok) 12%, var(--surface))' : 'var(--surface-2)',
      color: tone === 'ok' ? 'var(--ok)' : 'var(--muted)', border: '1px solid var(--border)',
    }}>{children}</span>
  );
}

// ── the review list ─────────────────────────────────────────────────────
export function DuplicatesReview({ onClose, onMerged, onCountChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [merging, setMerging] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = () => api.get('/clients/duplicates')
    .then((r) => { setData(r); onCountChange?.(r.total || 0); })
    .catch((e) => setErr(e.message || 'Could not load possible duplicates.'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dropPairs = (fn) => setData((d) => {
    if (!d) return d;
    const pairs = d.pairs.filter((p) => !fn(p));
    const total = Math.max(0, d.total - (d.pairs.length - pairs.length));
    onCountChange?.(total);
    return { ...d, pairs, total };
  });

  const dismiss = async (p) => {
    setBusyKey(p.key); setErr(null);
    try {
      await api.post('/clients/duplicates', { action: 'dismiss', clientIds: [p.a.id, p.b.id] });
      dropPairs((x) => x.key === p.key);
      setNotice(`${p.a.name} and ${p.b.name} will not be suggested again.`);
    } catch (e) {
      setErr(e.message || 'That did not save. Try again.');
    } finally {
      setBusyKey(null);
    }
  };

  const merged = (result, removedId) => {
    dropPairs((x) => x.a.id === removedId || x.b.id === removedId);
    setMerging(null);
    setNotice(result?.client ? `Merged into ${result.client.name}.` : 'Merged.');
    onMerged?.(result);
    // Pairs that involved the kept client may have changed; refresh quietly.
    load();
  };

  return (
    <>
      <Sheet title="Possible duplicates" icon="Users" onClose={onClose} maxWidth={720}>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          These look like one person entered twice. Merge them to keep one record with all of their
          history, or mark them as different people.
        </p>
        {notice && <Note tone="ok" style={{ marginBottom: 10 }}>{notice}</Note>}
        {err && <Note tone="err" style={{ marginBottom: 10 }}>{err}</Note>}
        {!data && !err && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Looking for duplicates…</div>}
        {data && data.pairs.length === 0 && (
          <div style={{ padding: '24px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>No possible duplicates</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>Every client looks like a different person.</div>
          </div>
        )}
        {data && data.total > data.pairs.length && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Showing {data.pairs.length} of {data.total}. Review these and more will appear.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(data?.pairs || []).map((p) => (
            <div key={p.key} className="card" style={{ padding: 14, boxShadow: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <ConfidenceChip label={p.label}/>
                <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{p.reasons.join(' · ')}</span>
              </div>
              <Compare a={p.a} b={p.b} keepId={p.keepId}/>
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-outline" disabled={busyKey === p.key}
                  onClick={() => dismiss(p)} style={{ flex: '1 1 160px', justifyContent: 'center' }}>
                  {busyKey === p.key ? 'Saving…' : 'Not the same person'}
                </button>
                <button type="button" className="btn btn-primary" disabled={busyKey === p.key}
                  onClick={() => setMerging({ aId: p.a.id, bId: p.b.id, keepId: p.keepId })}
                  style={{ flex: '1 1 160px', justifyContent: 'center' }}>
                  <Icons.MoveTo size={14}/> Merge
                </button>
              </div>
            </div>
          ))}
        </div>
      </Sheet>
      {merging && (
        <MergeSheet
          aId={merging.aId} bId={merging.bId} initialKeepId={merging.keepId}
          onClose={() => setMerging(null)}
          onMerged={merged}
          z={140}
        />
      )}
    </>
  );
}

// ── the merge sheet ─────────────────────────────────────────────────────
export function MergeSheet({ aId, bId, initialKeepId = null, onClose, onMerged, onOpenClient, z = 140 }) {
  const { isMobile } = useViewport();
  const [keepId, setKeepId] = useState(initialKeepId || aId);
  const removeId = keepId === aId ? bId : aId;
  const [preview, setPreview] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [choices, setChoices] = useState({});
  const [cfChoices, setCfChoices] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [autoPicked, setAutoPicked] = useState(!!initialKeepId);

  useEffect(() => {
    let live = true;
    setPreview(null); setLoadErr(null); setChoices({}); setCfChoices({});
    api.get(`/clients/merge?keepId=${encodeURIComponent(keepId)}&removeId=${encodeURIComponent(removeId)}`)
      .then((r) => {
        if (!live) return;
        // Opened from "Merge with..." without a choice yet: start from the
        // suggested record (portal account, else the older one).
        if (!autoPicked && r.suggestedKeepId && r.suggestedKeepId !== keepId) {
          setAutoPicked(true);
          setKeepId(r.suggestedKeepId);
          return;
        }
        setAutoPicked(true);
        setPreview(r);
      })
      .catch((e) => live && setLoadErr(e.message || 'Could not load these clients.'));
    return () => { live = false; };
  }, [keepId]); // eslint-disable-line react-hooks/exhaustive-deps

  const keep = preview?.keep;
  const remove = preview?.remove;
  const differing = useMemo(() => (preview?.fields || []).filter((f) => f.differs), [preview]);
  const cfDiffering = useMemo(() => (preview?.customFields || []).filter((f) => f.differs), [preview]);
  const sideFor = (f) => {
    if (choices[f.field]) return choices[f.field];
    if (f.field === 'stage') return (STAGE_RANK[f.remove] || 0) > (STAGE_RANK[f.keep] || 0) ? 'remove' : 'keep';
    return 'keep';
  };

  const submit = async () => {
    if (!preview || preview.refusal || busy) return;
    setBusy(true); setErr(null);
    try {
      const fieldChoices = { ...choices };
      if (Object.keys(cfChoices).length) fieldChoices.customFields = cfChoices;
      const r = await api.post('/clients/merge', { keepId, removeId, fieldChoices });
      setDone({ ...r, movedPhrase: movesPhrase(remove?.counts), removedName: remove?.name });
    } catch (e) {
      setErr(e.message || 'The merge did not go through. Nothing changed.');
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    onMerged?.(done, removeId);
    if (!onMerged) onClose();
  };

  if (done) {
    const name = done.client?.name || keep?.name || 'your client';
    return (
      <Sheet title="Merged" icon="Users" onClose={finish} z={z} maxWidth={520}>
        <div style={{
          width: 52, height: 52, borderRadius: 99, margin: '4px auto 12px',
          background: 'var(--ok)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Check size={26} sw={2.4}/></div>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <h3 className="page-title" style={{ margin: 0, fontSize: 22 }}>{done.alreadyMerged ? 'Already merged' : `Merged into ${name}`}</h3>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            {done.alreadyMerged
              ? 'These two records were already merged, so nothing else changed.'
              : `${done.movedPhrase ? `${done.movedPhrase} moved to ${name}. ` : ''}${done.removedName || 'The other record'} was removed. Nobody was emailed.`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onOpenClient && done.client && (
            <button type="button" className="btn btn-outline" onClick={() => { onOpenClient(done.client.id); finish(); }}
              style={{ flex: '1 1 140px', justifyContent: 'center' }}>Open {name}</button>
          )}
          <button type="button" className="btn btn-primary" onClick={finish} style={{ flex: '1 1 140px', justifyContent: 'center' }}>Done</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Merge clients" icon="Users" onClose={onClose} z={z} maxWidth={620}>
      {loadErr && <Note tone="err">{loadErr}</Note>}
      {!preview && !loadErr && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
      {preview && (
        <>
          <SectionLabel>Which record stays?</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8, marginBottom: 14 }}>
            {[keep, remove].sort((x, y) => (x.id === aId ? -1 : y.id === aId ? 1 : 0)).map((c) => {
              const on = c.id === keepId;
              return (
                <button key={c.id} type="button" onClick={() => !on && setKeepId(c.id)} aria-pressed={on} style={{
                  textAlign: 'left', padding: '11px 12px', borderRadius: 12, cursor: on ? 'default' : 'pointer',
                  border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'color-mix(in srgb, var(--accent-soft) 55%, var(--surface))' : 'var(--surface)',
                  color: 'var(--fg)', minWidth: 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      width: 18, height: 18, borderRadius: 99, flexShrink: 0,
                      border: `2px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}>{on && <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--accent)' }}/>}</span>
                    <span style={{ fontSize: 14, fontWeight: 650, overflowWrap: 'anywhere', flex: 1, minWidth: 0 }}>{c.name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                    {[c.email, c.phone].filter(Boolean).join(' · ') || 'No email or phone'}
                    <br/>Added {fmtDate(c.createdAt) || '-'} · {movesPhrase(c.counts) || 'no history yet'}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    <Tag tone={on ? 'ok' : undefined}>{on ? 'Stays' : 'Removed after the merge'}</Tag>
                    {c.portalClaimed && <Tag>Portal account</Tag>}
                    {c.card && <Tag>{c.card}</Tag>}
                    {c.autopayActive && <Tag>Autopay on</Tag>}
                  </div>
                </button>
              );
            })}
          </div>

          {(differing.length > 0 || cfDiffering.length > 0) && (
            <>
              <SectionLabel>Where they differ, keep</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
                {differing.map((f) => (
                  <ChoiceRow key={f.field} label={f.label}
                    keepValue={f.field === 'stage' ? STAGE_WORD[f.keep] || f.keep : f.keep}
                    removeValue={f.field === 'stage' ? STAGE_WORD[f.remove] || f.remove : f.remove}
                    side={sideFor(f)} onChange={(s) => setChoices((c) => ({ ...c, [f.field]: s }))}/>
                ))}
                {cfDiffering.map((f) => (
                  <ChoiceRow key={f.id} label={f.label} keepValue={f.keep} removeValue={f.remove}
                    side={cfChoices[f.id] || 'keep'} onChange={(s) => setCfChoices((c) => ({ ...c, [f.id]: s }))}/>
                ))}
              </div>
            </>
          )}

          <SectionLabel>What happens</SectionLabel>
          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6 }}>
            <li>{preview.sentence}</li>
            <li>Notes from both are kept, one after the other.</li>
            {preview.tags.length > 0 && <li>Tags from both are kept: {preview.tags.join(', ')}.</li>}
            {(preview.optOuts.email || preview.optOuts.sms) && (
              <li>{preview.optOuts.email && preview.optOuts.sms ? 'Email and text opt-outs stay' : preview.optOuts.email ? 'Email opt-outs stay' : 'The text STOP stays'} on the merged client.</li>
            )}
            <li>Nobody is emailed or texted.</li>
          </ul>
          {preview.refusal
            ? <Note tone="err" style={{ marginBottom: 12 }}>{preview.refusal}</Note>
            : <Note tone="warn" style={{ marginBottom: 12 }}>This cannot be undone.</Note>}
          {err && <Note tone="err" style={{ marginBottom: 12 }}>{err}</Note>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} style={{ flex: '1 1 120px', justifyContent: 'center' }}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !!preview.refusal}
              style={{ flex: '2 1 200px', justifyContent: 'center', opacity: preview.refusal ? 0.5 : 1 }}>
              {busy ? 'Merging…' : `Merge into ${keep.name}`}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function SectionLabel({ children }) {
  return <div className="metric-label" style={{ marginBottom: 8 }}>{children}</div>;
}

function ChoiceRow({ label, keepValue, removeValue, side, onChange }) {
  const opt = (s, v) => {
    const on = side === s;
    return (
      <button type="button" onClick={() => onChange(s)} aria-pressed={on} style={{
        flex: '1 1 140px', minWidth: 0, textAlign: 'left', padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
        border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
        background: on ? 'color-mix(in srgb, var(--accent-soft) 55%, var(--surface))' : 'var(--surface)',
        color: 'var(--fg)', fontSize: 13, overflowWrap: 'anywhere', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: on ? 'var(--accent)' : 'var(--border-strong)', display: 'inline-flex', flexShrink: 0 }}>
          {on ? <Icons.Check size={14} sw={2.4}/> : <span style={{ width: 14 }}/>}
        </span>
        <span style={{ minWidth: 0 }}>{v}</span>
      </button>
    );
  };
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 5 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {opt('keep', keepValue)}{opt('remove', removeValue)}
      </div>
    </div>
  );
}

// ── "Merge with..." from one client ─────────────────────────────────────
export function MergeWithPicker({ client, clients, onClose, onMerged, onOpenClient }) {
  const [q, setQ] = useState('');
  const [other, setOther] = useState(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (clients || [])
      .filter((c) => c.id !== client.id && c.source !== 'demo')
      .filter((c) => !s || `${c.name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase().includes(s))
      .slice(0, 50);
  }, [clients, client.id, q]);

  if (other) {
    return (
      <MergeSheet aId={client.id} bId={other.id} onClose={() => setOther(null)}
        onMerged={(r, removedId) => onMerged?.(r, removedId)} onOpenClient={onOpenClient} z={150}/>
    );
  }
  return (
    <Sheet title={`Merge ${client.name} with…`} icon="Users" onClose={onClose} z={150} maxWidth={520}>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
        Pick the other record of the same person. You choose which one stays on the next step.
      </p>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <Icons.Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}/>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
          placeholder="Search by name, email or phone" aria-label="Search clients"
          style={{ width: '100%', paddingLeft: 32, fontSize: 14 }}/>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, maxHeight: 360, overflow: 'auto' }}>
        {list.map((c, i) => (
          <button key={c.id} type="button" onClick={() => setOther(c)} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 0,
            borderTop: i ? '1px solid var(--border)' : 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg)',
          }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[c.email, c.phone].filter(Boolean).join(' · ') || 'No email or phone'}
            </span>
          </button>
        ))}
        {list.length === 0 && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>Nobody matches that search.</div>}
      </div>
    </Sheet>
  );
}
