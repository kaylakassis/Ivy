// The client list with no signal: names from the copy saved on this phone,
// a local search, and a sheet with the essentials (call, email, directions,
// the next saved appointment). Nothing here can be edited offline.
import React, { useMemo, useState } from 'react';
import { Icons } from '../Icons.jsx';
import Drawer from '../../features/calendar/Drawer.jsx';
import { fmtTime } from '../../features/dashboard/format.js';
import { localISODate, parseDateOnly } from '../../lib/dateOnly.js';
import { telHref, mapsHref, nextBookingFor } from '../../lib/offlineLinks.js';
import { useSnapshot, useSnapshotBar } from '../../lib/useOffline.js';
import { OFFLINE_MESSAGE } from '../../lib/offline.js';
import OfflineNotice from './OfflineNotice.jsx';

const linkSty = { color: 'var(--accent)', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 };

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
      <span style={{ width: 84, flexShrink: 0, color: 'var(--muted)', fontSize: 12.5 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

export function OfflineClientSheet({ client, onClose }) {
  const bookings = useSnapshot('bookings');
  const now = new Date();
  const next = nextBookingFor(client.id, bookings?.items, localISODate(now), now.getHours() * 60 + now.getMinutes());
  const tel = telHref(client.phone);
  const map = mapsHref(client.address);
  return (
    <Drawer title={client.name || 'Client'} subtitle="Saved on this phone" onClose={onClose}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Clock size={12}/> {OFFLINE_MESSAGE} Changes can wait until then.
      </div>
      {client.phone && <Row label="Phone">{tel ? <a href={tel} style={linkSty}><Icons.Phone size={13}/> {client.phone}</a> : client.phone}</Row>}
      {client.email && <Row label="Email"><a href={`mailto:${client.email}`} style={linkSty}><Icons.Mail size={13}/> {client.email}</a></Row>}
      {client.address && <Row label="Address">{map ? <a href={map} style={linkSty}><Icons.Globe size={13}/> {client.address}</a> : client.address}</Row>}
      <Row label="Next">
        {next
          ? `${parseDateOnly(next.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${fmtTime(next.startMin)}${next.serviceName ? ` · ${next.serviceName}` : ''}`
          : 'Nothing saved for today or tomorrow'}
      </Row>
    </Drawer>
  );
}

export default function OfflineClients({ snapshot, openId, onOpen, onClose }) {
  const [q, setQ] = useState('');
  useSnapshotBar(snapshot?.savedAt);
  const items = useMemo(() => snapshot?.items || [], [snapshot]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = needle ? items.filter((c) => [c.name, c.email, c.phone].some((v) => (v || '').toLowerCase().includes(needle))) : items;
    return all.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [items, q]);
  if (!snapshot) return <div className="page-pad"><OfflineNotice/></div>;
  const open = openId ? items.find((c) => c.id === openId) : null;
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 24 }}>Clients</h2>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{items.length} saved on this phone. {OFFLINE_MESSAGE}</div>
      </div>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved clients" aria-label="Search saved clients"/>
      <div className="card" style={{ overflow: 'hidden' }}>
        {list.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No saved client matches.</div>
        ) : list.map((c, i) => (
          <button key={c.id} type="button" onClick={() => onOpen(c.id)} style={{
            display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px',
            background: 'transparent', border: 'none', borderTop: i ? '1px solid var(--border)' : 'none', color: 'inherit', cursor: 'pointer',
          }}>
            <span style={{
              width: 34, height: 34, borderRadius: 99, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 12.5, fontWeight: 700,
            }}>{(c.name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || 'Client'}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.phone || c.email || ''}</span>
            </span>
            <Icons.Arrow size={12} stroke="var(--muted)" sw={1.8}/>
          </button>
        ))}
      </div>
      {open && <OfflineClientSheet client={open} onClose={onClose}/>}
    </div>
  );
}
