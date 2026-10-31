// Members of a program as the group sees them: the coach first, then
// members with avatar, name, bio and joined date. Each person can set a
// display name, bio and photo per business, and hide from the directory.
// The coach can switch the directory off for a program. No emails or
// phone numbers ever reach this screen (the API never sends them).
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { Avatar, Sheet, Field, Toggle, uploadProgramImage, IMAGE_TYPES } from './communityUi.jsx';

const BIO_MAX = 280;

export function MemberDirectory({ programId, showProfileButton = true }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const load = () => api.get(`/programs/${programId}/directory`).then(setData).catch((e) => { setErr(e.message); setData({ members: [] }); });
  useEffect(() => { load(); }, [programId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (data.enabled === false && data.role !== 'owner') return <EmptyNote icon="Users" title="The member list is private" hint="The coach has turned the member directory off for this program."/>;
  const members = data.members || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180, fontSize: 13, color: 'var(--muted)' }}>
          {members.length - 1} member{members.length - 1 === 1 ? '' : 's'} listed{data.meHidden ? '. You are hidden from this list.' : ''}
        </div>
        {showProfileButton && <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}><Icons.Edit size={13}/> Your profile</button>}
      </div>
      {data.enabled === false && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Only you can see this list right now. Members see it when the directory is on.</div>}
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div className="card">
        {members.map((m, i) => (
          <div key={m.key} style={{ display: 'flex', gap: 12, padding: '12px 14px', borderTop: i ? '1px solid var(--border)' : 'none', alignItems: 'flex-start' }}>
            <Avatar name={m.name} url={m.avatarUrl} size={42}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                {m.isOwner && <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>Coach</span>}
                {m.isMe && <span style={{ fontSize: 11, color: 'var(--muted)' }}>(you)</span>}
              </div>
              {m.bio && <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.45, marginTop: 3, overflowWrap: 'anywhere' }}>{m.bio}</div>}
              {m.joinedAt && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>Joined {new Date(m.joinedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>}
            </div>
          </div>
        ))}
      </div>
      {editing && <ProfileSheet programId={programId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }}/>}
    </div>
  );
}

export function ProfileSheet({ programId, onClose, onSaved }) {
  const [s, setS] = useState(null);
  const [f, setF] = useState({ displayName: '', bio: '', avatarUrl: null, hideFromDirectory: false });
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState(null);
  useEffect(() => {
    api.get(`/programs/${programId}/community`).then((r) => {
      setS(r);
      setF({ displayName: r.profile?.displayName || '', bio: r.profile?.bio || '', avatarUrl: r.profile?.avatarUrl || null, hideFromDirectory: !!r.profile?.hideFromDirectory });
    }).catch((e) => setErr(e.message));
  }, [programId]);
  const pick = async (file) => {
    if (!file) return; setUploading(true); setErr(null);
    try { const url = await uploadProgramImage(file); setF((x) => ({ ...x, avatarUrl: url })); }
    catch (e) { setErr(e.message || 'Upload failed'); } finally { setUploading(false); }
  };
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.patch(`/programs/${programId}/community`, { profile: f }); onSaved?.(); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const isOwner = s?.role === 'owner';
  return (
    <Sheet title="Your profile" onClose={onClose} width={460}>
      {!s && !err ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div> : (
        <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>This is how you show up in this business&apos;s programs. Your email and phone number are never shown to other members.</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar name={f.displayName || s?.profile?.defaultName} url={f.avatarUrl} size={56}/>
            <label className="btn btn-outline" style={{ cursor: 'pointer' }}><Icons.Camera size={13}/> {uploading ? 'Uploading…' : f.avatarUrl ? 'Change photo' : 'Add a photo'}
              <input type="file" accept={IMAGE_TYPES} hidden onChange={(e) => pick(e.target.files?.[0])}/>
            </label>
            {f.avatarUrl && <button type="button" className="btn btn-ghost" onClick={() => setF({ ...f, avatarUrl: null })} style={{ fontSize: 12.5 }}>Remove</button>}
          </div>
          <Field label="Display name" hint={`Leave blank to use ${s?.profile?.defaultName || 'your name'}.`}>
            <input className="input" value={f.displayName} maxLength={80} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={s?.profile?.defaultName || ''}/>
          </Field>
          <Field label="Short bio" hint={`${f.bio.length}/${BIO_MAX}`}>
            <textarea className="input" rows={3} maxLength={BIO_MAX} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} placeholder="A line or two about you" style={{ resize: 'vertical' }}/>
          </Field>
          {!isOwner && <Toggle checked={f.hideFromDirectory} onChange={(v) => setF({ ...f, hideFromDirectory: v })} label="Hide me from the member directory" hint="You can still post and be seen in the community."/>}
          {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || uploading}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

// Owner: directory on/off and their coach profile. Sits on the owner's
// Members tab above the member management list.
export function DirectorySettings({ programId }) {
  const [s, setS] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showList, setShowList] = useState(false);
  const [err, setErr] = useState(null);
  const load = () => api.get(`/programs/${programId}/community`).then(setS).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [programId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (v) => { try { setS(await api.patch(`/programs/${programId}/community`, { directoryEnabled: v })); } catch (e) { setErr(e.message); } };
  if (!s) return null;
  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Toggle checked={s.directoryEnabled} disabled={!s.communityEnabled} onChange={toggle} label="Show a member directory to members"
            hint={s.communityEnabled ? 'Members see each other\'s name, photo and bio. Never emails or phone numbers. Anyone can hide themselves.' : 'Turn the community on to use the directory.'}/>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={() => setShowList((v) => !v)} style={{ fontSize: 12.5 }}>{showList ? 'Hide preview' : 'Preview'}</button>
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)} style={{ fontSize: 12.5 }}><Icons.Edit size={13}/> Your coach profile</button>
        </div>
      </div>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      {showList && <MemberDirectory programId={programId} showProfileButton={false}/>}
      {editing && <ProfileSheet programId={programId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }}/>}
    </div>
  );
}
