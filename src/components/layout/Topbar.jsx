// Topbar - viewport-aware.
//   Mobile: hamburger button + page title + search icon button + bell.
//   Tablet/Desktop: title block + 280px search input + bell.
//
// Search input is a button that opens the global CommandPalette via a
// synthetic Cmd+K keydown - keeps this component dumb.
//
// An info (i) button next to the title opens the screen's tutorial, on the
// website and in the iPhone app. Tutorials never open by themselves.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { useTutorial } from '../../lib/tutorialState.jsx';
import { getTutorial } from '../../lib/tutorials.js';
import NotificationBell from './NotificationBell.jsx';
import { isNative } from '../../lib/platform.js';

// Synthesize the same Cmd+K event the CommandPalette listens for. This
// keeps the topbar dumb (no prop drilling) and the palette as the single
// owner of search-open state.
function openPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', metaKey: true, ctrlKey: true, bubbles: true,
  }));
}

export default function Topbar({ title, subtitle, isMobile, isTablet, onMenuClick, tabId, children }) {
  const compact = isMobile || isTablet;
  // Native app: no hamburger (the tab bar's More tab replaces the drawer)
  // and unboxed icon buttons - the header reads like an iOS navigation bar
  // instead of an admin panel. The tutorial (i) is on every screen there too.
  const native = isNative();
  const navigate = useNavigate();
  const tutorial = useTutorial();
  const hasTutorial = tabId && getTutorial(tabId);
  // Tutorials never open by themselves. Every screen has an (i) button next
  // to its title; tapping it shows that screen's short walkthrough, as many
  // times as the owner likes. Until they have looked at one, its (i) is
  // tinted so it is easy to find, and that is the only nudge.
  const unseen = !!hasTutorial && tutorial.ready && !tutorial.seen(tabId);

  return (
    <header className={native ? 'app-topbar native' : 'app-topbar'} style={{
      display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16,
      padding: native ? '8px 8px 8px 20px' : (isMobile ? '12px 14px' : '22px 32px 18px'),
      borderBottom: '1px solid var(--border)',
      background: 'var(--page)',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      {/* iPhone app: the menu button opens the More screen (everything that
          is not on the bottom bar). It used to be the bar's fifth tab; that
          slot now holds Clients. */}
      {native && (
        <button onClick={() => navigate('/more')}
          aria-label="More" data-tour="nav-more"
          className="topbar-icon-btn" style={{ marginLeft: -10 }}>
          <Icons.Menu size={22} sw={1.7}/>
        </button>
      )}
      {isMobile && !native && (
        <button onClick={onMenuClick}
          aria-label="Open menu"
          style={{
            padding: 8, borderRadius: 8, color: 'var(--fg-2)',
            minWidth: 44, minHeight: 44,
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
            fontSize: native ? 22 : (isMobile ? 20 : 28),
            letterSpacing: native ? '-0.02em' : undefined,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            minWidth: 0,
          }}>
            {isMobile ? title : (subtitle || title)}
          </h1>
          {hasTutorial && (
            <button type="button" data-tutorial-button data-unseen={unseen ? 'true' : 'false'}
              onClick={() => tutorial.open(tabId)}
              aria-label={`How ${title} works`}
              title={`How ${title} works`}
              className="tutorial-i"
              style={{
                // A full-size tap target around a small round (i).
                width: compact ? 40 : 30, height: compact ? 40 : 30, margin: compact ? '-7px -6px' : 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'transparent', cursor: 'pointer', flexShrink: 0, borderRadius: 999,
              }}>
              <span aria-hidden="true" style={{
                width: 26, height: 26, borderRadius: 999,
                border: `1px solid ${unseen ? 'var(--accent)' : 'var(--border)'}`,
                background: unseen ? 'var(--accent-soft)' : 'var(--surface)',
                color: unseen ? 'var(--accent)' : 'var(--muted)',
                fontSize: 13, fontFamily: 'var(--font-display)',
                fontStyle: 'italic', fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background .12s, color .12s, border-color .12s',
              }}>i</span>
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
            minWidth: 44, minHeight: 44,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <Icons.Search size={18} sw={1.7}/>
        </button>
      )}

      <button className={native ? 'topbar-icon-btn' : 'btn btn-outline'} aria-label="Messages"
        onClick={() => navigate('/messages')}
        title="Messages"
        style={native ? undefined : {
          position: 'relative',
          padding: isMobile ? 8 : undefined,
        }}>
        <Icons.Chat size={native ? 20 : (isMobile ? 16 : 15)} sw={native ? 1.7 : undefined}/>
      </button>

      <NotificationBell isMobile={isMobile} plain={native}/>

      {children}
    </header>
  );
}
