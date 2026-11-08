// The dashboard's "Today" card with no signal: today's and tomorrow's
// appointments from the copy saved on this phone. Each row opens the
// offline booking sheet (directions, call, Complete, private note).
import React, { useState } from 'react';
import { Icons } from '../Icons.jsx';
import { fmtTime } from '../../features/dashboard/format.js';
import { localISODate } from '../../lib/dateOnly.js';
import { useSnapshotBar } from '../../lib/useOffline.js';
import OfflineBookingSheet from './OfflineBookingSheet.jsx';
import OfflineNotice from './OfflineNotice.jsx';

function Rows({ items, onOpen }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((b) => (
        <button key={b.id} type="button" onClick={() => onOpen(b)} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px', textAlign: 'left',
          borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'inherit',
          opacity: b.completed || b.noShow ? 0.7 : 1, cursor: 'pointer', width: '100%',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', minWidth: 62 }}>{fmtTime(b.startMin)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.clientName || 'Client'}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[b.serviceName, b.locationAddress].filter(Boolean).join(' · ') || 'Session'}
            </span>
          </span>
          {b.noShow && <span style={{ fontSize: 10.5, color: 'var(--danger)' }}>no-show</span>}
          {b.completed && <Icons.Check size={13} sw={2.4} stroke="var(--ok)"/>}
          <Icons.Arrow size={12} stroke="var(--muted)" sw={1.8}/>
        </button>
      ))}
    </div>
  );
}

export default function OfflineTodayCard({ snapshot }) {
  const [open, setOpen] = useState(null);
  useSnapshotBar(snapshot?.savedAt);
  if (!snapshot) return <OfflineNotice/>;
  const today = localISODate();
  const tomorrow = localISODate(new Date(Date.now() + 86400e3));
  const items = snapshot.items || [];
  const todayList = items.filter((b) => b.date === today);
  const tomorrowList = items.filter((b) => b.date === tomorrow);
  const current = open ? (items.find((b) => b.id === open.id) || open) : null;
  return (
    <section className="card" aria-labelledby="today-h" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h3 id="today-h" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Today</h3>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
          {todayList.length === 0 ? 'Nothing saved for today' : `${todayList.length} ${todayList.length === 1 ? 'appointment' : 'appointments'} · saved on this phone`}
        </div>
      </div>
      {todayList.length > 0 ? <Rows items={todayList} onOpen={setOpen}/> : (
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>Nothing on the calendar today when Ivy last saved it.</div>
      )}
      {tomorrowList.length > 0 && (
        <>
          <div className="metric-label" style={{ marginTop: 4 }}>Tomorrow</div>
          <Rows items={tomorrowList} onOpen={setOpen}/>
        </>
      )}
      {current && <OfflineBookingSheet booking={current} onClose={() => setOpen(null)}/>}
    </section>
  );
}
