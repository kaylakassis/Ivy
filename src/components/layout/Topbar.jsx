// Topbar — viewport-aware.
//   Mobile: hamburger button + page title + search icon button + bell.
//   Tablet/Desktop: title block + 280px search input + bell.
//
// Search input is a button that opens the global CommandPalette via a
// synthetic Cmd+K keydown — keeps this component dumb.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';

// Synthesize the same Cmd+K event the CommandPalette listens for. This
// keeps the topbar dumb (no prop drilling) and the palette as the single
// owner of search-open state.
function openPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', metaKey: true, ctrlKey: true, bubbles: true,
  }));
}

export default function Topbar({ title, subtitle, isMobile, isTablet, onMenuClick, children }) {
  const compact = isMobile || isTablet;
  const navigate = useNavigate();

  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16,
      padding: isMobile ? '12px 14px' : '22px 32px 18px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--page)',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      {isMobile && (
        <button onClick={onMenuClick}
          aria-label="Open menu"
          style={{
            padding: 8, borderRadius: 8, color: 'var(--fg-2)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <Icons.Menu size={20} sw={1.8}/>
        </button>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>
            <span>Workspace</span>
            <span>·</span>
            <span style={{ color: 'var(--fg-2)' }}>{title}</span>
          </div>
        )}
        <h1 className="page-title" style={{
          margin: 0,
          fontSize: isMobile ? 20 : 28,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {isMobile ? title : (subtitle || title)}
        </h1>
      </div>

      {/* Both forms route to the same global CommandPalette via a synthetic
          keyboard event so we don't have to thread an opener prop through
          the layout tree. The palette listens for Cmd+K / Ctrl+K. */}
      {!compact && (
        <button onClick={openPalette} type="button"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 11px', borderRadius: 10,
            background: 'var(--surface)', border: '1px solid var(--border)',
            minWidth: 280, cursor: 'pointer', textAlign: 'left',
          }}>
          <Icons.Search size={15} stroke="var(--muted)" sw={1.6}/>
          <span style={{ flex: 1, color: 'var(--muted)', fontSize: 13 }}>
            Search clients, invoices, notes…
          </span>
          <kbd style={{
            fontSize: 10, fontFamily: 'var(--font-sans)', fontWeight: 500,
            padding: '2px 5px', borderRadius: 4,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            color: 'var(--muted)',
          }}>⌘K</kbd>
        </button>
      )}

      {compact && (
        <button
          aria-label="Search"
          onClick={openPalette}
          style={{
            padding: 8, borderRadius: 8, color: 'var(--fg-2)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <Icons.Search size={18} sw={1.7}/>
        </button>
      )}

      <button className="btn btn-outline" aria-label="Messages"
        onClick={() => navigate('/messages')}
        style={{
          position: 'relative',
          padding: isMobile ? 8 : undefined,
        }}>
        <Icons.Bell size={isMobile ? 16 : 15}/>
      </button>

      {children}
    </header>
  );
}
