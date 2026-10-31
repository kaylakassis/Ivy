// Programs - sell courses, coaching programs and paid communities:
// modules and lessons (written, video, audio, PDF, downloads), drip
// schedules, member progress and a members-only feed.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { Community, fmtPrice, billingLabel } from './ProgramContent.jsx';
import ModuleEditor from './ModuleEditor.jsx';
import CoursePreview from './CoursePreview.jsx';
import { LiveSessions } from './LiveSessions.jsx';
import { DirectorySettings } from './MemberDirectory.jsx';

export default function ProgramsPage() {
  return <Builder/>;
}

// ── Builder ───────────────────────────────────────────────────────────
function Builder() {
  const [programs, setPrograms] = useState(null);
  const [openId, setOpenId] = useState(() => { try { return new URLSearchParams(window.location.search).get('program'); } catch { return null; } });
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const load = async () => { try { const r = await api.get('/programs'); setPrograms(r.programs || []); } catch (e) { setErr(e.message); setPrograms([]); } };
  useEffect(() => { load(); }, []);
  if (openId) return <ProgramDetail id={openId} onBack={() => { setOpenId(null); load(); }}/>;
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Programs</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>Courses, plans and paid communities your clients can buy.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icons.Plus size={13} sw={2}/> New program</button>
        </div>
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {programs === null ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        : programs.length === 0 ? <EmptyNote icon="Gift" title="No programs yet" hint="Create your first program, add lessons, PDFs and videos, then publish it to start selling." action={<button className="btn btn-primary" onClick={() => setCreating(true)}>Create a program</button>}/>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {programs.map((p) => (
              <button key={p.id} type="button" className="card" onClick={() => setOpenId(p.id)} style={{ padding: 16, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: p.status === 'published' ? 'var(--ok)' : 'var(--muted)' }}>{p.status}</span>
                </div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{p.title}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.description || 'No description yet.'}</div>
                <div style={{ marginTop: 'auto', display: 'flex', gap: 12, fontSize: 12.5, color: 'var(--fg-2)' }}>
                  <span><b>{p.priceCents ? fmtPrice(p.priceCents) : 'Free'}</b> {p.priceCents ? billingLabel(p.billing) : ''}</span>
                  <span>{p.items} item{p.items === 1 ? '' : 's'}</span>
                  <span>{p.members} member{p.members === 1 ? '' : 's'}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      {creating && <ProgramForm onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); setOpenId(p.id); }}/>}
    </div>
  );
}

function Field({ label, children, hint }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>{label}</span>{children}{hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}</label>;
}

function Sheet({ title, onClose, children, width = 520 }) {
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: width, maxHeight: '92vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 18, fontWeight: 600 }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ padding: 6, color: 'var(--muted)', display: 'inline-flex' }}><Icons.X size={18}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProgramForm({ program, onClose, onSaved }) {
  const [f, setF] = useState({ title: program?.title || '', description: program?.description || '', price: program ? (program.priceCents / 100).toString() : '', billing: program?.billing || 'one_time', accessDays: program?.accessDays ? String(program.accessDays) : '', communityEnabled: program ? program.communityEnabled : true });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const payload = { title: f.title, description: f.description, priceCents: Math.round(Number(f.price || 0) * 100), billing: f.billing, accessDays: f.billing === 'one_time' && f.accessDays ? Number(f.accessDays) : null, communityEnabled: f.communityEnabled };
    try { const r = program ? await api.patch(`/programs/${program.id}`, payload) : await api.post('/programs', payload); onSaved(r.program); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={program ? 'Edit program' : 'New program'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="The 6-Week Confidence Course" autoFocus required/></Field>
        <Field label="Description" hint="What's inside and who it's for. Shown on the sales page."><textarea className="input" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ resize: 'vertical' }}/></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Price" hint="0 = free (add members by hand)"><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="0.00"/></Field>
          <Field label="Billing"><select className="input" value={f.billing} onChange={(e) => setF({ ...f, billing: e.target.value })}><option value="one_time">One-time</option><option value="month">Monthly subscription</option><option value="year">Yearly subscription</option></select></Field>
        </div>
        {f.billing === 'one_time' ? (
          <Field label="Access lasts" hint="Leave blank for lifetime access. Otherwise access ends this many days after purchase (e.g. 56 for an 8-week program).">
            <input className="input" type="number" min="1" max="3650" inputMode="numeric" value={f.accessDays} onChange={(e) => setF({ ...f, accessDays: e.target.value })} placeholder="Forever"/>
          </Field>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>Members keep access while their subscription is active and lose it automatically when it ends or a payment fails.</div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}><input type="checkbox" checked={f.communityEnabled} onChange={(e) => setF({ ...f, communityEnabled: e.target.checked })}/> Enable the members-only community</label>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !f.title.trim()}>{busy ? 'Saving…' : program ? 'Save' : 'Create'}</button></div>
      </form>
    </Sheet>
  );
}

function ProgramDetail({ id, onBack }) {
  const [data, setData] = useState(null); const [tab, setTab] = useState(() => { try { const t = new URLSearchParams(window.location.search).get('tab'); return ['content', 'members', 'community', 'live'].includes(t) ? t : 'content'; } catch { return 'content'; } });
  const [editing, setEditing] = useState(false); const [previewing, setPreviewing] = useState(false);
  const [addMember, setAddMember] = useState(false); const [err, setErr] = useState(null); const [copied, setCopied] = useState(false);
  const [refunding, setRefunding] = useState(null); const [refundAmount, setRefundAmount] = useState(''); const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false); const [refundNote, setRefundNote] = useState(null);
  const load = async () => { try { setData(await api.get(`/programs/${id}`)); } catch (e) { setErr(e.message); } };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="page-pad" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (previewing) return <CoursePreview programId={id} onClose={() => { setPreviewing(false); load(); }}/>;
  const { program, items, members } = data;
  const publicUrl = `${window.location.origin}/p/${program.id}`;
  const toggle = async () => { try { await api.patch(`/programs/${id}`, { status: program.status === 'published' ? 'draft' : 'published' }); load(); } catch (e) { setErr(e.message); } };
  const archive = async () => { if (!window.confirm('Archive this program? It stops being sold. Current members keep their access.')) return; try { await api.del(`/programs/${id}`); onBack(); } catch (e) { setErr(e.message); } };
  const startRefund = (m) => { setRefunding(m.id); setRefundAmount(''); setRefundReason(''); setErr(null); setRefundNote(null); };
  const refund = async (m) => {
    setRefundBusy(true); setErr(null);
    try {
      const amountCents = refundAmount === '' ? null : Math.round(Number(refundAmount) * 100);
      const r = await api.post('/programs/refund', { enrollmentId: m.id, amountCents, reason: refundReason || null });
      setRefundNote(`Refunded ${fmtPrice(r.refund.amountCents)} to ${m.clientName || m.clientEmail}${r.refund.fullyRefunded ? '; their access has ended.' : '; they keep access.'}`);
      setRefunding(null);
      load();
    } catch (e) { setErr(e.message || 'Refund failed'); }
    finally { setRefundBusy(false); }
  };
  const revoke = async (m) => {
    const who = m.clientName || m.clientEmail;
    const q = m.stripeSubscriptionId && !m.cancelAtPeriodEnd
      ? `Remove ${who}'s access? This also cancels their subscription right away, so they are not charged again.`
      : `Remove ${who}'s access?`;
    if (!window.confirm(q)) return;
    try { await api.del(`/programs/${id}/members?enrollmentId=${m.id}`); load(); } catch (e) { setErr(e.message); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { window.prompt('Copy this link', publicUrl); } };
  const activeMembers = members.filter((m) => m.status !== 'cancelled');
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button type="button" onClick={onBack} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13 }}><Icons.Arrow size={13} style={{ transform: 'rotate(180deg)' }}/> All programs</button>
      <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: program.status === 'published' ? 'var(--ok)' : 'var(--muted)' }}>{program.status}</div>
            <h2 className="page-title" style={{ margin: '4px 0 0', fontSize: 26 }}>{program.title}</h2>
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginTop: 6, lineHeight: 1.5 }}>{program.description || 'No description yet.'}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}><b style={{ color: 'var(--fg)' }}>{program.priceCents ? fmtPrice(program.priceCents) : 'Free'}</b> {program.priceCents ? billingLabel(program.billing) : ''}{program.billing === 'one_time' ? ` · access ${program.accessDays ? `${program.accessDays} days` : 'forever'}` : ''} · {activeMembers.length} member{activeMembers.length === 1 ? '' : 's'} · community {program.communityEnabled ? 'on' : 'off'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-outline" onClick={() => setPreviewing(true)}><Icons.Eye size={13}/> Preview as member</button>
            <button className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-primary" onClick={toggle}>{program.status === 'published' ? 'Unpublish' : 'Publish'}</button>
          </div>
        </div>
        {program.status === 'published' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)' }}>Sales page:</span>
            <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{publicUrl}</a>
            <button className="btn btn-ghost" style={{ padding: '4px 10px', minHeight: 30, fontSize: 12.5 }} onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
        )}
      </div>
      <div className="scroll-x" style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, alignSelf: 'flex-start', maxWidth: '100%' }}>
        {[['content', `Content (${items.length})`], ['members', `Members (${activeMembers.length})`], ['community', 'Community'], ['live', 'Live']].map(([t, l]) => (
          <button key={t} type="button" onClick={() => setTab(t)} style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', background: tab === t ? 'var(--surface-2)' : 'transparent', color: tab === t ? 'var(--fg)' : 'var(--muted)' }}>{l}</button>
        ))}
      </div>
      {tab === 'content' && (
        <ModuleEditor programId={id} program={program} items={items} modules={data.modules || []} activeMembers={activeMembers.length} reload={load} onError={setErr}/>
      )}
      {tab === 'members' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <DirectorySettings programId={id}/>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" onClick={() => setAddMember(true)}><Icons.Plus size={13} sw={2}/> Add member</button></div>
          {refundNote && <div style={{ fontSize: 12.5, color: 'var(--ok)' }}>{refundNote}</div>}
          {members.length === 0 ? <EmptyNote icon="Users" title="No members yet" hint="Share the sales page, or add someone by hand."/> : (
            <div className="card">
              {members.map((m) => {
                const refundLeftCents = Math.max(0, Number(m.priceCents || 0) - Number(m.refundedCents || 0));
                const confirming = refunding === m.id;
                return (
                <div key={m.id} style={{ borderBottom: '1px solid var(--border)', opacity: m.status === 'cancelled' && !confirming ? .55 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.clientName || m.clientEmail}</div>
                    {m.status !== 'cancelled' && items.length > 0 && <MemberProgress m={m}/>}
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.clientEmail} · {m.source === 'manual' ? 'added by you' : m.source === 'subscription' ? `subscription${m.currentPeriodEnd && m.status !== 'cancelled' ? ` · ${m.cancelAtPeriodEnd ? 'ends' : 'renews'} ${new Date(m.currentPeriodEnd).toLocaleDateString()}` : ''}` : 'purchased'}{m.expiresAt ? ` · ends ${new Date(m.expiresAt).toLocaleDateString()}` : ''} · {m.status === 'past_due' ? 'payment past due' : m.status}{Number(m.refundedCents) > 0 ? ` · ${fmtPrice(m.refundedCents)} refunded` : ''}</div>
                  </div>
                  {m.refundable && !confirming && <button type="button" onClick={() => startRefund(m)} className="btn btn-ghost" style={{ fontSize: 12.5, padding: '6px 10px', minHeight: 32, color: 'var(--danger)' }}>Refund{Number(m.refundedCents) > 0 ? ` (${fmtPrice(refundLeftCents)} left)` : ''}</button>}
                  {m.status !== 'cancelled' && <button type="button" onClick={() => revoke(m)} className="btn btn-ghost" style={{ fontSize: 12.5, padding: '6px 10px', minHeight: 32 }}>Remove access</button>}
                </div>
                {confirming && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 16px 12px', fontSize: 12 }}>
                    <span style={{ color: 'var(--muted)', width: '100%' }}>Refund up to {fmtPrice(refundLeftCents)} through the card they paid with. A full refund ends their access.</span>
                    <input type="number" min="0.01" step="0.01" max={(refundLeftCents / 100).toFixed(2)} value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} placeholder={(refundLeftCents / 100).toFixed(2)} aria-label="Refund amount" className="input" style={{ width: 100, padding: '5px 8px', fontSize: 12 }}/>
                    <select value={refundReason} onChange={(e) => setRefundReason(e.target.value)} aria-label="Refund reason" className="input" style={{ padding: '5px 8px', fontSize: 12, width: 'auto' }}>
                      <option value="">Reason (optional)</option>
                      <option value="requested_by_customer">Customer requested</option>
                      <option value="duplicate">Charged twice</option>
                      <option value="fraudulent">Fraudulent</option>
                    </select>
                    <button type="button" className="btn btn-ghost" disabled={refundBusy} onClick={() => setRefunding(null)} style={{ fontSize: 12, padding: '4px 10px', minHeight: 30 }}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={refundBusy} onClick={() => refund(m)} style={{ fontSize: 12, padding: '4px 12px', minHeight: 30, background: 'var(--danger)' }}>
                      {refundBusy ? 'Refunding…' : (refundAmount && Math.round(Number(refundAmount) * 100) < refundLeftCents ? 'Refund partial' : 'Refund full amount')}
                    </button>
                  </div>
                )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {tab === 'community' && <Community programId={id} enabled={program.communityEnabled}/>}
      {tab === 'live' && <LiveSessions programId={id} role="owner"/>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" onClick={archive} style={{ fontSize: 12.5, color: 'var(--muted)' }}>Archive program</button></div>
      {editing && <ProgramForm program={program} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }}/>}
      {addMember && <AddMember programId={id} onClose={() => setAddMember(false)} onSaved={() => { setAddMember(false); load(); }}/>}
    </div>
  );
}

function AddMember({ programId, onClose, onSaved }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const submit = async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await api.post(`/programs/${programId}/members`, { name, email }); onSaved(); } catch (ex) { setErr(ex.message); } finally { setBusy(false); } };
  return (
    <Sheet title="Add a member" onClose={onClose} width={440}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>Gives access without a purchase (for clients who paid elsewhere, or for free). They'll see it in their client portal under Programs once they sign in with this email.</div>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus/></Field>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required/></Field>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !email}>{busy ? 'Adding…' : 'Add member'}</button></div>
      </form>
    </Sheet>
  );
}

// Members tab: how far a member is and when they last finished a lesson.
function MemberProgress({ m }) {
  const pct = Math.max(0, Math.min(100, m.progressPercent || 0));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 3px', fontSize: 12, color: 'var(--fg-2)' }}>
      <span style={{ width: 80, height: 5, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden', flexShrink: 0 }}><span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--accent)' }}/></span>
      <span>{pct}% complete{m.lastActivityAt ? ` · last active ${new Date(m.lastActivityAt).toLocaleDateString()}` : ' · not started'}</span>
    </div>
  );
}
