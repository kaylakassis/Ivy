// Real calendar: business view (manage) + public booking page (read/book).
// Shared state lives in localStorage so edits in the business view instantly reflect in the public link.

const CAL_STATE_KEY = 'Ivy OS:calendar';

function loadCal() {
  try { return JSON.parse(localStorage.getItem(CAL_STATE_KEY)) || defaultCal(); }
  catch { return defaultCal(); }
}
function saveCal(s) { localStorage.setItem(CAL_STATE_KEY, JSON.stringify(s)); }

function defaultCal() {
  return {
    bizName: 'Your business',
    slug: 'your-business',
    services: [
      { id: 's1', name: 'Intro session',    dur: 45, price: 45 },
      { id: 's2', name: 'Standard session', dur: 60, price: 85 },
      { id: 's3', name: 'Full assessment',  dur: 90, price: 140 },
    ],
    // availability: weekday 0..6 (Sun..Sat) -> array of { start, end } (minutes from 00:00)
    availability: {
      0: [],
      1: [{ start: 9*60,  end: 17*60 }],
      2: [{ start: 9*60,  end: 17*60 }],
      3: [{ start: 9*60,  end: 17*60 }],
      4: [{ start: 9*60,  end: 17*60 }],
      5: [{ start: 9*60,  end: 14*60 }],
      6: [],
    },
    // blocks: array of { dateISO, start, end, label }
    blocks: [],
    // bookings: array of { dateISO, start, end, serviceId, clientName, clientEmail, createdAt }
    bookings: [],
    slotMinutes: 30, // granularity
    bufferMin: 0,
  };
}

/* ========== helpers ========== */
function minToHM(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${mm.toString().padStart(2,'0')} ${ap}`;
}
function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}
function fmtDateISO(d) {
  return d.toISOString().slice(0,10);
}
function parseISO(s) {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}
function startOfWeek(d) {
  const r = new Date(d); r.setHours(0,0,0,0);
  const day = r.getDay(); // 0 Sun
  const diff = (day + 6) % 7; // make Monday = 0
  r.setDate(r.getDate() - diff);
  return r;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate()+n); return r; }
const WEEKDAYS_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WEEKDAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// All slots for a given date given cal state, returns { start, end, available, reason }
function slotsForDate(cal, date, serviceDur) {
  const dayIdx = date.getDay();
  const dateISO = fmtDateISO(date);
  const windows = cal.availability[dayIdx] || [];
  const dur = serviceDur || 60;
  const step = cal.slotMinutes;
  const slots = [];
  windows.forEach(w => {
    for (let t = w.start; t + dur <= w.end; t += step) {
      const start = t, end = t + dur;
      let reason = null;
      // check blocks
      (cal.blocks || []).forEach(b => {
        if (b.dateISO === dateISO && !(end <= b.start || start >= b.end)) reason = 'Blocked';
      });
      // check bookings
      (cal.bookings || []).forEach(bk => {
        if (bk.dateISO === dateISO && !(end <= bk.start || start >= bk.end)) reason = 'Booked';
      });
      slots.push({ start, end, available: !reason, reason });
    }
  });
  return slots;
}

/* ========== BUSINESS CALENDAR ========== */
function CalendarView() {
  const [cal, setCal] = React.useState(loadCal);
  const [anchor, setAnchor] = React.useState(() => startOfWeek(new Date()));
  const [drawer, setDrawer] = React.useState(null); // 'availability' | 'share' | 'event' | null
  const [selectedEvent, setSelectedEvent] = React.useState(null);

  const update = (next) => { setCal(next); saveCal(next); };

  // Listen for changes from other tabs (public link)
  React.useEffect(() => {
    const onStorage = (e) => { if (e.key === CAL_STATE_KEY) setCal(loadCal()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const weekDays = Array.from({length:7}, (_,i) => addDays(anchor, i));
  const hours = Array.from({length: 11}, (_,i) => i + 8); // 8am..6pm
  const rowH = 52;

  const shareUrl = `${location.origin}${location.pathname}?book=${cal.slug}`;

  return (
    <div style={{ padding: '20px 32px 64px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => setAnchor(startOfWeek(new Date()))}>Today</button>
        <button className="btn btn-ghost" style={{ padding: 6 }} onClick={()=>setAnchor(addDays(anchor,-7))}>
          <Icons.Arrow size={14} style={{ transform:'rotate(180deg)' }}/>
        </button>
        <button className="btn btn-ghost" style={{ padding: 6 }} onClick={()=>setAnchor(addDays(anchor, 7))}>
          <Icons.Arrow size={14}/>
        </button>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}>
          {anchor.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – {addDays(anchor,6).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </h3>
        <div style={{ flex: 1 }} />
        <button className="btn btn-outline" onClick={()=>setDrawer('availability')}>
          <Icons.Clock size={14}/> Availability
        </button>
        <button className="btn btn-outline" onClick={()=>setDrawer('share')}>
          <Icons.Globe size={14}/> Share booking link
        </button>
        <button className="btn btn-primary" onClick={()=>{
          const today = fmtDateISO(new Date());
          setSelectedEvent({ kind: 'block', dateISO: today, start: 12*60, end: 13*60, label: '' });
          setDrawer('event');
        }}>
          <Icons.Plus size={14}/> Block time
        </button>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        <LegendDot color="var(--accent)" label="Booked" />
        <LegendDot color="var(--muted-2)" stripe label="Blocked" />
        <LegendDot color="transparent" bordered label="Available" />
      </div>

      {/* Grid */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7, 1fr)', borderBottom: '1px solid var(--border)' }}>
          <div/>
          {weekDays.map((d, i) => {
            const isToday = fmtDateISO(d) === fmtDateISO(new Date());
            return (
              <div key={i} style={{
                padding: '10px 10px', borderLeft: '1px solid var(--border)',
                background: isToday ? 'var(--accent-soft)' : 'transparent',
              }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {WEEKDAYS_SHORT[d.getDay()]}
                </div>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500,
                  color: isToday ? 'var(--accent)' : 'var(--fg)', marginTop: 2,
                }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7, 1fr)', position: 'relative' }}>
          <div>
            {hours.map((h) => (
              <div key={h} style={{ height: rowH, padding: '2px 8px', fontSize: 10, color: 'var(--muted)', textAlign: 'right' }}>
                {minToHM(h*60)}
              </div>
            ))}
          </div>
          {weekDays.map((day, di) => {
            const dateISO = fmtDateISO(day);
            const dayIdx = day.getDay();
            const avail = cal.availability[dayIdx] || [];
            return (
              <div key={di} style={{ borderLeft: '1px solid var(--border)', position: 'relative', height: rowH * hours.length }}>
                {hours.map((h, i) => (
                  <div key={i} style={{ height: rowH, borderTop: i ? '1px solid var(--border)' : 'none' }} />
                ))}
                {/* availability bands */}
                {avail.map((w, wi) => {
                  const top = ((w.start - hours[0]*60) / 60) * rowH;
                  const h   = ((w.end - w.start) / 60) * rowH;
                  if (h <= 0) return null;
                  return <div key={'av'+wi} style={{
                    position: 'absolute', top: Math.max(0, top), height: Math.min(hours.length*rowH - Math.max(0,top), h),
                    left: 2, right: 2,
                    background: 'color-mix(in srgb, var(--ok) 7%, transparent)',
                    borderLeft: '2px solid color-mix(in srgb, var(--ok) 55%, transparent)',
                    pointerEvents: 'none',
                  }}/>;
                })}
                {/* blocks */}
                {(cal.blocks||[]).filter(b=>b.dateISO===dateISO).map((b, bi) => {
                  const top = ((b.start - hours[0]*60) / 60) * rowH;
                  const h   = ((b.end - b.start) / 60) * rowH;
                  return <div key={'bl'+bi} onClick={()=>{ setSelectedEvent({ ...b, kind:'block', idx: bi }); setDrawer('event'); }}
                    style={{
                      position: 'absolute', top, height: h, left: 4, right: 4,
                      background: 'repeating-linear-gradient(-45deg, var(--surface-2) 0 6px, color-mix(in srgb, var(--muted) 25%, var(--surface-2)) 6px 12px)',
                      border: '1px solid var(--border-strong)', borderRadius: 6,
                      padding: '4px 6px', fontSize: 11, color: 'var(--fg-2)', cursor: 'pointer', overflow: 'hidden',
                    }}>
                    <div style={{ fontWeight: 600 }}>{b.label || 'Blocked'}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 10 }}>{minToHM(b.start)} – {minToHM(b.end)}</div>
                  </div>;
                })}
                {/* bookings */}
                {(cal.bookings||[]).filter(b=>b.dateISO===dateISO).map((b, bi) => {
                  const top = ((b.start - hours[0]*60) / 60) * rowH;
                  const h   = ((b.end - b.start) / 60) * rowH;
                  const svc = cal.services.find(s => s.id === b.serviceId);
                  return <div key={'bk'+bi} onClick={()=>{ setSelectedEvent({ ...b, kind:'booking', idx: bi }); setDrawer('event'); }}
                    style={{
                      position: 'absolute', top, height: h, left: 4, right: 4,
                      background: 'var(--accent)', color: 'var(--accent-ink)',
                      border: '1px solid var(--accent)', borderRadius: 6,
                      padding: '4px 7px', fontSize: 11, cursor: 'pointer', overflow: 'hidden',
                      boxShadow: '0 2px 6px color-mix(in srgb, var(--accent) 30%, transparent)',
                    }}>
                    <div style={{ fontWeight: 600 }}>{b.clientName || 'Client'}</div>
                    <div style={{ fontSize: 10, opacity: 0.8 }}>{svc?.name || 'Session'} · {minToHM(b.start)}</div>
                  </div>;
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Upcoming list */}
      <div style={{ marginTop: 28 }}>
        <h3 style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, marginBottom: 10 }}>
          Upcoming bookings
        </h3>
        {cal.bookings.length === 0 ? (
          <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No bookings yet. Share your link and watch them fill in.
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {cal.bookings.slice().sort((a,b) => (a.dateISO+a.start).localeCompare(b.dateISO+b.start)).map((b, i) => {
              const svc = cal.services.find(s => s.id === b.serviceId);
              const d = parseISO(b.dateISO);
              return (
                <div key={i} style={{
                  padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{
                    width: 44, height: 48, borderRadius: 8, background: 'var(--accent-soft)',
                    color: 'var(--accent)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    lineHeight: 1.1, fontWeight: 600,
                  }}>
                    <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {d.toLocaleDateString('en-US',{ month:'short' })}
                    </span>
                    <span style={{ fontSize: 18, fontFamily: 'var(--font-display)' }}>{d.getDate()}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{b.clientName}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {svc?.name} · {minToHM(b.start)} – {minToHM(b.end)} · {b.clientEmail}
                    </div>
                  </div>
                  <button className="btn btn-ghost" style={{ color:'var(--danger)', fontSize: 12 }}
                    onClick={()=>update({ ...cal, bookings: cal.bookings.filter((_,j)=>j!==i) })}>
                    Cancel
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drawers */}
      {drawer === 'availability' && (
        <AvailabilityDrawer cal={cal} onSave={(next)=>{ update(next); setDrawer(null); }} onClose={()=>setDrawer(null)} />
      )}
      {drawer === 'share' && (
        <ShareDrawer cal={cal} shareUrl={shareUrl} onChangeSlug={(slug)=>update({ ...cal, slug })}
          onChangeName={(bizName)=>update({ ...cal, bizName })}
          onClose={()=>setDrawer(null)} />
      )}
      {drawer === 'event' && selectedEvent && (
        <EventDrawer event={selectedEvent} cal={cal}
          onSave={(ev) => {
            if (ev.kind === 'block') {
              const blocks = [...(cal.blocks||[])];
              if (ev.idx != null) blocks[ev.idx] = { dateISO: ev.dateISO, start: ev.start, end: ev.end, label: ev.label };
              else blocks.push({ dateISO: ev.dateISO, start: ev.start, end: ev.end, label: ev.label });
              update({ ...cal, blocks });
            }
            setDrawer(null); setSelectedEvent(null);
          }}
          onDelete={(ev) => {
            if (ev.kind === 'block' && ev.idx != null) {
              update({ ...cal, blocks: cal.blocks.filter((_,j)=>j!==ev.idx) });
            } else if (ev.kind === 'booking' && ev.idx != null) {
              update({ ...cal, bookings: cal.bookings.filter((_,j)=>j!==ev.idx) });
            }
            setDrawer(null); setSelectedEvent(null);
          }}
          onClose={() => { setDrawer(null); setSelectedEvent(null); }} />
      )}
    </div>
  );
}

function LegendDot({ color, label, stripe, bordered }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 10, height: 10, borderRadius: 3,
        background: stripe
          ? 'repeating-linear-gradient(-45deg, var(--surface-2) 0 3px, var(--border-strong) 3px 6px)'
          : color,
        border: bordered ? '1px solid var(--border-strong)' : 'none',
      }}/>
      {label}
    </span>
  );
}

/* ========== DRAWERS ========== */
function Drawer({ title, subtitle, onClose, children, width = 440 }) {
  return (
    <>
      <div onClick={onClose} style={{
        position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex: 95,
      }}/>
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width,
        background: 'var(--surface)', borderLeft: '1px solid var(--border)',
        zIndex: 100, display: 'flex', flexDirection: 'column',
        boxShadow: '-20px 0 40px -12px rgba(0,0,0,0.2)',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 500, letterSpacing: '-0.015em' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {children}
        </div>
      </div>
    </>
  );
}

function AvailabilityDrawer({ cal, onSave, onClose }) {
  const [avail, setAvail] = React.useState(cal.availability);
  const setDay = (day, windows) => setAvail({ ...avail, [day]: windows });

  return (
    <Drawer title="Weekly availability" subtitle="Clients can only book inside these hours" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {[1,2,3,4,5,6,0].map(d => (
          <DayAvailabilityRow key={d} dayIdx={d} windows={avail[d]||[]} onChange={(w)=>setDay(d,w)} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 22, position: 'sticky', bottom: 0 }}>
        <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
        <button className="btn btn-primary" onClick={()=>onSave({ ...cal, availability: avail })} style={{ flex: 2, justifyContent: 'center' }}>
          Save availability
        </button>
      </div>
    </Drawer>
  );
}

function DayAvailabilityRow({ dayIdx, windows, onChange }) {
  const on = windows.length > 0;
  return (
    <div style={{
      padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 14, minWidth: 90 }}>{WEEKDAYS_LONG[dayIdx]}</div>
        <button onClick={()=> on ? onChange([]) : onChange([{ start: 9*60, end: 17*60 }])}
          style={{
            width: 38, height: 22, borderRadius: 99,
            background: on ? 'var(--accent)' : 'var(--surface-2)',
            border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
            position: 'relative',
          }}>
          <span style={{
            position: 'absolute', top: 2, left: on ? 18 : 2,
            width: 16, height: 16, borderRadius: 99, background: on ? 'var(--accent-ink)' : '#fff',
          }}/>
        </button>
        <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
          {on ? windows.map(w => `${minToHM(w.start)}–${minToHM(w.end)}`).join(', ') : 'Unavailable'}
        </span>
        {on && (
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={()=>onChange([...windows, { start: 14*60, end: 17*60 }])}>+ Add window</button>
        )}
      </div>
      {on && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {windows.map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TimeInput minutes={w.start} onChange={(v)=>onChange(windows.map((x,j)=>j===i?{...x,start:v}:x))} />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
              <TimeInput minutes={w.end} onChange={(v)=>onChange(windows.map((x,j)=>j===i?{...x,end:v}:x))} />
              {windows.length > 1 && (
                <button className="btn btn-ghost" style={{ padding: 4, color: 'var(--danger)' }}
                  onClick={()=>onChange(windows.filter((_,j)=>j!==i))}><Icons.X size={14}/></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimeInput({ minutes, onChange }) {
  const val = `${Math.floor(minutes/60).toString().padStart(2,'0')}:${(minutes%60).toString().padStart(2,'0')}`;
  return (
    <input type="time" value={val} onChange={(e)=>onChange(hmToMin(e.target.value))}
      style={{
        padding: '6px 10px', borderRadius: 8, background: 'var(--surface-2)',
        border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 13, outline: 'none',
      }}/>
  );
}

function ShareDrawer({ cal, shareUrl, onChangeSlug, onChangeName, onClose }) {
  const [copied, setCopied] = React.useState(false);
  const [showPreview, setShowPreview] = React.useState(false);
  const copy = () => {
    navigator.clipboard.writeText(shareUrl).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false), 1500); });
  };
  return (
    <Drawer title="Share booking link" subtitle="Clients can book into your calendar from this page." onClose={onClose}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>Business name</div>
        <input value={cal.bizName} onChange={e=>onChangeName(e.target.value)} style={inputSty}/>
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>Your handle</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface)',
          overflow: 'hidden',
        }}>
          <span style={{ padding: '10px 12px', background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 13 }}>
            ivy.co/
          </span>
          <input value={cal.slug} onChange={e=>onChangeSlug(e.target.value.replace(/[^a-z0-9-]/gi,'').toLowerCase())}
            style={{ flex: 1, padding: '10px 12px', background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 14 }}/>
        </div>
      </div>

      <div style={{
        padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
        marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 6 }}>
          Shareable link
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12, color: 'var(--fg-2)',
          wordBreak: 'break-all',
        }}>
          <Icons.Globe size={14} stroke="var(--muted)" sw={1.6}/>
          <span style={{ flex: 1, minWidth: 0 }}>{shareUrl}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary" onClick={copy} style={{ flex: 1, justifyContent: 'center' }}>
            {copied ? <><Icons.Check size={14} sw={2.2}/> Copied</> : <><Icons.Doc size={14}/> Copy link</>}
          </button>
          <button className="btn btn-outline" onClick={()=>setShowPreview(true)}>
            <Icons.Arrow size={14}/> Preview
          </button>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Anyone with the link can see your available slots and book - they can't see your other bookings, clients, or notes.
        As clients book and you update your availability, the page updates in real time.
      </div>

      {showPreview && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.6)', zIndex: 110,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={()=>setShowPreview(false)}>
          <div className="card" style={{
            width: '100%', maxWidth: 880, maxHeight: '92vh', overflow: 'auto', padding: 0,
          }} onClick={e=>e.stopPropagation()}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icons.Globe size={14} stroke="var(--muted)"/>
              <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>{shareUrl}</span>
              <div style={{ flex: 1 }}/>
              <button className="btn btn-ghost" onClick={()=>setShowPreview(false)} style={{ padding: 6 }}><Icons.X size={16}/></button>
            </div>
            <PublicBookingPage cal={cal} isPreview />
          </div>
        </div>
      )}
    </Drawer>
  );
}

function EventDrawer({ event, cal, onSave, onDelete, onClose }) {
  const [draft, setDraft] = React.useState(event);
  const isBooking = event.kind === 'booking';
  const svc = isBooking ? cal.services.find(s => s.id === event.serviceId) : null;

  if (isBooking) {
    return (
      <Drawer title="Booking details" onClose={onClose}>
        <InfoRow label="Client"  value={event.clientName} />
        <InfoRow label="Email"   value={event.clientEmail} />
        <InfoRow label="Service" value={svc?.name} />
        <InfoRow label="Date"    value={parseISO(event.dateISO).toLocaleDateString('en-US',{ weekday:'long', month:'long', day:'numeric'})} />
        <InfoRow label="Time"    value={`${minToHM(event.start)} – ${minToHM(event.end)}`} />
        <InfoRow label="Price"   value={`$${svc?.price}`} />
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Close</button>
          <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center', background:'var(--danger)', color:'#fff' }}
            onClick={()=>onDelete(event)}>Cancel booking</button>
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer title={event.idx != null ? 'Edit blocked time' : 'Block time'} subtitle="Clients can't book during blocked periods." onClose={onClose}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Reason (optional)</div>
        <input value={draft.label||''} onChange={e=>setDraft({ ...draft, label: e.target.value })} placeholder="Lunch, personal, vacation…" style={inputSty}/>
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Date</div>
        <input type="date" value={draft.dateISO} onChange={e=>setDraft({ ...draft, dateISO: e.target.value })} style={inputSty}/>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Start</div>
          <TimeInput minutes={draft.start} onChange={(v)=>setDraft({ ...draft, start: v })}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>End</div>
          <TimeInput minutes={draft.end} onChange={(v)=>setDraft({ ...draft, end: v })}/>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        {event.idx != null && (
          <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={()=>onDelete(event)}>Delete</button>
        )}
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={()=>onSave(draft)}>Save</button>
      </div>
    </Drawer>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'flex' }}>
      <div style={{ width: 100, fontSize: 12, color: 'var(--muted)' }}>{label}</div>
      <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

const inputSty = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};

/* ========== PUBLIC BOOKING PAGE ========== */
function PublicBookingPage({ cal: propCal, isPreview }) {
  const [cal, setCal] = React.useState(propCal || loadCal);
  const [serviceId, setServiceId] = React.useState((propCal || loadCal()).services[0]?.id);
  const [weekAnchor, setWeekAnchor] = React.useState(() => startOfWeek(new Date()));
  const [slot, setSlot] = React.useState(null); // { dateISO, start, end }
  const [step, setStep] = React.useState('pick'); // pick | details | confirmed
  const [clientName, setClientName] = React.useState('');
  const [clientEmail, setClientEmail] = React.useState('');

  // live updates
  React.useEffect(() => {
    if (propCal) return;
    const onStorage = (e) => { if (e.key === CAL_STATE_KEY) setCal(loadCal()); };
    window.addEventListener('storage', onStorage);
    const id = setInterval(() => setCal(loadCal()), 1500);
    return () => { window.removeEventListener('storage', onStorage); clearInterval(id); };
  }, [propCal]);

  const svc = cal.services.find(s => s.id === serviceId);
  const weekDays = Array.from({length: 7}, (_,i) => addDays(weekAnchor, i));

  const book = () => {
    const next = {
      ...cal,
      bookings: [...(cal.bookings||[]), {
        dateISO: slot.dateISO, start: slot.start, end: slot.end,
        serviceId: svc.id, clientName, clientEmail,
        createdAt: new Date().toISOString(),
      }],
    };
    saveCal(next); setCal(next); setStep('confirmed');
  };

  const pageStyle = {
    background: 'var(--page)', color: 'var(--fg)', padding: isPreview ? '28px 32px 40px' : '40px 24px 80px',
    minHeight: isPreview ? 0 : '100vh',
  };

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, background: 'var(--accent)',
            color: 'var(--accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22,
          }}>{cal.bizName?.[0]?.toUpperCase() || 'T'}</div>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              Book an appointment
            </div>
            <h1 style={{
              margin: '4px 0 0', fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 28,
              letterSpacing: '-0.025em',
            }}>{cal.bizName}</h1>
          </div>
        </div>

        {step === 'confirmed' ? (
          <div className="card" style={{ padding: 36, textAlign: 'center' }}>
            <div style={{
              width: 56, height: 56, borderRadius: 99, background: 'var(--ok)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
            }}><Icons.Check size={26} sw={2.4}/></div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 24, letterSpacing: '-0.02em', margin: '0 0 8px' }}>
              You're booked.
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0, lineHeight: 1.5 }}>
              A confirmation is on its way to <b style={{ color:'var(--fg-2)' }}>{clientEmail}</b>. See you on{' '}
              <b style={{ color:'var(--fg-2)' }}>{parseISO(slot.dateISO).toLocaleDateString('en-US',{ weekday:'long', month:'long', day:'numeric'})}</b>{' '}
              at <b style={{ color:'var(--fg-2)' }}>{minToHM(slot.start)}</b>.
            </p>
          </div>
        ) : step === 'details' ? (
          <div className="card" style={{ padding: 28 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Confirm</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 18 }}>
              {svc?.name} · {parseISO(slot.dateISO).toLocaleDateString('en-US',{ weekday:'long', month:'long', day:'numeric'})} · {minToHM(slot.start)}
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Your name</div>
              <input value={clientName} onChange={e=>setClientName(e.target.value)} style={inputSty} placeholder="Ana Beltrán"/>
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Email</div>
              <input value={clientEmail} onChange={e=>setClientEmail(e.target.value)} style={inputSty} placeholder="you@email.com"/>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={()=>setStep('pick')}>← Back</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
                disabled={!clientName.trim() || !clientEmail.trim()} onClick={book}>
                Confirm booking
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Service picker */}
            <div className="card" style={{ padding: 18, marginBottom: 18 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, marginBottom: 12 }}>
                Choose a service
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                {cal.services.map(s => (
                  <button key={s.id} onClick={()=>setServiceId(s.id)} style={{
                    padding: 12, borderRadius: 10, textAlign: 'left',
                    background: serviceId === s.id ? 'var(--accent-soft)' : 'var(--surface-2)',
                    border: `1px solid ${serviceId === s.id ? 'var(--accent)' : 'var(--border)'}`,
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{s.dur} min · ${s.price}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Week */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 8 }}>
              <button className="btn btn-ghost" style={{ padding: 6 }} onClick={()=>setWeekAnchor(addDays(weekAnchor,-7))}>
                <Icons.Arrow size={14} style={{ transform:'rotate(180deg)' }}/>
              </button>
              <div style={{ flex: 1, textAlign: 'center', fontWeight: 500, fontSize: 14, color: 'var(--fg-2)' }}>
                {weekAnchor.toLocaleDateString('en-US',{ month:'long', day:'numeric' })} – {addDays(weekAnchor,6).toLocaleDateString('en-US',{ month:'short', day:'numeric' })}
              </div>
              <button className="btn btn-ghost" style={{ padding: 6 }} onClick={()=>setWeekAnchor(addDays(weekAnchor, 7))}>
                <Icons.Arrow size={14}/>
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 10 }}>
              {weekDays.map((d, i) => {
                const slots = svc ? slotsForDate(cal, d, svc.dur).filter(s => s.available) : [];
                const isPast = d < new Date(new Date().setHours(0,0,0,0));
                return (
                  <div key={i} className="card" style={{
                    padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
                    opacity: isPast ? 0.4 : 1,
                  }}>
                    <div style={{ textAlign: 'center', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {WEEKDAYS_SHORT[d.getDay()]}
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 500 }}>{d.getDate()}</div>
                    </div>
                    {isPast ? null : slots.length === 0 ? (
                      <div style={{ fontSize: 10, color: 'var(--muted-2)', textAlign: 'center', padding: '8px 0' }}>No slots</div>
                    ) : slots.slice(0, 8).map((s, si) => (
                      <button key={si} onClick={()=>{ setSlot({ dateISO: fmtDateISO(d), start: s.start, end: s.end }); setStep('details'); }}
                        style={{
                          padding: '6px 4px', borderRadius: 6, fontSize: 11, fontWeight: 550,
                          background: 'var(--surface-2)', border: '1px solid var(--border)',
                          color: 'var(--fg)', cursor: 'pointer',
                        }}>
                        {minToHM(s.start)}
                      </button>
                    ))}
                    {slots.length > 8 && (
                      <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>+{slots.length - 8} more</div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 20 }}>
              Times shown are in your local timezone · Free cancellation up to 24h before
            </div>
          </>
        )}
      </div>
    </div>
  );
}

window.CalendarView = CalendarView;
window.PublicBookingPage = PublicBookingPage;
