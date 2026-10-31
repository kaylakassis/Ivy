// /helper - the helper's own schedule at one business. Day or week view
// of the bookings assigned to them: client, service, time, where (address
// or video link) and the notes the owner left. Tap a session for the
// client's contact details (only clients they are booked with come back
// from the API) and the Mark complete / No-show actions.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { useAnimatedClose } from '../../components/motion/useExitAnimation.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { expandBookings, fmtDateISO, parseISO, addDays, startOfWeek, WEEKDAYS_SHORT } from '../calendar/utils.js';
import { useHelper } from './helperContext.jsx';

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}
function fmtLongDay(iso) {
  return parseISO(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function isPastOccurrence(b) {
  const end = parseISO(b.occurrenceDate);
  end.setMinutes(end.getMinutes() + b.endMin);
  return end.getTime() < Date.now();
}

export default function HelperSchedule() {
  const { workspaceId, me } = useHelper();
  const { isMobile } = useViewport();
  const [searchParams] = useSearchParams();
  const todayISO = fmtDateISO(new Date());
  const [mode, setMode] = useState('day');          // 'day' | 'week'
  const [anchor, setAnchor] = useState(() => {
    const d = searchParams.get('date');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayISO;
  });
  const [bookings, setBookings] = useState(null);
  const [clients, setClients] = useState(null);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null); // expanded occurrence

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const q = `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const [s, c] = await Promise.all([
        api.get(`/helper/schedule${q}`),
        api.get(`/helper/clients-for-my-bookings${q}`).catch(() => ({ clients: [] })),
      ]);
      setBookings(s.bookings || []);
      setClients(c.clients || []);
      setErr(null);
    } catch (e) {
      setErr(e.message || 'Could not load your schedule');
    }
  }, [workspaceId]);
  useEffect(() => { load(); }, [load]);

  // Visible window.
  const range = useMemo(() => {
    const a = parseISO(anchor);
    if (mode === 'day') return { start: a, end: a, days: [anchor] };
    const s = startOfWeek(a);
    const days = Array.from({ length: 7 }, (_, i) => fmtDateISO(addDays(s, i)));
    return { start: s, end: addDays(s, 6), days };
  }, [anchor, mode]);

  const occurrences = useMemo(() => {
    if (!bookings) return [];
    return expandBookings(bookings, range.start, range.end)
      .sort((x, y) => (x.date === y.date ? x.startMin - y.startMin : x.date < y.date ? -1 : 1));
  }, [bookings, range]);

  const byDay = useMemo(() => {
    const m = new Map(range.days.map((d) => [d, []]));
    for (const o of occurrences) m.get(o.occurrenceDate)?.push(o);
    return m;
  }, [occurrences, range.days]);

  const clientById = useMemo(() => new Map((clients || []).map((c) => [c.id, c])), [clients]);

  const step = (dir) => {
    const n = mode === 'day' ? 1 : 7;
    setAnchor(fmtDateISO(addDays(parseISO(anchor), dir * n)));
  };

  const title = mode === 'day'
    ? (anchor === todayISO ? `Today, ${fmtLongDay(anchor).replace(/^[A-Za-z]+, /, '')}` : fmtLongDay(anchor))
    : `${parseISO(range.days[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to ${parseISO(range.days[6]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const afterChange = (updated) => {
    setBookings((list) => (list || []).map((b) => (b.id === updated.id ? { ...b, ...updated } : b)));
    setSelected((s) => (s && s.id === updated.id ? { ...s, ...updated, date: s.date, occurrenceDate: s.occurrenceDate } : s));
  };

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div role="group" aria-label="View" style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
          {['day', 'week'].map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
              className="seg-btn" style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, border: 0, cursor: 'pointer',
                background: mode === m ? 'var(--surface)' : 'transparent', color: mode === m ? 'var(--fg)' : 'var(--muted)',
                boxShadow: mode === m ? 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.08))' : 'none',
              }}>{m === 'day' ? 'Day' : 'Week'}</button>
          ))}
        </div>
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={() => step(-1)} aria-label="Previous" style={{ padding: '6px 9px' }}><Icons.ArrowLeft size={14}/></button>
        <button className="btn btn-outline" onClick={() => setAnchor(todayISO)} style={{ padding: '6px 12px', fontSize: 12.5 }}>Today</button>
        <button className="btn btn-outline" onClick={() => step(1)} aria-label="Next" style={{ padding: '6px 9px', transform: 'scaleX(-1)' }}><Icons.ArrowLeft size={14}/></button>
      </div>

      <div style={{ fontFamily: 'var(--font-display)', fontSize: isMobile ? 18 : 20, fontWeight: 500, letterSpacing: '-0.015em' }}>{title}</div>

      {err && <div className="card" style={{ padding: 14, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {bookings === null && !err && <SkelRowList rows={3}/>}

      {bookings !== null && occurrences.length === 0 && (
        <div className="card">
          <EmptyNote icon="Calendar" title={mode === 'day' ? 'Nothing assigned to you this day' : 'Nothing assigned to you this week'}
            hint={`${me?.business?.businessName || 'The owner'} assigns sessions to you from their calendar. They show up here the moment that happens.`}/>
        </div>
      )}

      {bookings !== null && occurrences.length > 0 && range.days.map((day) => {
        const list = byDay.get(day) || [];
        if (mode === 'week' && list.length === 0) return null;
        return (
          <section key={day} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mode === 'week' && (
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: day === todayISO ? 'var(--accent)' : 'var(--muted)' }}>
                {WEEKDAYS_SHORT[parseISO(day).getDay()]} · {parseISO(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{day === todayISO ? ' · Today' : ''}
              </div>
            )}
            {list.map((o) => (
              <BookingRow key={`${o.id}-${o.occurrenceDate}`} o={o} client={clientById.get(o.clientId)}
                onOpen={() => setSelected(o)}/>
            ))}
          </section>
        );
      })}

      {selected && (
        <BookingSheet o={selected} client={clientById.get(selected.clientId)} workspaceId={workspaceId}
          onClose={() => setSelected(null)} onChanged={afterChange}/>
      )}
    </div>
  );
}

function statusOf(o) {
  if (o.noShowAt) return { label: 'No-show', tone: 'var(--warn)' };
  if (o.completed?.[o.occurrenceDate]) return { label: 'Done', tone: 'var(--ok)' };
  return null;
}

function whereLine(o) {
  if (o.videoRoomUrl) return 'Video call';
  if (o.locationAddress) return o.locationAddress;
  if (o.locationLabel) return o.locationLabel;
  return null;
}

function BookingRow({ o, client, onOpen }) {
  const st = statusOf(o);
  const where = whereLine(o);
  return (
    <button type="button" onClick={onOpen} className="card" style={{
      padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', width: '100%', cursor: 'pointer',
      opacity: st ? 0.75 : 1,
    }}>
      <div style={{ minWidth: 62, fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{fmtTime(o.startMin)}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{fmtTime(o.endMin)}</div>
      </div>
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.clientName || client?.name || 'Walk-in'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.serviceName}{where ? ` · ${where}` : ''}
        </div>
      </div>
      {st ? (
        <span style={{
          fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          padding: '3px 8px', borderRadius: 99, color: st.tone,
          background: `color-mix(in srgb, ${st.tone} 14%, transparent)`,
        }}>{st.label}</span>
      ) : <Icons.Arrow size={14} stroke="var(--muted)"/>}
    </button>
  );
}

// Detail sheet: client contact (only for this booking's client), where,
// notes, and the two actions. Bottom sheet on the phone, centered on
// larger screens.
function BookingSheet({ o, client, workspaceId, onClose: onCloseNow, onChanged }) {
  const { isMobile } = useViewport();
  const { closing, close: onClose } = useAnimatedClose(onCloseNow);
  useEscapeKey(onClose);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const st = statusOf(o);
  const done = !!o.completed?.[o.occurrenceDate];
  const past = isPastOccurrence(o);

  const call = async (fn) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); onChanged(r.booking); }
    catch (e) { setErr(e.message || 'Something went wrong'); }
    finally { setBusy(false); }
  };
  const base = `/helper/bookings/${encodeURIComponent(o.id)}`;
  const body = { workspaceId, occurrenceDate: o.occurrenceDate };
  const complete = () => call(() => api.post(`${base}/complete`, { ...body, notes: notes.trim() }));
  const undoComplete = () => call(() => api.del(`${base}/complete`, body));
  const noShow = () => call(() => api.post(`${base}/no-show`, body));
  const undoNoShow = () => call(() => api.del(`${base}/no-show`, body));

  const where = whereLine(o);

  return (
    <>
      <div onClick={onClose} className={`motion-backdrop${closing ? ' is-closing' : ''}`}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 95 }}/>
      <div role="dialog" aria-modal="true" aria-label="Session details"
        className={`${isMobile ? 'motion-sheet' : 'motion-modal'}${closing ? ' is-closing' : ''}`}
        style={isMobile ? {
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100,
          background: 'var(--surface)', borderTop: '1px solid var(--border)',
          borderRadius: '16px 16px 0 0', padding: '14px 16px calc(16px + env(safe-area-inset-bottom))',
          maxHeight: '88vh', overflowY: 'auto',
        } : {
          position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 100,
          width: 'min(92vw, 440px)', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 16, padding: 20, boxShadow: 'var(--shadow)', maxHeight: '88vh', overflowY: 'auto',
        }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtLongDay(o.occurrenceDate)} · {fmtTime(o.startMin)} to {fmtTime(o.endMin)}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.015em', marginTop: 2 }}>
              {o.serviceName}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>

        {st && (
          <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: st.tone }}>
            {st.label === 'Done' ? 'Marked complete' : 'Marked as a no-show'}
          </div>
        )}

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Line icon="Users" label="Client">
            <div style={{ fontWeight: 550 }}>{o.clientName || client?.name || 'Walk-in'}</div>
            {client?.phone && <a href={`tel:${client.phone}`} style={{ color: 'var(--accent)', fontSize: 13, display: 'block' }}>{client.phone}</a>}
            {client?.email && <a href={`mailto:${client.email}`} style={{ color: 'var(--accent)', fontSize: 13, display: 'block', wordBreak: 'break-all' }}>{client.email}</a>}
            {!client?.phone && !client?.email && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No contact details on file.</div>}
          </Line>
          {(where || o.videoRoomUrl) && (
            <Line icon="Globe" label="Where">
              {o.videoRoomUrl
                ? <a href={o.videoRoomUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>Join the video call</a>
                : <div>{where}</div>}
            </Line>
          )}
          {o.notes && (
            <Line icon="Doc" label="Notes from the owner">
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{o.notes}</div>
            </Line>
          )}
          {done && o.completed[o.occurrenceDate]?.notes && (
            <Line icon="Check" label="Your notes">
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{o.completed[o.occurrenceDate].notes}</div>
            </Line>
          )}
        </div>

        {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}

        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!done && !o.noShowAt && (
            <>
              {showNotes && (
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="input"
                  placeholder="Anything the owner should know about this session (optional)"
                  style={{ width: '100%', fontSize: 13.5, resize: 'vertical' }}/>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" disabled={busy} onClick={complete} style={{ flex: 1, justifyContent: 'center' }}>
                  <Icons.Check size={14} sw={2.2}/> {busy ? 'Saving…' : 'Mark complete'}
                </button>
                {!showNotes && (
                  <button className="btn btn-outline" disabled={busy} onClick={() => setShowNotes(true)} title="Add a note">
                    <Icons.Edit size={14}/>
                  </button>
                )}
              </div>
              {past && (
                <button className="btn btn-outline" disabled={busy} onClick={noShow} style={{ justifyContent: 'center' }}>
                  Client did not show up
                </button>
              )}
            </>
          )}
          {done && (
            <button className="btn btn-outline" disabled={busy} onClick={undoComplete} style={{ justifyContent: 'center' }}>Undo mark complete</button>
          )}
          {o.noShowAt && (
            <button className="btn btn-outline" disabled={busy} onClick={undoNoShow} style={{ justifyContent: 'center' }}>Undo no-show</button>
          )}
        </div>
      </div>
    </>
  );
}

function Line({ icon, label, children }) {
  const I = Icons[icon] || Icons.Doc;
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 13.5 }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, flex: 'none', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        <I size={14}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
        {children}
      </div>
    </div>
  );
}
