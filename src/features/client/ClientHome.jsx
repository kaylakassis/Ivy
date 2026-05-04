// /me — overview cards + per-business list. Acts as the landing page for
// client-only users and the place owners-who-are-also-clients drop into when
// they switch views.
import React from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelPageHeader, SkelStatGrid, SkelRowList } from '../../components/Skeleton.jsx';
import { useClientPortal } from './clientContext.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function ClientHome() {
  const { data, loading, error, refresh } = useClientPortal();
  const { user } = useAuth();
  if (loading || (!data && !error)) {
    return (
      <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <SkelPageHeader/>
        <SkelStatGrid count={4}/>
        <SkelRowList rows={3} withAvatar/>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="page-pad">
        <div className="card" style={{ padding: 28 }}>
          <EmptyNote icon="Users" title="Couldn't load your portal"
            hint={error?.message || 'Try refreshing.'}
            action={refresh && (
              <button className="btn btn-outline" onClick={refresh}>Retry</button>
            )}/>
        </div>
      </div>
    );
  }

  const { memberships, summary, isClient } = data;
  const greet = greeting();

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>
          {greet}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}.
        </h2>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          {isClient
            ? `${memberships.length} business${memberships.length === 1 ? '' : 'es'} on THRYVE.`
            : "You're not yet linked to any businesses."}
        </div>
      </div>

      {!isClient && (
        <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <EmptyNote icon="Users" title="No businesses yet"
            hint={`Once a business owner adds you as a client (or you book through their THRYVE link), they'll show up here. Make sure you signed up with the same email they have on file (${user?.email}).`}/>
          <Link to="/me/discover" className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}>
            <Icons.Globe size={13} sw={1.7}/> Browse businesses on THRYVE
          </Link>
        </div>
      )}

      {isClient && (
        <>
          <div className="grid-auto-sm">
            <Stat label="Unread messages" value={summary.unreadMessages}
              icon="Chat" tone={summary.unreadMessages > 0 ? 'accent' : 'muted'} to="/me/messages"/>
            <Stat label="Upcoming bookings" value={summary.upcomingBookings}
              icon="Calendar" tone="muted" to="/me/bookings"/>
            <Stat label="Open invoices" value={summary.openInvoices}
              icon="Dollar" tone={summary.openInvoices > 0 ? 'warn' : 'muted'} to="/me/invoices"/>
            <Stat label="Pending documents" value={summary.pendingDocs}
              icon="Doc" tone={summary.pendingDocs > 0 ? 'warn' : 'muted'} to="/me/documents"/>
            {summary.pendingReviews > 0 && (
              <Stat label="Reviews to leave" value={summary.pendingReviews}
                icon="Check" tone="accent" to="/me/bookings?tab=past"/>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <div className="metric-label" style={{ marginBottom: 12 }}>Your businesses</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {memberships.map((m) => (
                <div key={m.clientId} style={{
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 600, fontSize: 14,
                  }}>{(m.businessName[0] || '?').toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{m.businessName}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      Listed as {m.clientName}
                    </div>
                  </div>
                  <Link to="/me/messages" className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }}>
                    Message <Icons.Chat size={12} sw={1.8}/>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, icon, tone, to }) {
  const Icon = Icons[icon];
  const toneColor = tone === 'accent' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : 'var(--muted)';
  const card = (
    <div className="card" style={{
      padding: 18, display: 'flex', flexDirection: 'column', gap: 6,
      cursor: to ? 'pointer' : 'default',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {Icon && <Icon size={14} sw={1.7} stroke={toneColor}/>}
        <div className="metric-label">{label}</div>
      </div>
      <div className="metric-value" style={{ fontSize: 28, color: Number(value) > 0 ? toneColor : 'var(--fg)' }}>
        {value}
      </div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>{card}</Link> : card;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
