// The calendar with no signal: the day view drawn from the copy saved on
// this phone (today and tomorrow), each booking opening the offline sheet.
import React, { useMemo, useState } from 'react';
import { Icons } from '../Icons.jsx';
import DayView from '../../features/calendar/DayView.jsx';
import { EMPTY_CAL } from '../../features/calendar/state.js';
import { localISODate, parseDateOnly } from '../../lib/dateOnly.js';
import { useSnapshotBar } from '../../lib/useOffline.js';
import OfflineBookingSheet from './OfflineBookingSheet.jsx';
import OfflineNotice from './OfflineNotice.jsx';
import { OFFLINE_MESSAGE } from '../../lib/offline.js';

export default function OfflineCalendar({ snapshot }) {
  const today = localISODate();
  const tomorrow = localISODate(new Date(Date.now() + 86400e3));
  const [dayISO, setDayISO] = useState(today);
  const [open, setOpen] = useState(null);
  useSnapshotBar(snapshot?.savedAt);

  const items = useMemo(() => snapshot?.items || [], [snapshot]);
  const cal = useMemo(() => {
    const services = [];
    const seen = new Set();
    for (const b of items) {
      if (b.serviceId && !seen.has(b.serviceId)) { seen.add(b.serviceId); services.push({ id: b.serviceId, name: b.serviceName || 'Session' }); }
    }
    return {
      ...EMPTY_CAL,
      settings: { ...EMPTY_CAL.settings, availability: {} },
      services,
      blocks: [],
      bookings: items,
    };
  }, [items]);

  if (!snapshot) {
    return (
      <div className="page-pad">
        <OfflineNotice/>
      </div>
    );
  }
  const current = open ? (items.find((b) => b.id === open.id) || open) : null;
  const label = parseDateOnly(dayISO).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="page-pad" style={{ paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <button type="button" className="btn btn-outline" onClick={() => setDayISO(today)} style={{ padding: '7px 12px', fontSize: 12 }}>Today</button>
        <button type="button" className="btn btn-ghost" style={{ padding: 8 }} aria-label="Previous" disabled={dayISO === today} onClick={() => setDayISO(today)}>
          <Icons.Arrow size={14} style={{ transform: 'rotate(180deg)' }}/>
        </button>
        <button type="button" className="btn btn-ghost" style={{ padding: 8 }} aria-label="Next" disabled={dayISO === tomorrow} onClick={() => setDayISO(tomorrow)}>
          <Icons.Arrow size={14}/>
        </button>
        <h3 className="page-title" style={{ margin: 0, fontSize: 16, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</h3>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Clock size={12}/> {OFFLINE_MESSAGE} Today and tomorrow are saved on this phone.
      </div>
      <DayView date={parseDateOnly(dayISO)} cal={cal} onPickBlock={() => {}} onOpenEvent={(ev) => setOpen(ev)}/>
      {current && <OfflineBookingSheet booking={current} onClose={() => setOpen(null)}/>}
    </div>
  );
}
