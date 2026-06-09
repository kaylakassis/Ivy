// Notification bell — top-right of the app shell.
//
// Polls /api/me/notification-feed every 30s for the latest list +
// unread count. Click opens a dropdown panel; clicking a row navigates
// to its url and marks the row read. "Mark all read" zeroes the badge.
//
// Designed to fail open: if the endpoint 401s or 5xxs we just don't
// show the badge / show an empty panel — never blocks the rest of the
// topbar.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { api } from '../../lib/api.js';

const POLL_MS = 30_000;

function fmtRel(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function NotificationBell({ isMobile }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  const fetchFeed = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/me/notification-feed');
      setItems(r.notifications || []);
      setUnread(Number(r.unread) || 0);
    } catch {
      // Auth-failed / endpoint-down — keep last-known state. The bell
      // stays visible; the dropdown just shows whatever was loaded
      // last (or empty).
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + 30s poll. Pauses when the tab is hidden so we
  // don't keep hammering the server in background tabs.
  useEffect(() => {
    fetchFeed();
    const tick = () => { if (!document.hidden) fetchFeed(); };
    const id = setInterval(tick, POLL_MS);
    const onVisible = () => { if (!document.hidden) fetchFeed(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchFeed]);

  // Click-outside closes the panel. Bound on the document so a click
  // anywhere outside the panel + its trigger button collapses it. Uses
  // a slight defer so the open-toggle click doesn't also close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      const t = e.target;
      if (panelRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markAllRead = async () => {
    // Optimistic — zero locally first, reconcile via server response.
    const had = unread;
    setUnread(0);
    setItems((xs) => xs.map((x) => x.readAt ? x : { ...x, readAt: new Date().toISOString() }));
    try {
      await api.post('/me/notification-feed', {});
    } catch {
      // Revert on failure so the badge doesn't lie.
      setUnread(had);
      fetchFeed();
    }
  };

  const handleClick = async (n) => {
    setOpen(false);
    // Mark just this one read (server) + locally.
    if (!n.readAt) {
      setUnread((x) => Math.max(0, x - 1));
      setItems((xs) => xs.map((x) => x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x));
      try { await api.post('/me/notification-feed', { ids: [n.id] }); }
      catch { /* re-poll will reconcile */ }
    }
    if (n.url) {
      // External vs internal routing: anything starting with / is a
      // SPA route; full URLs (incl. mailto:) get window.location.
      if (n.url.startsWith('/')) navigate(n.url);
      else window.location.href = n.url;
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        title="Notifications"
        onClick={() => setOpen((x) => !x)}
        className="btn btn-outline"
        style={{
          position: 'relative',
          padding: isMobile ? 8 : undefined,
        }}>
        <Icons.Bell size={isMobile ? 16 : 15}/>
        {unread > 0 && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 18, height: 18, padding: '0 5px',
            borderRadius: 999,
            background: 'var(--danger, #B23A48)',
            color: '#fff', fontSize: 10.5, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid var(--page, #FFFFFF)',
            boxSizing: 'content-box',
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0,
            width: isMobile ? 'calc(100vw - 28px)' : 360,
            maxWidth: 380,
            maxHeight: '70vh',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 20px 50px rgba(0,0,0,0.18)',
            zIndex: 50,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Notifications {unread > 0 && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {unread} unread</span>}
            </div>
            {unread > 0 && (
              <button onClick={markAllRead}
                style={{
                  background: 'transparent', border: 0,
                  color: 'var(--accent)', fontSize: 12, fontWeight: 500,
                  cursor: 'pointer', padding: 4,
                }}>
                Mark all read
              </button>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {loading && items.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                Loading…
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : (
              items.map((n) => (
                <button key={n.id} onClick={() => handleClick(n)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: n.readAt ? 'transparent' : 'color-mix(in srgb, var(--accent) 6%, transparent)',
                    cursor: n.url ? 'pointer' : 'default',
                  }}>
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                  }}>
                    {!n.readAt && (
                      <span aria-hidden="true" style={{
                        marginTop: 6, width: 6, height: 6, borderRadius: 99,
                        background: 'var(--accent)', flexShrink: 0,
                      }}/>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13.5, fontWeight: 600,
                        color: 'var(--fg)', lineHeight: 1.35,
                        marginLeft: n.readAt ? 14 : 0,
                      }}>{n.title}</div>
                      {n.body && (
                        <div style={{
                          fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.4,
                          marginTop: 2, marginLeft: n.readAt ? 14 : 0,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>{n.body}</div>
                      )}
                      <div style={{
                        fontSize: 11, color: 'var(--muted-2)',
                        marginTop: 4, marginLeft: n.readAt ? 14 : 0,
                      }}>{fmtRel(n.createdAt)}</div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
