// Email campaigns / newsletters. Compose a message, pick an audience
// (all clients / a tag / website newsletter sign-ups), preview the
// recipient count, send a test to yourself, then send. Marketing sends
// honor each recipient's opt-out + carry an unsubscribe link.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useCampaigns } from './state.js';

const STATUS = {
  draft:   { label: 'Draft',   color: 'var(--muted)' },
  sending: { label: 'Sending', color: 'var(--warn)' },
  sent:    { label: 'Sent',    color: 'var(--ok)' },
};

export default function Campaigns() {
  const { campaigns, loading, error, create, update, remove, send, sendTest, previewCount } = useCampaigns();
  const [openId, setOpenId] = useState(null);
  const open = campaigns.find((c) => c.id === openId) || null;

  const startNew = async () => {
    const c = await create({ subject: '', body: '', audience: 'all-clients' });
    setOpenId(c.id);
  };

  if (loading) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>Campaigns</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--fg-2)' }}>
            Send a newsletter or announcement to your clients and subscribers.
          </p>
        </div>
        <button className="btn btn-primary" onClick={startNew}>
          <Icons.Plus size={14}/> New campaign
        </button>
      </div>

      {error && (
        <div className="card" style={{ padding: 14, color: 'var(--danger)', fontSize: 13 }}>
          Couldn’t load campaigns — {error.message}
        </div>
      )}

      {campaigns.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Mail" title="No campaigns yet"
            hint="Create one to email your client list or newsletter subscribers."/>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {campaigns.map((c) => {
            const st = STATUS[c.status] || STATUS.draft;
            return (
              <button key={c.id} onClick={() => setOpenId(c.id)} style={{
                textAlign: 'left', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 12, padding: 14,
                borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.subject || '(no subject)'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {audienceLabel(c.audience)}
                    {c.status === 'sent' && ` · ${c.sentCount} sent${c.failedCount ? `, ${c.failedCount} failed` : ''}`}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: st.color }}>{st.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {open && (
        <CampaignEditor
          key={open.id}
          campaign={open}
          onClose={() => setOpenId(null)}
          onSave={(patch) => update(open.id, patch)}
          onDelete={async () => { await remove(open.id); setOpenId(null); }}
          onSend={() => send(open.id)}
          onTest={() => sendTest(open.id)}
          previewCount={previewCount}
        />
      )}
    </div>
  );
}

function audienceLabel(a) {
  if (a === 'all-clients') return 'All clients';
  if (a === 'newsletter') return 'Newsletter subscribers';
  if (a?.startsWith('tag:')) return `Tagged “${a.slice(4)}”`;
  return a;
}

function CampaignEditor({ campaign, onClose, onSave, onDelete, onSend, onTest, previewCount }) {
  const [subject, setSubject] = useState(campaign.subject || '');
  const [body, setBody] = useState(campaign.body || '');
  const audInit = campaign.audience?.startsWith('tag:')
    ? { type: 'tag', tag: campaign.audience.slice(4) }
    : { type: campaign.audience || 'all-clients', tag: '' };
  const [audType, setAudType] = useState(audInit.type);
  const [tag, setTag] = useState(audInit.tag);
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(null); // 'save' | 'test' | 'send'
  const [msg, setMsg] = useState(null);
  const sent = campaign.status === 'sent';

  const audience = audType === 'tag' ? `tag:${tag.trim()}` : audType;

  useEffect(() => {
    let live = true;
    if (audType === 'tag' && !tag.trim()) { setCount(0); return undefined; }
    previewCount(audience).then((n) => { if (live) setCount(n); }).catch(() => live && setCount(null));
    return () => { live = false; };
  }, [audience, audType, tag, previewCount]);

  const save = async () => {
    setBusy('save'); setMsg(null);
    try { await onSave({ subject, body, audience }); setMsg('Saved'); }
    catch (e) { setMsg(e.message || 'Save failed'); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setMsg(null);
    try { await onSave({ subject, body, audience }); const r = await onTest(); setMsg(`Test sent to ${r.to}`); }
    catch (e) { setMsg(e.message || 'Test failed'); }
    finally { setBusy(null); }
  };
  const doSend = async () => {
    if (!subject.trim()) { setMsg('Add a subject first'); return; }
    if (!confirm(`Send “${subject}” to ${count ?? 'your'} recipient(s)? This can’t be undone.`)) return;
    setBusy('send'); setMsg(null);
    try { await onSave({ subject, body, audience }); await onSend(); setMsg('Sent!'); }
    catch (e) { setMsg(e.message || 'Send failed'); }
    finally { setBusy(null); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{
        width: 'min(100%, 620px)', padding: 22, marginTop: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>
            {sent ? 'Campaign' : 'Edit campaign'}
          </h3>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>

        {sent && (
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)',
            fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 14 }}>
            Sent to {campaign.sentCount} recipient(s){campaign.failedCount ? `, ${campaign.failedCount} failed` : ''}. Sent campaigns are read-only.
          </div>
        )}

        <label style={lbl}>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={sent}
          placeholder="e.g. June specials + a thank-you" style={inp}/>

        <label style={lbl}>Audience</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: tag || audType === 'tag' ? 8 : 12 }}>
          <select value={audType} onChange={(e) => setAudType(e.target.value)} disabled={sent} style={{ ...inp, width: 'auto', marginBottom: 0 }}>
            <option value="all-clients">All clients</option>
            <option value="tag">Clients with tag…</option>
            <option value="newsletter">Newsletter subscribers</option>
          </select>
          {audType === 'tag' && (
            <input value={tag} onChange={(e) => setTag(e.target.value)} disabled={sent}
              placeholder="tag name" style={{ ...inp, width: 160, marginBottom: 0 }}/>
          )}
          <span style={{ alignSelf: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
            {count == null ? '' : `${count} recipient${count === 1 ? '' : 's'}`}
          </span>
        </div>

        <label style={lbl}>Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={sent} rows={9}
          placeholder="Write your update. Plain text — line breaks are kept."
          style={{ ...inp, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}/>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: -6, marginBottom: 12 }}>
          We wrap this in your branded email template and add an unsubscribe link automatically.
        </div>

        {msg && <div style={{ fontSize: 12.5, color: 'var(--accent)', marginBottom: 12 }}>{msg}</div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {!sent && (
            <>
              <button className="btn btn-outline" onClick={save} disabled={!!busy}>
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </button>
              <button className="btn btn-outline" onClick={test} disabled={!!busy}>
                {busy === 'test' ? 'Sending…' : 'Send test to me'}
              </button>
              <div style={{ flex: 1 }}/>
              <button className="btn btn-ghost" onClick={onDelete} disabled={!!busy} style={{ color: 'var(--danger)' }}>
                Delete
              </button>
              <button className="btn btn-primary" onClick={doSend} disabled={!!busy || !subject.trim()}>
                <Icons.Mail size={13}/> {busy === 'send' ? 'Sending…' : `Send${count != null ? ` to ${count}` : ''}`}
              </button>
            </>
          )}
          {sent && <button className="btn btn-ghost" onClick={onDelete} style={{ color: 'var(--danger)' }}>Delete</button>}
        </div>
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 };
const inp = { width: '100%', padding: '9px 12px', fontSize: 14, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--fg)', outline: 'none', marginBottom: 12, boxSizing: 'border-box' };
