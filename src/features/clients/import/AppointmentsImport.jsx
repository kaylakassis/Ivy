// Bring upcoming appointments over: from a calendar file (.ics) or from the
// owner's connected Google Calendar. Both show the same review list first;
// nothing is created until the owner presses Import, and no confirmation
// emails or texts go to clients.
//
// Endpoints (contracts in the switch brief):
//   POST /api/import/calendar-file { ics, mode: 'preview' }          → { events, totals }
//   POST /api/import/calendar-file { ics, mode: 'import', uids }      → { created, skipped, missingEmail }
//   GET  /api/import/google-events?days=90                           → { connected, events }
//   POST /api/import/google-events { events: [{ id, clientName, clientEmail?, serviceId? }] }
//   GET  /api/calendar/google/status, /api/calendar/google/connect   (existing)
//   GET  /api/calendar                                               (existing; services for the dropdown)
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../../components/Icons.jsx';
import { api } from '../../../lib/api.js';
import { Note, QuietNote, plural } from './parts.jsx';

export const ICS_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_MAX = 500;

// "Tue, Nov 4" + "2:30 PM". All-day ISO dates ("2026-11-04") are read as a
// local date so they do not slip a day west of UTC.
export function whenLabel(startIso, allDay) {
  if (!startIso) return { date: '', time: '' };
  let d;
  if (allDay && /^\d{4}-\d{2}-\d{2}/.test(startIso)) {
    const [y, m, day] = startIso.slice(0, 10).split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return {
    date: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    time: allDay ? 'All day' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  };
}

// Review list shared by both sources. rows: [{ key, start, allDay, client,
// service, disabled, reason, recurring }]. When `editable`, the client name is
// an input and the service a dropdown (Google events).
function ReviewList({ rows, selected, setSelected, editable, services = [], onEdit }) {
  const enabled = rows.filter((r) => !r.disabled);
  const toggle = (key) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>
          {selected.size} of {enabled.length} selected
        </span>
        <button type="button" className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12.5 }}
          onClick={() => setSelected(new Set(enabled.map((r) => r.key)))}>Select all</button>
        <button type="button" className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12.5 }}
          onClick={() => setSelected(new Set())}>None</button>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, maxHeight: 380, overflow: 'auto' }}>
        {rows.map((r, i) => {
          const w = whenLabel(r.start, r.allDay);
          const on = selected.has(r.key);
          return (
            <div key={r.key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              borderTop: i ? '1px solid var(--border)' : 'none',
              opacity: r.disabled ? 0.45 : 1,
              background: on ? 'color-mix(in srgb, var(--accent-soft) 45%, transparent)' : 'transparent',
            }}>
              <input type="checkbox" checked={on} disabled={r.disabled} onChange={() => toggle(r.key)}
                aria-label={`Import ${r.client || 'this appointment'}`}
                style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0, accentColor: 'var(--accent)' }}/>
              <div style={{ width: 84, flexShrink: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{w.date}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{w.time}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editable && !r.disabled ? (
                  <input className="input" value={r.client} maxLength={120}
                    onChange={(e) => onEdit(r.key, { client: e.target.value })}
                    placeholder="Client name" aria-label="Client name"
                    style={{ width: '100%', padding: '6px 8px', fontSize: 14 }}/>
                ) : (
                  <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.client || <span style={{ color: 'var(--muted)' }}>No client name</span>}
                  </div>
                )}
                {editable && !r.disabled ? (
                  <select value={r.serviceId || ''} onChange={(e) => onEdit(r.key, { serviceId: e.target.value || null })}
                    aria-label="Service"
                    style={{ marginTop: 6, width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--fg)', fontSize: 13 }}>
                    <option value="">No service</option>
                    {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.service || r.title || 'No service'}
                  </div>
                )}
                {(r.reason || r.recurring) && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    {r.reason && <Pill>{r.reason}</Pill>}
                    {r.recurring && <Pill icon="Repeat">Repeats</Pill>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
            No appointments found.
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({ icon, children }) {
  const I = icon ? Icons[icon] : null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
      padding: '2px 8px', borderRadius: 99, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg-2)',
    }}>{I && <I size={11} sw={2}/>}{children}</span>
  );
}

function ImportButton({ count, busy, onClick, label = 'appointment', disabled }) {
  const off = busy || count === 0 || disabled;
  return (
    <button type="button" onClick={onClick} disabled={off} className="btn btn-primary"
      style={{ width: '100%', justifyContent: 'center', padding: '12px 14px', opacity: off ? 0.6 : 1 }}>
      {busy ? 'Adding…' : count === 0 ? `Pick at least one ${label}` : `Add ${plural(count, label)} to my calendar`}
    </button>
  );
}

// ── Calendar file (.ics) ─────────────────────────────────────────────

export function IcsImport({ initialText, onDone }) {
  const [text, setText] = useState(initialText || '');
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const load = async (ics) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/import/calendar-file', { ics, mode: 'preview' });
      const events = Array.isArray(r.events) ? r.events : [];
      setPreview({ events, totals: r.totals || {} });
      setSelected(new Set(events
        .map((e, i) => ({ e, key: e.uid || `row-${i}` }))
        .filter(({ e }) => !e.past && !e.duplicate && !e.allDay)
        .map(({ key }) => key)));
    } catch (e) {
      setErr(e.message || 'Could not read that calendar file.');
    } finally { setBusy(false); }
  };

  useEffect(() => { if (initialText) load(initialText); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (file) => {
    if (!file) return;
    setErr(null);
    if (file.size > ICS_MAX_BYTES) { setErr('That calendar file is over 2 MB. Try exporting just the calendar with your bookings.'); return; }
    try {
      const t = await file.text();
      if (!/BEGIN:VCALENDAR/i.test(t.slice(0, 5000))) { setErr("That doesn't look like a calendar file. It should end in .ics."); return; }
      setText(t);
      load(t);
    } catch { setErr('Could not read that file.'); }
  };

  const rows = useMemo(() => (preview?.events || []).map((e, i) => ({
    key: e.uid || `row-${i}`,
    uid: e.uid,
    start: e.start, allDay: !!e.allDay,
    client: e.clientName || '', service: e.serviceName || '', title: e.title || '',
    disabled: !!e.past || !!e.duplicate,
    reason: e.past ? 'Already happened' : e.duplicate ? 'Already in Ivy' : e.allDay ? 'All day' : '',
    recurring: !!e.recurring,
  })), [preview]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const uids = rows.filter((r) => selected.has(r.key) && r.uid).map((r) => r.uid);
      const r = await api.post('/import/calendar-file', { ics: text, mode: 'import', uids });
      onDone({ kind: 'bookings', created: r.created || 0, skipped: r.skipped || 0, missingEmail: r.missingEmail || [] });
    } catch (e) {
      setErr(e.message || 'Import failed. Nothing was added.');
    } finally { setBusy(false); }
  };

  if (!preview) {
    return (
      <>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Most calendars and booking apps can save your schedule as a calendar file (it ends in <strong>.ics</strong>).
          In Google Calendar on a computer: Settings, Import &amp; export, Export.
        </p>
        <input ref={fileRef} type="file" accept=".ics,.ical,text/calendar" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }}/>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
          className="btn btn-outline" style={{ width: '100%', justifyContent: 'center', padding: '14px 20px' }}>
          <Icons.Calendar size={15}/> {busy ? 'Reading your calendar…' : 'Choose calendar file'}
        </button>
        <Note style={{ marginTop: 12 }}>
          Google gives you a .zip file. Open it first, then pick the .ics file inside.
        </Note>
        {err && <Note tone="err" style={{ marginTop: 12 }}>{err}</Note>}
      </>
    );
  }

  const t = preview.totals || {};
  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Found <strong>{plural(t.found ?? rows.length, 'appointment')}</strong>
        {t.upcoming != null && <>: {t.upcoming} upcoming</>}
        {t.past ? <>, {t.past} already happened</> : null}
        {t.duplicates ? <>, {t.duplicates} already in Ivy</> : null}.
        Untick anything that is not a client appointment.
      </p>
      <ReviewList rows={rows} selected={selected} setSelected={setSelected}/>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '8px 0 12px', lineHeight: 1.5 }}>
        Only the next 12 months come in. Greyed out rows are skipped.
      </div>
      <QuietNote style={{ marginBottom: 12 }}/>
      {err && <Note tone="err" style={{ marginBottom: 12 }}>{err}</Note>}
      <ImportButton count={selected.size} busy={busy} onClick={submit}/>
    </>
  );
}

// ── Google Calendar ──────────────────────────────────────────────────

export function GoogleImport({ onDone }) {
  const [status, setStatus] = useState(null);      // { configured, connected }
  const [events, setEvents] = useState(null);
  const [edits, setEdits] = useState({});
  const [services, setServices] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await api.get('/calendar/google/status').catch(() => ({ configured: false, connected: false }));
        if (!live) return;
        setStatus(st);
        if (!st.connected) return;
        const [r, cal] = await Promise.all([
          api.get('/import/google-events?days=90'),
          api.get('/calendar?only=setup').catch(() => null),
        ]);
        if (!live) return;
        if (r && r.connected === false) { setStatus({ ...st, connected: false }); return; }
        const list = Array.isArray(r?.events) ? r.events : [];
        setEvents(list);
        setServices((cal?.calendar?.services || []).map((s) => ({ id: s.id, name: s.name })));
        // Preselect what looks like a client appointment: not all-day, not
        // already in Ivy, and Ivy found a client name (a bare "Dentist" is not).
        setSelected(new Set(list.filter((e) => !e.alreadyInIvy && !e.allDay && (e.clientName || '').trim()).slice(0, GOOGLE_MAX).map((e) => e.id)));
      } catch (e) {
        if (live) setErr(e.message || 'Could not load your Google Calendar.');
      }
    })();
    return () => { live = false; };
  }, []);

  const connect = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.get('/calendar/google/connect');
      if (!r.url) throw new Error('Could not start connecting Google.');
      window.location.href = r.url;
    } catch (e) { setErr(e.message || 'Could not start connecting Google.'); setBusy(false); }
  };

  const rows = useMemo(() => (events || []).map((e) => {
    const ed = edits[e.id] || {};
    return {
      key: e.id, start: e.start, allDay: !!e.allDay,
      client: ed.client !== undefined ? ed.client : (e.clientName || ''),
      serviceId: ed.serviceId !== undefined ? ed.serviceId : (e.serviceId || null),
      title: e.title || '',
      email: e.clientEmail || '',
      disabled: !!e.alreadyInIvy,
      reason: e.alreadyInIvy ? 'Already in Ivy' : e.allDay ? 'All day' : (e.title && e.title !== e.clientName ? e.title : ''),
    };
  }), [events, edits]);

  const onEdit = (key, patch) => setEdits((m) => ({ ...m, [key]: { ...m[key], ...patch } }));
  const chosen = rows.filter((r) => selected.has(r.key));
  const missingName = chosen.filter((r) => !r.client.trim()).length;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {
        events: chosen.slice(0, GOOGLE_MAX).map((r) => ({
          id: r.key,
          clientName: r.client.trim().slice(0, 120),
          ...(r.email ? { clientEmail: r.email } : {}),
          ...(r.serviceId ? { serviceId: r.serviceId } : {}),
        })),
      };
      const r = await api.post('/import/google-events', body);
      onDone({ kind: 'bookings', created: r.created || 0, skipped: r.skipped || 0, missingEmail: r.missingEmail || [] });
    } catch (e) {
      setErr(e.message || 'Import failed. Nothing was added.');
    } finally { setBusy(false); }
  };

  if (!status) return <div style={{ fontSize: 13, color: 'var(--muted)', padding: 12 }}>Checking Google Calendar…</div>;

  if (!status.connected) {
    return (
      <>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Connect your Google Calendar and Ivy lists your upcoming events. You pick which ones are client
          appointments, and they become bookings in Ivy.
        </p>
        {status.configured === false ? (
          <Note>Google Calendar is not available on this account yet. You can upload a calendar file instead.</Note>
        ) : (
          <>
            <button type="button" onClick={connect} disabled={busy} className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '12px 14px' }}>
              <Icons.Calendar size={15}/> {busy ? 'Opening Google…' : 'Connect Google Calendar'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
              After connecting you land on your Calendar. Come back to Clients, Import, to pick your appointments.
            </div>
          </>
        )}
        {err && <Note tone="err" style={{ marginTop: 12 }}>{err}</Note>}
      </>
    );
  }

  if (!events) {
    return err
      ? <Note tone="err">{err}</Note>
      : <div style={{ fontSize: 13, color: 'var(--muted)', padding: 12 }}>Loading your next 90 days…</div>;
  }

  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Your next 90 days from Google Calendar. Tick the client appointments, and fix a name or pick the
        service if Ivy guessed wrong. They stay on your Google Calendar too, without doubling up.
      </p>
      <ReviewList rows={rows} selected={selected} setSelected={setSelected} editable services={services} onEdit={onEdit}/>
      {selected.size > GOOGLE_MAX && (
        <Note tone="warn" style={{ marginTop: 10 }}>You can add up to {GOOGLE_MAX} at a time. The first {GOOGLE_MAX} go in now.</Note>
      )}
      <QuietNote style={{ margin: '12px 0' }}/>
      {missingName > 0 && (
        <Note tone="warn" style={{ marginBottom: 12 }}>Add a client name to {plural(missingName, 'selected appointment')} to continue.</Note>
      )}
      {err && <Note tone="err" style={{ marginBottom: 12 }}>{err}</Note>}
      <ImportButton count={Math.min(selected.size, GOOGLE_MAX)} busy={busy} onClick={submit} disabled={missingName > 0}/>
    </>
  );
}
