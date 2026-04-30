// Owner-side Calendar: weekly grid with availability bands, blocks, bookings.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useCalendar } from './state.js';
import {
  WEEKDAYS_SHORT, addDays, fmtDateISO, minToHM, parseISO, startOfWeek,
} from './utils.js';
import AvailabilityDrawer from './AvailabilityDrawer.jsx';
import ShareDrawer from './ShareDrawer.jsx';
import EventDrawer from './EventDrawer.jsx';
import ServicesDrawer from './ServicesDrawer.jsx';

export default function Calendar() {
  const {
    cal, loading, error,
    patchSettings, saveAvailability, saveServices,
    addBlock, updateBlock, removeBlock, cancelBooking,
  } = useCalendar();

  const [anchor, setAnchor]   = useState(() => startOfWeek(new Date()));
  const [drawer, setDrawer]   = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);

  if (loading) {
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading your calendar…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Calendar" title="Couldn't load calendar" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  const hours    = Array.from({ length: 11 }, (_, i) => i + 8); // 8am–6pm
  const rowH     = 52;
  const todayISO = fmtDateISO(new Date());

  const upcoming = (cal.bookings || [])
    .filter((b) => b.date >= todayISO)
    .sort((a, b) => (a.date + String(a.startMin).padStart(4, '0'))
      .localeCompare(b.date + String(b.startMin).padStart(4, '0')));

  return (
    <div style={{ padding: '20px 32px 64px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => setAnchor(startOfWeek(new Date()))}>Today</button>
        <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setAnchor(addDays(anchor, -7))}>
          <Icons.Arrow size={14} style={{ transform: 'rotate(180deg)' }}/>
        </button>
        <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setAnchor(addDays(anchor, 7))}>
          <Icons.Arrow size={14}/>
        </button>
        <h3 className="page-title" style={{ margin: 0, fontSize: 22 }}>
          {anchor.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
          {' – '}
          {addDays(anchor, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </h3>
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={() => setDrawer('services')}>
          <Icons.Dollar size={14}/> Services
        </button>
        <button className="btn btn-outline" onClick={() => setDrawer('availability')}>
          <Icons.Clock size={14}/> Availability
        </button>
        <button className="btn btn-outline" onClick={() => setDrawer('share')}>
          <Icons.Globe size={14}/> Share booking link
        </button>
        <button className="btn btn-primary" onClick={() => {
          setSelectedEvent({ kind: 'block', date: todayISO, startMin: 12 * 60, endMin: 13 * 60, label: '' });
          setDrawer('event');
        }}>
          <Icons.Plus size={14}/> Block time
        </button>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        <Legend color="var(--accent)" label="Booked"/>
        <Legend stripe label="Blocked"/>
        <Legend bordered label="Available"/>
      </div>

      {/* Grid */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7, 1fr)', borderBottom: '1px solid var(--border)' }}>
          <div/>
          {weekDays.map((d, i) => {
            const isToday = fmtDateISO(d) === todayISO;
            return (
              <div key={i} style={{
                padding: '10px 10px', borderLeft: '1px solid var(--border)',
                background: isToday ? 'var(--accent-soft)' : 'transparent',
              }}>
                <div className="metric-label" style={{ fontSize: 11 }}>{WEEKDAYS_SHORT[d.getDay()]}</div>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500,
                  color: isToday ? 'var(--accent)' : 'var(--fg)', marginTop: 2,
                }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7, 1fr)' }}>
          <div>
            {hours.map((h) => (
              <div key={h} style={{ height: rowH, padding: '2px 8px', fontSize: 10, color: 'var(--muted)', textAlign: 'right' }}>
                {minToHM(h * 60)}
              </div>
            ))}
          </div>
          {weekDays.map((day, di) => {
            const dateISO = fmtDateISO(day);
            const dayIdx = day.getDay();
            const avail = (cal.settings.availability && cal.settings.availability[String(dayIdx)]) || [];
            return (
              <div key={di} style={{
                borderLeft: '1px solid var(--border)', position: 'relative',
                height: rowH * hours.length, cursor: 'pointer',
              }}
                onClick={(e) => {
                  // Click empty area to add a block; ignore clicks bubbling from existing items.
                  if (e.currentTarget !== e.target) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = e.clientY - rect.top;
                  const startMin = hours[0] * 60 + Math.floor(y / rowH) * 30;
                  setSelectedEvent({ kind: 'block', date: dateISO, startMin, endMin: startMin + 60, label: '' });
                  setDrawer('event');
                }}
              >
                {hours.map((h, i) => (
                  <div key={i} style={{ height: rowH, borderTop: i ? '1px solid var(--border)' : 'none', pointerEvents: 'none' }}/>
                ))}
                {/* availability bands */}
                {avail.map((w, wi) => {
                  const top = ((w.start - hours[0] * 60) / 60) * rowH;
                  const h   = ((w.end - w.start) / 60) * rowH;
                  if (h <= 0) return null;
                  return (
                    <div key={'av' + wi} style={{
                      position: 'absolute', top: Math.max(0, top), height: Math.min(hours.length * rowH - Math.max(0, top), h),
                      left: 2, right: 2, pointerEvents: 'none',
                      background: 'color-mix(in srgb, var(--ok) 7%, transparent)',
                      borderLeft: '2px solid color-mix(in srgb, var(--ok) 55%, transparent)',
                    }}/>
                  );
                })}
                {/* blocks */}
                {(cal.blocks || []).filter((b) => b.date === dateISO).map((b) => {
                  const top = ((b.startMin - hours[0] * 60) / 60) * rowH;
                  const h   = ((b.endMin - b.startMin) / 60) * rowH;
                  return (
                    <div key={b.id} onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEvent({ kind: 'block', ...b });
                      setDrawer('event');
                    }} style={{
                      position: 'absolute', top, height: h, left: 4, right: 4,
                      background: 'repeating-linear-gradient(-45deg, var(--surface-2) 0 6px, var(--border-strong) 6px 12px)',
                      border: '1px solid var(--border-strong)', borderRadius: 6,
                      padding: '4px 6px', fontSize: 11, color: 'var(--fg-2)', cursor: 'pointer', overflow: 'hidden',
                    }}>
                      <div style={{ fontWeight: 600 }}>{b.label || 'Blocked'}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 10 }}>
                        {minToHM(b.startMin)} – {minToHM(b.endMin)}
                      </div>
                    </div>
                  );
                })}
                {/* bookings */}
                {(cal.bookings || []).filter((b) => b.date === dateISO).map((b) => {
                  const top = ((b.startMin - hours[0] * 60) / 60) * rowH;
                  const h   = ((b.endMin - b.startMin) / 60) * rowH;
                  const svc = cal.services.find((s) => s.id === b.serviceId);
                  return (
                    <div key={b.id} onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEvent({ kind: 'booking', ...b });
                      setDrawer('event');
                    }} style={{
                      position: 'absolute', top, height: h, left: 4, right: 4,
                      background: 'var(--accent)', color: 'var(--accent-ink)',
                      border: '1px solid var(--accent)', borderRadius: 6,
                      padding: '4px 7px', fontSize: 11, cursor: 'pointer', overflow: 'hidden',
                    }}>
                      <div style={{ fontWeight: 600 }}>{b.clientName || 'Client'}</div>
                      <div style={{ fontSize: 10, opacity: 0.8 }}>
                        {svc?.name || 'Session'} · {minToHM(b.startMin)}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Upcoming */}
      <div style={{ marginTop: 28 }}>
        <div className="metric-label" style={{ marginBottom: 10 }}>Upcoming bookings</div>
        {upcoming.length === 0 ? (
          <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No upcoming bookings yet. Share your link and watch them fill in.
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {upcoming.map((b, i) => {
              const svc = cal.services.find((s) => s.id === b.serviceId);
              const d = parseISO(b.date);
              return (
                <div key={b.id} style={{
                  padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{
                    width: 44, height: 48, borderRadius: 8,
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    lineHeight: 1.1, fontWeight: 600,
                  }}>
                    <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {d.toLocaleDateString('en-US', { month: 'short' })}
                    </span>
                    <span style={{ fontSize: 18, fontFamily: 'var(--font-display)' }}>{d.getDate()}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{b.clientName}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {svc?.name || 'Session'} · {minToHM(b.startMin)} – {minToHM(b.endMin)} · {b.clientEmail}
                    </div>
                  </div>
                  <button className="btn btn-ghost" style={{ color: 'var(--danger)', fontSize: 12 }}
                    onClick={() => cancelBooking(b.id)}>
                    Cancel
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drawers */}
      {drawer === 'services' && (
        <ServicesDrawer
          initial={cal.services}
          onSave={saveServices}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer === 'availability' && (
        <AvailabilityDrawer
          initial={cal.settings.availability}
          onSave={saveAvailability}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer === 'share' && (
        <ShareDrawer
          settings={cal.settings}
          onSave={patchSettings}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer === 'event' && selectedEvent && (
        <EventDrawer
          event={selectedEvent}
          services={cal.services}
          onSaveBlock={async (e) => {
            if (e.id) await updateBlock(e.id, { date: e.date, startMin: e.startMin, endMin: e.endMin, label: e.label });
            else await addBlock({ date: e.date, startMin: e.startMin, endMin: e.endMin, label: e.label });
          }}
          onDelete={async (e) => {
            if (e.kind === 'booking') await cancelBooking(e.id);
            else if (e.id) await removeBlock(e.id);
          }}
          onClose={() => { setDrawer(null); setSelectedEvent(null); }}
        />
      )}
    </div>
  );
}

function Legend({ color, stripe, bordered, label }) {
  let bg = color;
  if (stripe) bg = 'repeating-linear-gradient(-45deg, var(--surface-2) 0 3px, var(--border-strong) 3px 6px)';
  if (bordered) bg = 'transparent';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 10, height: 10, borderRadius: 3, background: bg,
        border: bordered ? '1px solid var(--border-strong)' : 'none',
      }}/>
      {label}
    </span>
  );
}
