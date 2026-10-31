// Live sessions of a program. The coach schedules, edits and cancels them
// and adds a recording afterwards; members RSVP, add them to their own
// calendar and join from here. The join link comes from the server only
// from 15 minutes before the start until the end.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { safeHref } from '../../lib/safeHref.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { MoreMenu } from '../../components/Moderation.jsx';
import { Sheet, Field, Toggle } from './communityUi.jsx';

const LOCATION_LABEL = { video: 'Video call', in_person: 'In person', link: 'Online link' };
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const durLabel = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr${m > 60 ? 's' : ''}`);
const opensLabel = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? `at ${fmtTime(iso)}` : `on ${fmtDay(iso)} at ${fmtTime(iso)}`);
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function LiveSessions({ programId, role }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // {} = new, event = edit
  const [, tick] = useState(0);
  const isOwner = role === 'owner';
  const load = () => api.get(`/programs/${programId}/events`).then((r) => { setData(r); setErr(null); }).catch((e) => { setErr(e.message); setData((d) => d || { upcoming: [], past: [] }); });
  useEffect(() => { load(); }, [programId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-check every minute so the join button appears when the window opens.
  useEffect(() => {
    const t = setInterval(() => {
      tick((x) => x + 1);
      const soon = (data?.upcoming || []).some((e) => !e.joinUrl && !e.cancelledAt && Date.now() >= new Date(e.joinOpensAt).getTime() && Date.now() <= new Date(e.endsAt).getTime());
      if (soon) load();
    }, 60000);
    return () => clearInterval(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const replace = (ev) => setData((d) => ({ ...d, upcoming: d.upcoming.map((x) => (x.id === ev.id ? ev : x)), past: d.past.map((x) => (x.id === ev.id ? ev : x)) }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200, fontSize: 13, color: 'var(--muted)' }}>Group calls, workshops and Q&amp;As. They also show on your calendar.</div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><Icons.Plus size={13} sw={2}/> Schedule a session</button>
        </div>
      )}
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <Section title="Upcoming">
        {data.upcoming.length === 0
          ? <EmptyNote icon="Calendar" title="Nothing scheduled" hint={isOwner ? 'Schedule a live session and members can RSVP and get reminders.' : 'New live sessions show up here.'}/>
          : data.upcoming.map((ev) => <EventCard key={ev.id} ev={ev} programId={programId} isOwner={isOwner} onChange={replace} onEdit={() => setEditing(ev)} reload={load} setErr={setErr}/>)}
      </Section>
      {data.past.length > 0 && (
        <Section title="Past">
          {data.past.map((ev) => <EventCard key={ev.id} ev={ev} programId={programId} isOwner={isOwner} onChange={replace} onEdit={() => setEditing(ev)} reload={load} setErr={setErr}/>)}
        </Section>
      )}
      {editing && <EventSheet programId={programId} ev={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}/>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{title}</div>
      {children}
    </div>
  );
}

function EventCard({ ev, programId, isOwner, onChange, onEdit, reload, setErr }) {
  const [busy, setBusy] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const start = new Date(ev.startsAt);
  const cancelled = !!ev.cancelledAt;
  const rsvp = async (status) => {
    setBusy(true);
    try { const r = await api.post(`/programs/${programId}/events`, { action: 'rsvp', eventId: ev.id, status }); onChange(r.event); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!window.confirm('Cancel this session? Members who said they are going get a note.')) return;
    try { await api.del(`/programs/${programId}/events?eventId=${ev.id}`); reload(); } catch (e) { setErr(e.message); }
  };
  const download = async () => {
    try {
      const r = await api.get(`/programs/${programId}/events?eventId=${ev.id}&format=ics`);
      const url = URL.createObjectURL(new Blob([r.ics], { type: 'text/calendar;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = r.filename || 'session.ics';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setErr(e.message); }
  };
  const google = async () => {
    try { const r = await api.get(`/programs/${programId}/events?eventId=${ev.id}&format=ics`); window.open(safeHref(r.googleUrl), '_blank', 'noopener'); }
    catch (e) { setErr(e.message); }
  };
  const menu = [
    !cancelled && !ev.past && { label: 'Add to Apple or Outlook (.ics)', onClick: download },
    !cancelled && !ev.past && { label: 'Add to Google Calendar', onClick: google },
    isOwner && !cancelled && { label: ev.past ? 'Edit or add recording' : 'Edit', onClick: onEdit },
    isOwner && !cancelled && !ev.past && { label: 'Cancel session', onClick: cancel, danger: true },
  ].filter(Boolean);
  return (
    <div className="card" style={{ padding: 14, display: 'flex', gap: 12, opacity: cancelled ? 0.65 : 1 }}>
      <div style={{ width: 48, flexShrink: 0, textAlign: 'center', borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)', padding: '6px 0', alignSelf: 'flex-start' }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{start.toLocaleDateString(undefined, { month: 'short' })}</div>
        <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>{start.getDate()}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>{ev.title}{cancelled && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Cancelled</span>}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{fmtDay(ev.startsAt)} · {fmtTime(ev.startsAt)} to {fmtTime(ev.endsAt)} · {LOCATION_LABEL[ev.locationType]}</div>
          </div>
          {menu.length > 0 && <MoreMenu items={menu} label="Session options"/>}
        </div>
        {ev.description && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{ev.description}</div>}
        {ev.locationType === 'in_person' && ev.locationText && <div style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}><Icons.Globe size={13}/> {ev.locationText}</div>}
        {!cancelled && !ev.past && (ev.locationType !== 'in_person') && (
          ev.joinUrl
            ? <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <a className="btn btn-primary" href={safeHref(ev.joinUrl)} target="_blank" rel="noreferrer noopener" style={{ alignSelf: 'flex-start', textDecoration: 'none' }}>Join session</a>
                {isOwner && !ev.joinOpen && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Members see this button from {fmtTime(ev.joinOpensAt)}.</span>}
              </div>
            : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>The join button appears here {opensLabel(ev.joinOpensAt)}, 15 minutes before the start.</div>
        )}
        {ev.recordingUrl && <a className="btn btn-outline" href={safeHref(ev.recordingUrl)} target="_blank" rel="noreferrer noopener" style={{ alignSelf: 'flex-start', textDecoration: 'none' }}>Watch the recording</a>}
        {isOwner && ev.past && !ev.recordingUrl && !cancelled && <button type="button" className="btn btn-ghost" onClick={onEdit} style={{ alignSelf: 'flex-start', fontSize: 12.5 }}>Add the recording link</button>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
          {isOwner
            ? <button type="button" onClick={() => setShowPeople((v) => !v)} style={{ color: 'var(--fg-2)', fontSize: 12.5, padding: 0 }}>{ev.goingCount} going{ev.remindEveryone ? ' · reminding everyone' : ''}</button>
            : <span>{ev.goingCount} going</span>}
          {!isOwner && !cancelled && !ev.past && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
              <button type="button" disabled={busy} onClick={() => rsvp('going')} className={`btn ${ev.rsvp === 'going' ? 'btn-primary' : 'btn-outline'}`} style={{ padding: '5px 12px', minHeight: 32, fontSize: 12.5 }}>{ev.rsvp === 'going' ? <><Icons.Check size={12}/> Going</> : 'Going'}</button>
              <button type="button" disabled={busy} onClick={() => rsvp('not_going')} className={`btn ${ev.rsvp === 'not_going' ? 'btn-primary' : 'btn-outline'}`} style={{ padding: '5px 12px', minHeight: 32, fontSize: 12.5 }}>Can&apos;t make it</button>
            </span>
          )}
        </div>
        {isOwner && showPeople && (
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>{(ev.attendees || []).length ? ev.attendees.map((a) => a.name).join(', ') : 'No one yet.'}</div>
        )}
      </div>
    </div>
  );
}

function EventSheet({ programId, ev, onClose, onSaved }) {
  const defStart = () => { const d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0); d.setHours(18); return toLocalInput(d.toISOString()); };
  const [f, setF] = useState({
    title: ev?.title || '', description: ev?.description || '', startsAt: ev ? toLocalInput(ev.startsAt) : defStart(),
    durationMin: ev?.durationMin || 60, locationType: ev?.locationType || 'video', locationText: ev?.locationText || '',
    externalUrl: ev?.externalUrl || '', videoUrl: ev?.locationType === 'video' ? (ev?.videoUrl || '') : '', recordingUrl: ev?.recordingUrl || '',
    remindEveryone: !!ev?.remindEveryone,
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const startsAt = new Date(f.startsAt);
    if (Number.isNaN(startsAt.getTime())) { setErr('Pick a date and time.'); setBusy(false); return; }
    const payload = {
      title: f.title, description: f.description, startsAt: startsAt.toISOString(), durationMin: Number(f.durationMin),
      locationType: f.locationType, locationText: f.locationText, externalUrl: f.externalUrl, remindEveryone: f.remindEveryone,
      ...(f.locationType === 'video' ? { videoUrl: f.videoUrl } : {}),
      ...(ev ? { recordingUrl: f.recordingUrl } : {}),
    };
    try {
      if (ev) await api.patch(`/programs/${programId}/events`, { eventId: ev.id, ...payload });
      else await api.post(`/programs/${programId}/events`, payload);
      onSaved();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={ev ? 'Edit live session' : 'Schedule a live session'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Title"><input className="input" value={f.title} onChange={set('title')} placeholder="Monthly group Q&A" required autoFocus/></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Field label="Starts"><input className="input" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} required/></Field>
          <Field label="Length">
            <select className="input" value={f.durationMin} onChange={set('durationMin')}>
              {[...new Set([15, 30, 45, 60, 75, 90, 120, 180, 240, Number(f.durationMin)])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{durLabel(m)}</option>)}
            </select>
          </Field>
        </div>
        <div role="group" aria-label="Where" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>Where</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {[['video', 'Video call'], ['in_person', 'In person'], ['link', 'Other link']].map(([t, l]) => (
              <button key={t} type="button" onClick={() => setF({ ...f, locationType: t })} className={`btn ${f.locationType === t ? 'btn-primary' : 'btn-outline'}`} style={{ flex: 1, justifyContent: 'center', padding: '6px 8px', fontSize: 12.5 }}>{l}</button>
            ))}
          </div>
        </div>
        {f.locationType === 'video' && <Field label="Your own meeting link (optional)" hint="Leave blank and Ivy creates a private video room for you."><input className="input" value={f.videoUrl} onChange={set('videoUrl')} placeholder="https://"/></Field>}
        {f.locationType === 'in_person' && <Field label="Address or place"><input className="input" value={f.locationText} onChange={set('locationText')} required/></Field>}
        {f.locationType === 'link' && <Field label="Join link" hint="Members see it from 15 minutes before the start."><input className="input" value={f.externalUrl} onChange={set('externalUrl')} placeholder="https://" required/></Field>}
        <Field label="Description (optional)"><textarea className="input" rows={3} value={f.description} onChange={set('description')} style={{ resize: 'vertical' }}/></Field>
        <Toggle checked={f.remindEveryone} onChange={(v) => setF({ ...f, remindEveryone: v })} label="Remind everyone" hint="Send the 24 hour and 1 hour reminders to every member, not just those who said they are going."/>
        {ev && <Field label="Recording link" hint="Paste it after the session. Members get a note that it is up."><input className="input" value={f.recordingUrl} onChange={set('recordingUrl')} placeholder="https://"/></Field>}
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !f.title.trim()}>{busy ? 'Saving…' : ev ? 'Save' : 'Schedule'}</button>
        </div>
      </form>
    </Sheet>
  );
}
