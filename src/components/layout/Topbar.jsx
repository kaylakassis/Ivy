// Topbar - viewport-aware.
//   Mobile: hamburger button + page title + search icon button + bell.
//   Tablet/Desktop: title block + 280px search input + bell.
//
// Search input is a button that opens the global CommandPalette via a
// synthetic Cmd+K keydown - keeps this component dumb.
//
// Adds an info (i) button next to the title that opens the tab's
// tutorial overlay. On a tab's first visit (not in tutorials_completed)
// the tutorial auto-opens after a brief render delay so the page has
// a chance to paint behind the modal.
import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { useTutorial } from '../../lib/tutorialState.jsx';
import { getTutorial } from '../../lib/tutorials.js';
import NotificationBell from './NotificationBell.jsx';

// Synthesize the same Cmd+K event the CommandPalette listens for. This
// keeps the topbar dumb (no prop drilling) and the palette as the single
// owner of search-open state.
function openPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', metaKey: true, ctrlKey: true, bubbles: true,
  }));
}

export default function Topbar({ title, subtitle, isMobile, isTablet, onMenuClick, tabId, paywalled, children }) {
  const compact = isMobile || isTablet;
  const navigate = useNavigate();
  const tutorial = useTutorial();
  const hasTutorial = tabId && getTutorial(tabId);
  // Auto-open the tutorial on a tab's first ever visit. Once the GET
  // /me/tutorials response says we've seen this tab, we never auto-
  // open again - the (i) button is the manual replay path.
  const lastAutoTabRef = useRef(null);
  useEffect(() => {
    if (!hasTutorial) return;
    if (!tutorial.ready) return;
    // Never pop the tutorial on top of the hard paywall - it would cover the
    // "Start your free trial" screen and block the owner from subscribing.
    // Left BEFORE lastAutoTabRef is stamped so it re-fires once the wall clears
    // (paywalled flips false the moment they activate → this effect re-runs).
    if (paywalled) return;
    if (tutorial.seen(tabId)) return;
    if (lastAutoTabRef.current === tabId) return; // don't reopen if user just dismissed
    lastAutoTabRef.current = tabId;
    // Slight delay so the page paints first; popping the modal on top
    // of an empty surface feels jarring.
    const t = setTimeout(() => tutorial.open(tabId), 350);
    return () => clearTimeout(t);
  }, [tabId, tutorial.ready, hasTutorial, paywalled]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <h1 className="page-title" style={{
            margin: 0,
            fontSize: isMobile ? 20 : 28,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            minWidth: 0,
          }}>
            {isMobile ? title : (subtitle || title)}
          </h1>
          {hasTutorial && (
            <button type="button"
              onClick={() => tutorial.open(tabId)}
              aria-label={`Replay ${title} tutorial`}
              title={`Replay ${title} tutorial`}
              style={{
                width: 26, height: 26, borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--muted)',
                fontSize: 13, fontFamily: 'var(--font-display)',
                fontStyle: 'italic', fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', flexShrink: 0,
                transition: 'background .12s, color .12s, border-color .12s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--accent-soft)';
                e.currentTarget.style.color = 'var(--accent)';
                e.currentTarget.style.borderColor = 'var(--accent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--surface)';
                e.currentTarget.style.color = 'var(--muted)';
                e.currentTarget.style.borderColor = 'var(--border)';
              }}
            >
              i
            </button>
          )}
        </div>
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
        title="Messages"
        style={{
          position: 'relative',
          padding: isMobile ? 8 : undefined,
        }}>
        <Icons.Chat size={isMobile ? 16 : 15}/>
      </button>

      <NotificationBell isMobile={isMobile}/>

      {children}
    </header>
  );
}
