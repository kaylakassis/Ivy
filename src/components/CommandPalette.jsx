// Cmd+K (Mac) / Ctrl+K (Windows) global search palette.
//
// Mounted from AppShell so it lives over every authenticated page.
// Listens for the global shortcut, debounces input → /api/search,
// renders results grouped by entity, navigates on Enter / click.
//
// Keyboard model:
//   Cmd+K / Ctrl+K   → open
//   Esc              → close
//   ↑ / ↓            → move highlight
//   Enter            → navigate to highlighted item
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { api } from '../lib/api.js';
import { visibleNavFor } from '../lib/nav.js';
import { useAuth } from '../lib/auth.jsx';

export default function CommandPalette() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ]       = useState('');
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  // Global shortcut. Bound only when authenticated; the unauthenticated
  // /signin etc. screens have no user so this is a no-op for them.
  useEffect(() => {
    if (!user) return;
    const onKey = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);

  // Reset state on open + focus the input.
  useEffect(() => {
    if (open) {
      setQ(''); setGroups([]); setActive(0);
      // wait one tick for the input to mount
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced search. 120ms feels live without hammering the API.
  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setGroups([]); setLoading(false); return;
    }
    setLoading(true);
    const id = setTimeout(() => {
      api.get('/search?q=' + encodeURIComponent(trimmed))
        .then((r) => {
          setGroups([
            ...localNavGroup(trimmed, !!user?.isSuperAdmin, user?.ui_prefs?.hiddenNav),
            ...(r.groups || []),
          ]);
          setActive(0);
        })
        .catch(() => setGroups(localNavGroup(trimmed, !!user?.isSuperAdmin, user?.ui_prefs?.hiddenNav)))
        .finally(() => setLoading(false));
    }, 120);
    return () => clearTimeout(id);
  }, [q, open, user?.isSuperAdmin]);

  // Flatten groups for keyboard navigation.
  const flat = useMemo(
    () => groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label }))),
    [groups],
  );

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flat[active];
      if (target) go(target);
    }
  };

  const go = (item) => {
    setOpen(false);
    navigate(item.url);
  };

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Search"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 260,
        background: 'rgba(10,12,8,0.55)', backdropFilter: 'blur(4px)',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        paddingTop: '14vh', padding: 20,
      }}>
      <div className="card" style={{
        width: '100%', maxWidth: 580,
        padding: 0, overflow: 'hidden',
        boxShadow: '0 30px 80px rgba(0,0,0,0.32)',
        border: '1px solid var(--border-strong)',
        background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icons.Spark size={16} sw={1.6} stroke="var(--muted)"/>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search clients, invoices, bookings, pages…"
            style={{
              flex: 1, padding: 0, border: 0, outline: 'none',
              background: 'transparent', color: 'var(--fg)',
              fontSize: 15, fontWeight: 500,
            }}/>
          <span style={{
            fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
            padding: '2px 7px', borderRadius: 6,
            background: 'var(--surface-2)', color: 'var(--muted)', border: '1px solid var(--border)',
          }}>esc</span>
        </div>

        <div style={{ maxHeight: 'min(520px, 60vh)', overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: 20, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
              Searching…
            </div>
          )}
          {!loading && q.trim() && flat.length === 0 && (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
              No matches for "{q}".
            </div>
          )}
          {!loading && !q.trim() && (
            <div style={{ padding: 18 }}>
              <Group label="Jump to" items={visibleNavFor({ isSuperAdmin: user?.isSuperAdmin, hiddenNav: user?.ui_prefs?.hiddenNav })
                .map((n) => ({ id: 'page:' + n.id, title: n.label, subtitle: n.to, url: n.to, icon: n.icon }))}
                go={go} flatStart={0} active={active}/>
            </div>
          )}
          {flat.length > 0 && (
            <div style={{ padding: 8 }}>
              {(() => {
                let cursor = 0;
                return groups.map((g) => {
                  const node = (
                    <Group key={g.label} label={g.label} items={g.items}
                      go={go} flatStart={cursor} active={active}/>
                  );
                  cursor += g.items.length;
                  return node;
                });
              })()}
            </div>
          )}
        </div>

        <div style={{
          padding: '8px 14px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 14, fontSize: 11, color: 'var(--muted)',
        }}>
          <Hint k="↑↓" v="navigate"/>
          <Hint k="↵"  v="open"/>
          <Hint k="esc" v="close"/>
          <span style={{ marginLeft: 'auto' }}>
            <kbd style={kbd}>{isMac() ? '⌘' : 'Ctrl'}</kbd>
            <kbd style={kbd}>K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

function Group({ label, items, go, flatStart, active }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        padding: '6px 10px', fontSize: 10.5, fontWeight: 600,
        color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>{label}</div>
      {items.map((it, i) => {
        const Icon = Icons[it.icon] || Icons.Check;
        const isActive = (flatStart + i) === active;
        return (
          <button key={it.id} onClick={() => go(it)} onMouseEnter={() => { /* keyboard owns active */ }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', borderRadius: 8, textAlign: 'left',
              background: isActive ? 'var(--surface-2)' : 'transparent',
              border: '1px solid ' + (isActive ? 'var(--border)' : 'transparent'),
              cursor: 'pointer', color: 'var(--fg)',
            }}>
            <Icon size={14} sw={1.6} stroke="var(--muted)"/>
            <span style={{ fontSize: 13.5, fontWeight: 550, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.title}
            </span>
            {it.subtitle && (
              <span style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
                {it.subtitle}
              </span>
            )}
            {isActive && <Icons.Arrow size={11} sw={2.2} stroke="var(--muted)"/>}
          </button>
        );
      })}
    </div>
  );
}

function Hint({ k, v }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <kbd style={kbd}>{k}</kbd> {v}
    </span>
  );
}
const kbd = {
  display: 'inline-block',
  padding: '1px 5px',
  fontSize: 10.5,
  fontFamily: 'inherit',
  lineHeight: 1.4,
  borderRadius: 4,
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  color: 'var(--fg-2)',
  marginRight: 3,
};

// "Jump to" pages always show even with no query (or as a header group)
// when q is non-empty so the user can navigate without typing the page
// name perfectly. Filters by case-insensitive match.
function localNavGroup(q, isSuperAdmin, hiddenNav) {
  const lc = q.toLowerCase();
  const matches = visibleNavFor({ isSuperAdmin, hiddenNav }).filter((n) =>
    n.label.toLowerCase().includes(lc) || n.to.toLowerCase().includes(lc),
  );
  if (matches.length === 0) return [];
  return [{
    label: 'Jump to',
    items: matches.map((n) => ({
      id: 'page:' + n.id,
      title: n.label,
      subtitle: n.to,
      url: n.to,
      icon: n.icon,
    })),
  }];
}

function isMac() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPod|iPad/.test(navigator.platform || '');
}
