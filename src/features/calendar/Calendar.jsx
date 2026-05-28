// Owner-side Calendar: Day / Week / Month views with shared toolbar.
import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useCalendar } from './state.js';
import { useViewport } from '../../lib/viewport.js';
import {
  WEEKDAYS_SHORT, addDays, fmtDateISO, minToHM, parseISO, startOfWeek,
  expandedBookings,
} from './utils.js';
import AvailabilityDrawer from './AvailabilityDrawer.jsx';
import ShareDrawer from './ShareDrawer.jsx';
import StaffDrawer from './StaffDrawer.jsx';
import SyncDrawer from './SyncDrawer.jsx';
import PackagesDrawer from './PackagesDrawer.jsx';
import EventDrawer from './EventDrawer.jsx';
import ServicesDrawer from './ServicesDrawer.jsx';
import AddBookingModal from './AddBookingModal.jsx';
import DayView from './DayView.jsx';
import MonthView from './MonthView.jsx';

const VIEW_KEY = 'thryve:calendar:view';

// Calendar sync (Google + iCal) is TABLED for now — we want owners using the
// THRYVE calendar as the source of truth. The drawer, endpoints, and adapter
// code are all kept intact; this flag just hides the entry points. Flip to
// true to bring the feature back.
const CALENDAR_SYNC_ENABLED = false;

export default function Calendar() {
  const { isMobile, isTablet } = useViewport();
  const [view, setView]     = useState(() => localStorage.getItem(VIEW_KEY) || 'week'); // 'day' | 'week' | 'month'
  // Anchor on TODAY (not the week's Monday) so day view opens on today and
  // week/month views still render the period containing today (both wrap
  // startOfWeek where needed). Refreshing the page lands you on the current
  // day, not the start of the week.
  const [anchor, setAnchor] = useState(() => new Date());

  // Compute the date window the current view actually renders, with
  // a ±1 week buffer so navigating one click forward/back doesn't
  // trigger a re-fetch. At scale (10K+ bookings per workspace) this
  // keeps the calendar payload bounded: ~50 bookings per week
  // visible vs the entire workspace history.
  const dataWindow = useMemo(() => {
    const days = view === 'day' ? 1 : view === 'week' ? 7 : 42; // month-grid is 6 weeks
    const start = new Date(anchor);
    start.setDate(start.getDate() - 7); // 1-week pre-buffer
    const end = new Date(anchor);
    end.setDate(end.getDate() + days + 7); // 1-week post-buffer
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(start), to: iso(end) };
  }, [view, anchor]);

  const {
    cal, loading, error, refresh,
    patchSettings, saveAvailability, saveServices,
    addBlock, updateBlock, removeBlock,
    createBooking, updateBooking, applyBooking, cancelBooking, cancelOccurrence,
    completeBooking, editCompletion, clearCompletion,
  } = useCalendar(dataWindow);

  // After a no-show / tip / fee charge (the drawer hits those endpoints
  // directly), merge the returned booking into state AND patch the open
  // drawer's event so its action buttons reflect the new state instead of
  // staying stale until reload.
  const onBookingChanged = (booking) => {
    applyBooking(booking);
    setSelectedEvent((ev) => (ev && ev.id === booking.id ? { ...ev, ...booking } : ev));
  };
  const [drawer, setDrawer] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [addBookingOpen, setAddBookingOpen] = useState(false);
  const [bookingDefaultClientId, setBookingDefaultClientId] = useState(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  // Deep link from ClientDrawer's "Book" button: ?newBooking=<clientId>
  // → open AddBookingModal with that client's name + email pre-filled.
  //
  // Also handles deep links from the Cmd+K search palette:
  //   ?booking=<bookingId>  → open that booking's drawer
  //   ?service=<serviceId>  → open services drawer (and highlight if needed)
  // Each param is stripped from the URL after consumption so a refresh
  // doesn't re-open the drawer.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const cid = params.get('newBooking');
    const bookingId = params.get('booking');
    const serviceId = params.get('service');

    if (cid) {
      setBookingDefaultClientId(cid);
      setAddBookingOpen(true);
      params.delete('newBooking');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
      return;
    }

    if (bookingId && Array.isArray(cal?.bookings)) {
      const b = cal.bookings.find((x) => x.id === bookingId);
      if (b) {
        // Match the shape EventDrawer expects (kind:'booking' + the
        // booking fields). cal.bookings rows already carry these via
        // the serializer.
        setSelectedEvent({ ...b, kind: 'booking' });
        setDrawer('event');
      }
      // Strip the param either way — if the booking isn't in the list
      // (cancelled, on a different visible range), we don't want the
      // effect to keep re-firing on every cal.bookings change.
      params.delete('booking');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
      return;
    }

    if (serviceId) {
      // Services moved to Finance → Services. Forward the deep-link
      // (notifications + tutorial CTAs may still arrive here) instead
      // of stranding the user on Calendar with no way to reach it.
      params.delete('service');
      const carry = params.toString();
      navigate(`/finance?section=services${carry ? '&' + carry : ''}`, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, cal?.bookings]);

  // Force day view on phones — the 7-column week grid is illegible on narrow
  // screens. Users can still pick week/month from the toggle if they want.
  useEffect(() => {
    if (isMobile && view === 'week') setView('day');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  // Staff filter for the calendar view. null = show all. Otherwise we
  // filter to bookings assigned to that specific staff id (use 'owner'
  // sentinel to show only unassigned-to-staff bookings).
  const [staffFilter, setStaffFilter] = useState(null);
  const [staffList, setStaffList] = useState([]);
  useEffect(() => {
    let cancelled = false;
    // Soft-fail: hide the filter pill if /api/staff isn't reachable.
    import('../../lib/api.js').then(({ api }) => {
      api.get('/staff').then((r) => {
        if (!cancelled) setStaffList(r.staff || []);
      }).catch(() => {});
    });
    return () => { cancelled = true; };
  }, []);

  // Expand recurring bookings into per-occurrence rows for the views to render.
  // The hook is stable as long as the bookings array reference doesn't change.
  const expanded = useMemo(() =>
    expandedBookings(cal.bookings || [], { daysBack: 14, daysAhead: 365 }),
    [cal.bookings],
  );
  // Apply the staff filter AFTER expansion so recurring bookings
  // assigned to a staff member still surface on the picked staff's view.
  const filtered = useMemo(() => {
    if (!staffFilter) return expanded;
    if (staffFilter === 'owner') return expanded.filter((b) => !b.staffId);
    return expanded.filter((b) => b.staffId === staffFilter);
  }, [expanded, staffFilter]);
  const calForViews = useMemo(() => ({ ...cal, bookings: filtered }), [cal, filtered]);

  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

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

  const todayISO = fmtDateISO(new Date());

  // Navigation step + range label depend on the active view.
  const nav = (delta) => {
    if (view === 'day')   setAnchor(addDays(anchor, delta));
    if (view === 'week')  setAnchor(addDays(anchor, delta * 7));
    if (view === 'month') {
      const d = new Date(anchor);
      d.setMonth(d.getMonth() + delta, 1);
      setAnchor(d);
    }
  };
  const goToday = () => {
    if (view === 'week') setAnchor(startOfWeek(new Date()));
    else setAnchor(new Date());
  };

  const rangeLabel = (() => {
    if (view === 'day') return anchor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (view === 'week') {
      const start = startOfWeek(anchor);
      return `${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${addDays(start, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    return anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  })();

  // Crossing views: keep something close to anchor.
  const switchView = (next) => {
    setView(next);
    if (next === 'week') setAnchor(startOfWeek(anchor));
  };

  const openEvent = (ev) => { setSelectedEvent(ev); setDrawer('event'); };

  const upcoming = (cal?.bookings || [])
    .filter((b) => b && b.date && b.date >= todayISO)
    .sort((a, b) => ((a.date || '') + String(a.startMin || 0).padStart(4, '0'))
      .localeCompare((b.date || '') + String(b.startMin || 0).padStart(4, '0')));

  const ViewToggle = () => (
    <div style={{
      display: 'flex', gap: 2, padding: 3,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 8,
    }}>
      {[
        { id: 'day',   label: 'Day' },
        { id: 'week',  label: 'Week' },
        { id: 'month', label: 'Month' },
      ].map((v) => {
        const on = view === v.id;
        return (
          <button key={v.id} onClick={() => switchView(v.id)}
            style={{
              padding: isMobile ? '6px 14px' : '5px 12px', borderRadius: 6,
              fontSize: 12, fontWeight: 550, cursor: 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              border: on ? '1px solid var(--border)' : '1px solid transparent',
            }}>
            {v.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="page-pad" style={{ paddingTop: isMobile ? 12 : 20 }}>
      {/* Toolbar */}
      {isMobile ? (
        // MOBILE: stacked rows so the controls don't overflow.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {/* Row 1: nav arrows + range label */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="btn btn-outline" onClick={goToday} style={{ padding: '7px 12px', fontSize: 12 }}>Today</button>
            <button className="btn btn-ghost" style={{ padding: 8 }} onClick={() => nav(-1)} aria-label="Previous">
              <Icons.Arrow size={14} style={{ transform: 'rotate(180deg)' }}/>
            </button>
            <button className="btn btn-ghost" style={{ padding: 8 }} onClick={() => nav(1)} aria-label="Next">
              <Icons.Arrow size={14}/>
            </button>
            <h3 className="page-title" style={{
              margin: 0, fontSize: 16, flex: 1, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{rangeLabel}</h3>
          </div>
          {/* Row 2: view toggle + actions menu + add */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ViewToggle/>
            <div style={{ flex: 1 }}/>
            <button className="btn btn-outline" onClick={() => setActionsOpen((o) => !o)}
              aria-label="Calendar settings"
              style={{ padding: 8, position: 'relative' }}>
              <Icons.More size={16}/>
            </button>
            <button className="btn btn-primary" onClick={() => setAddBookingOpen(true)}
              style={{ padding: 8 }} aria-label="New booking">
              <Icons.Plus size={16} sw={2.2}/>
            </button>
          </div>
          {actionsOpen && (
            <ActionSheet onClose={() => setActionsOpen(false)}
              onPick={(action) => {
                setActionsOpen(false);
                if (action === 'block') {
                  setSelectedEvent({ kind: 'block', date: todayISO, startMin: 12 * 60, endMin: 13 * 60, label: '', blocksBookings: true });
                  setDrawer('event');
                } else {
                  // services / staff / packages / availability / share / sync —
                  // the action id matches the drawer key. (Sync + Packages
                  // used to be listed but unhandled → tapping did nothing.)
                  setDrawer(action);
                }
              }}/>
          )}
        </div>
      ) : (
        // DESKTOP / TABLET: original wrapping single row.
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={goToday}>Today</button>
          <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => nav(-1)}>
            <Icons.Arrow size={14} style={{ transform: 'rotate(180deg)' }}/>
          </button>
          <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => nav(1)}>
            <Icons.Arrow size={14}/>
          </button>
          <h3 className="page-title" style={{ margin: 0, fontSize: 22 }}>{rangeLabel}</h3>

          <div style={{ marginLeft: 8 }}><ViewToggle/></div>

          <div style={{ flex: 1 }}/>
          {/* Services + Packages moved to Finance → Services / Packages.
              The drawer code remains so the ?service= deep-link below
              still resolves (now redirected to /finance). */}
          <button className="btn btn-outline" onClick={() => setDrawer('staff')}>
            <Icons.Users size={14}/> {!isTablet && 'Staff'}
          </button>
          <button className="btn btn-outline" onClick={() => setDrawer('availability')}>
            <Icons.Clock size={14}/> {!isTablet && 'Availability'}
          </button>
          <button className="btn btn-outline" onClick={() => setDrawer('share')}
            data-tour="calendar-share">
            <Icons.Globe size={14}/> {!isTablet && 'Share'}
          </button>
          {CALENDAR_SYNC_ENABLED && (
            <button className="btn btn-outline" onClick={() => setDrawer('sync')}>
              <Icons.Arrow size={14}/> {!isTablet && 'Sync'}
            </button>
          )}
          <button className="btn btn-outline" onClick={() => {
            // The block editor doubles as a general event editor —
            // owner picks "Block bookings" or "Reminder only" inside.
            // Default values open it in block mode for backwards
            // compatibility with the old "Block time" button.
            setSelectedEvent({ kind: 'block', date: todayISO, startMin: 12 * 60, endMin: 13 * 60, label: '', blocksBookings: true });
            setDrawer('event');
          }}>
            <Icons.Clock size={14}/> {!isTablet && 'Add event'}
          </button>
          <button className="btn btn-primary" onClick={() => setAddBookingOpen(true)}
            data-tour="calendar-new-booking">
            <Icons.Plus size={14}/> New booking
          </button>
        </div>
      )}

      {/* Legend (week + day views only — month uses chips inline) */}
      {view !== 'month' && (
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          <Legend color="var(--accent)" label="Booked"/>
          <Legend stripe label="Blocked"/>
          <Legend bordered label="Available"/>
        </div>
      )}

      {/* Staff filter pills — only renders when the workspace has at
          least one staff member. Hidden otherwise to avoid noise for
          solo-practitioner workspaces. */}
      {staffList.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          padding: '6px 0 10px',
        }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 4 }}>
            Show
          </span>
          <button onClick={() => setStaffFilter(null)}
            className={`btn ${staffFilter === null ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '4px 10px', fontSize: 11.5 }}>
            Everyone
          </button>
          <button onClick={() => setStaffFilter('owner')}
            className={`btn ${staffFilter === 'owner' ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '4px 10px', fontSize: 11.5 }}>
            Just me (owner)
          </button>
          {staffList.map((s) => (
            <button key={s.id} onClick={() => setStaffFilter(s.id)}
              className={`btn ${staffFilter === s.id ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '4px 10px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: 4,
                background: s.color || 'var(--muted)',
              }}/>
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Active view (uses expanded bookings so recurring instances show) */}
      {view === 'week' && (
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: isMobile ? 720 : 'auto' }}>
            <WeekGrid anchor={startOfWeek(anchor)} cal={calForViews}
              onPickBlock={(date, start, end) => {
                setSelectedEvent({ kind: 'block', date, startMin: start, endMin: end, label: '' });
                setDrawer('event');
              }}
              onOpenEvent={openEvent}/>
          </div>
        </div>
      )}

      {view === 'day' && (
        <DayView date={anchor} cal={calForViews}
          onPickBlock={(date, start, end) => {
            setSelectedEvent({ kind: 'block', date, startMin: start, endMin: end, label: '' });
            setDrawer('event');
          }}
          onOpenEvent={openEvent}/>
      )}

      {view === 'month' && (
        <MonthView anchor={anchor} cal={calForViews}
          onPickDay={(d) => { setView('day'); setAnchor(d); }}
          onOpenEvent={openEvent}/>
      )}

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
              const svc = (cal?.services || []).find((s) => s.id === b.serviceId);
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
          initial={cal?.settings?.availability}
          noticeHours={cal?.settings?.minNoticeHours}
          maxAdvanceDays={cal?.settings?.maxAdvanceDays}
          slotMinutes={cal?.settings?.slotMinutes}
          slotFitService={cal?.settings?.slotFitService}
          bufferMinutes={cal?.settings?.bufferMinutes}
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
      {drawer === 'sync' && (
        <SyncDrawer onClose={() => setDrawer(null)}/>
      )}
      {drawer === 'packages' && (
        <PackagesDrawer services={cal.services} onClose={() => setDrawer(null)}/>
      )}
      {drawer === 'staff' && (
        <StaffDrawer onClose={() => setDrawer(null)} onChanged={refresh}/>
      )}
      {drawer === 'event' && selectedEvent && (
        <EventDrawer
          event={selectedEvent}
          services={cal.services}
          onSaveBlock={async (e) => {
            const payload = {
              date: e.date, startMin: e.startMin, endMin: e.endMin, label: e.label,
              blocksBookings: e.blocksBookings !== false,
              color: e.color || '',
              notes: e.notes || '',
              allDay: !!e.allDay,
            };
            if (e.id) await updateBlock(e.id, payload);
            else await addBlock(payload);
          }}
          onUpdateBooking={updateBooking}
          onCancelOccurrence={cancelOccurrence}
          onCompleteBooking={completeBooking}
          onEditCompletion={editCompletion}
          onClearCompletion={clearCompletion}
          onDelete={async (e) => {
            if (e.kind === 'booking') await cancelBooking(e.recurrenceMasterId || e.id);
            else if (e.id) await removeBlock(e.id);
          }}
          onClose={() => { setDrawer(null); setSelectedEvent(null); }}
          onBookingChanged={onBookingChanged}
        />
      )}
      {addBookingOpen && (
        <AddBookingModal
          services={cal.services}
          defaultDate={fmtDateISO(anchor)}
          defaultClientId={bookingDefaultClientId}
          onSubmit={createBooking}
          onClose={() => { setAddBookingOpen(false); setBookingDefaultClientId(null); }}
        />
      )}
    </div>
  );
}

// ----- Week grid (extracted so the toolbar can switch between views) -----
function WeekGrid({ anchor, cal, onPickBlock, onOpenEvent }) {
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  const hours    = Array.from({ length: 11 }, (_, i) => i + 8); // 8am–6pm
  const rowH     = 52;
  const todayISO = fmtDateISO(new Date());

  return (
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
                if (e.currentTarget !== e.target) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const startMin = hours[0] * 60 + Math.floor(y / rowH) * 30;
                onPickBlock(dateISO, startMin, startMin + 60);
              }}
            >
              {hours.map((_, i) => (
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
              {/* blocks (and personal events). Render style depends on
                  blocksBookings: a hard block keeps the diagonal-stripe
                  pattern that says "unavailable"; a reminder-only
                  event renders solid in the chosen color with a small
                  "no-block" indicator so the owner can tell at a
                  glance that clients can still book this slot.
                  When the owner picks a color it overrides the
                  default in both modes. */}
              {(cal.blocks || []).filter((b) => b.date === dateISO).map((b) => {
                const top = ((b.startMin - hours[0] * 60) / 60) * rowH;
                const h   = ((b.endMin - b.startMin) / 60) * rowH;
                const isBlocking = b.blocksBookings !== false;
                const baseColor  = b.color || (isBlocking ? null : 'var(--accent)');
                const bg = isBlocking
                  ? (baseColor
                      ? `repeating-linear-gradient(-45deg, ${baseColor}22 0 6px, ${baseColor}66 6px 12px)`
                      : 'repeating-linear-gradient(-45deg, var(--surface-2) 0 6px, var(--border-strong) 6px 12px)')
                  : (baseColor ? `${baseColor}33` : 'var(--accent-soft)');
                const border = baseColor || 'var(--border-strong)';
                return (
                  <div key={b.id}
                    onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'block', ...b }); }}
                    title={isBlocking ? 'Blocks bookings' : 'Reminder only (clients can still book)'}
                    style={{
                      position: 'absolute', top, height: h, left: 4, right: 4,
                      background: bg,
                      border: `1px solid ${border}`, borderRadius: 6,
                      padding: '4px 6px', fontSize: 11, color: 'var(--fg-2)',
                      cursor: 'pointer', overflow: 'hidden',
                    }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {!isBlocking && (
                        <span title="Doesn't block bookings"
                          style={{ fontSize: 9, opacity: 0.7 }}>◌</span>
                      )}
                      <span>{b.label || (isBlocking ? 'Blocked' : 'Event')}</span>
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 10 }}>
                      {b.allDay ? 'All day' : `${minToHM(b.startMin)} – ${minToHM(b.endMin)}`}
                    </div>
                  </div>
                );
              })}
              {/* bookings — use the service's color when set so the
                  owner can tell apart different service types at a
                  glance (yoga vs massage vs consultation). Falls back
                  to the workspace accent for legacy services. */}
              {(cal.bookings || []).filter((b) => b.date === dateISO).map((b) => {
                const top = ((b.startMin - hours[0] * 60) / 60) * rowH;
                const h   = ((b.endMin - b.startMin) / 60) * rowH;
                const svc = (cal?.services || []).find((s) => s.id === b.serviceId);
                const tile = svc?.color || 'var(--accent)';
                const ink  = svc?.color ? '#fff' : 'var(--accent-ink)';
                return (
                  <div key={b.id} onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'booking', ...b }); }} style={{
                    position: 'absolute', top, height: h, left: 4, right: 4,
                    background: tile, color: ink,
                    border: `1px solid ${tile}`, borderRadius: 6,
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
  );
}

// Bottom-sheet menu used by the mobile toolbar to expose Services /
// Availability / Share / Block-time without crowding the header row.
function ActionSheet({ onClose, onPick }) {
  // Services + Packages relocated to /finance — removed from this
  // sheet so the mobile "+" menu only surfaces calendar-scoped actions.
  const items = [
    { id: 'staff',        label: 'Staff',        icon: 'Users' },
    { id: 'availability', label: 'Availability', icon: 'Clock' },
    { id: 'share',        label: 'Share booking link', icon: 'Globe' },
    { id: 'sync',         label: 'Calendar sync', icon: 'Arrow' },
    { id: 'block',        label: 'Add event',    icon: 'Clock' },
  ].filter((it) => it.id !== 'sync' || CALENDAR_SYNC_ENABLED); // sync tabled for now
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 80,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{
        width: '100%', maxWidth: 420, margin: 12,
        padding: 8, display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        {items.map((it) => {
          const Icon = Icons[it.icon];
          return (
            <button key={it.id} onClick={() => onPick(it.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '14px 14px', borderRadius: 8, fontSize: 14,
                color: 'var(--fg)', textAlign: 'left',
              }}>
              <Icon size={16} sw={1.7} stroke="var(--muted)"/>
              {it.label}
            </button>
          );
        })}
        <button onClick={onClose}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '12px 14px', borderRadius: 8, fontSize: 13.5,
            color: 'var(--muted)', marginTop: 4,
            borderTop: '1px solid var(--border)',
          }}>
          Cancel
        </button>
      </div>
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
