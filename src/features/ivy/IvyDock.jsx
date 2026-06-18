// IvyDock - global floating Ivy bubble + panel.
//
// Sits at the bottom-right of every authenticated owner page (mounted in
// AppShell). Click the FAB to open a 380×620 panel; close to collapse
// back into the bubble. State (sessions, messages, context) is shared
// with the full-page /ivy view via the same useIvy() hook, so a chat
// started here continues there and vice versa.
//
// Mobile (≤ 720px): the panel takes over as a full-screen sheet so the
// composer + messages have room. Desktop: floats over the page so the
// owner can keep working in the document/calendar/etc. behind it.
//
// Proactive surface: when the panel opens with no active session, a
// "Suggestions" strip surfaces 1-3 prefilled prompts derived from
// workspace context (quiet clients, open invoices, upcoming sessions).
// Tapping a card fires it as the next message - Ivy then responds with
// drafts the owner can approve/edit. The FAB carries a notification dot
// whenever there's at least one actionable suggestion.
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useViewport } from '../../lib/viewport.js';
import { useIvy } from './state.jsx';
import { MiniMarkdown } from '../../lib/miniMarkdown.jsx';

const HIDE_PREFIXES = [
  // Don't render in places where the bubble would be noise / out of
  // place. AppShell already excludes most of these, but the route-level
  // hide here keeps things robust if the dock is ever moved higher up.
  '/onboarding', '/admin',
];

export default function IvyDock() {
  const { isMobile } = useViewport();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ivy = useIvy();
  const {
    activeId, messages, context, thinking, error,
    mode, modeError, send, newChat,
  } = ivy;

  // Hide on full-page Ivy itself (the dock would be redundant) and on
  // any explicit denylist routes.
  const onIvyPage = location.pathname === '/ivy';
  const hidden = onIvyPage
    || HIDE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p));

  // Cmd/Ctrl + I toggles the dock. Useful for power users who live in
  // the keyboard. Bail out if the user is typing into a regular input
  // or rich-text editor elsewhere on the page - Cmd+I is the standard
  // italic shortcut and we don't want to swallow it from an unrelated
  // editor (the document body editor, message composer, etc.).
  useEffect(() => {
    if (hidden) return;
    function isEditableTarget(el) {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKey(e) {
      const key = (e.key || '').toLowerCase();
      if (key === 'i' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape' && open) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, open]);

  // Lock background scroll when the mobile sheet is open so flicking
  // inside the messages list doesn't bleed to the page underneath.
  useEffect(() => {
    if (!open || !isMobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, isMobile]);

  const suggestions = useMemo(() => buildSuggestions(context), [context]);
  const hasNudge = suggestions.length > 0 && messages.length === 0;

  if (hidden) return null;

  return (
    <>
      {!open && (
        <FabButton
          onClick={() => setOpen(true)}
          notify={hasNudge}
          isMobile={isMobile}
        />
      )}
      {open && (
        <Panel
          isMobile={isMobile}
          onClose={() => setOpen(false)}
          onExpand={() => { setOpen(false); navigate('/ivy'); }}
          onNewChat={() => { newChat(); }}
          ivy={ivy}
          suggestions={suggestions}
        />
      )}
    </>
  );
}

// ── FAB ────────────────────────────────────────────────────────────

function FabButton({ onClick, notify, isMobile }) {
  return (
    <button
      type="button"
      aria-label="Open Ivy"
      onClick={onClick}
      className="ivy-dock-fab"
      style={{
        position: 'fixed',
        right: isMobile ? 16 : 24,
        bottom: isMobile
          ? 'calc(env(safe-area-inset-bottom, 0px) + 84px)'
          : 28,
        zIndex: 240,
        width: 60, height: 60, borderRadius: 999,
        border: 'none', cursor: 'pointer',
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 12px 32px rgba(46,49,104,.28), 0 2px 8px rgba(0,0,0,.06)',
        transition: 'transform .15s ease, box-shadow .15s ease',
      }}
    >
      <IvyMark size={26} />
      {notify && (
        <span aria-hidden="true" style={{
          position: 'absolute', top: 8, right: 8,
          width: 11, height: 11, borderRadius: 999,
          background: '#E2725B',
          boxShadow: '0 0 0 2.5px var(--accent)',
        }}/>
      )}
    </button>
  );
}

// Lightweight wordmark - accent-colored badge with a serif lowercase t.
// Mirrors the marketing-site logotype so the FAB feels native to Ivy OS.
function IvyMark({ size = 22 }) {
  return (
    <span style={{
      fontFamily: 'Fraunces, "Cormorant Garamond", Georgia, serif',
      fontWeight: 600, fontSize: size, lineHeight: 1,
      letterSpacing: '-0.02em',
    }}>
      Ivy
    </span>
  );
}

// ── Panel ──────────────────────────────────────────────────────────

function Panel({ isMobile, onClose, onExpand, onNewChat, ivy, suggestions }) {
  const { messages, thinking, send, mode, modeError, context, activeId } = ivy;
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Always scroll to bottom on new messages. matches IvyPro behavior.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, thinking]);

  // Focus the composer when the panel opens - feels like a real chat.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  const submit = useCallback((textOverride) => {
    const t = (textOverride ?? draft).trim();
    if (!t || thinking) return;
    setDraft('');
    send(t);
  }, [draft, thinking, send]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const surface = {
    position: 'fixed',
    right: isMobile ? 0 : 24,
    bottom: isMobile ? 0 : 24,
    left: isMobile ? 0 : 'auto',
    top: isMobile ? 0 : 'auto',
    width: isMobile ? '100%' : 392,
    height: isMobile ? '100%' : 'min(640px, calc(100vh - 100px))',
    zIndex: 245,
    background: 'var(--surface)',
    border: isMobile ? 'none' : '1px solid var(--border)',
    borderRadius: isMobile ? 0 : 18,
    boxShadow: isMobile ? 'none' : '0 24px 60px rgba(0,0,0,.18), 0 4px 14px rgba(0,0,0,.06)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
    animation: isMobile ? 'ivy-dock-slide-up .22s ease' : 'ivy-dock-pop-in .18s ease',
  };

  const showSuggestions = messages.length === 0 && !thinking;

  return (
    <div role="dialog" aria-label="Ivy assistant" style={surface}>
      {/* Header */}
      <div style={{
        flex: '0 0 auto',
        padding: '12px 12px 12px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 999,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'Fraunces, Georgia, serif', fontWeight: 600, fontSize: 15,
        }}>
          Ivy
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
            Ivy
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
            Your AI assistant + business coach
          </div>
        </div>
        <IconBtn label="New chat" onClick={onNewChat} icon="Plus"/>
        <IconBtn label="Open in full"  onClick={onExpand}  icon="Arrow"/>
        <IconBtn label="Close"  onClick={onClose}  render={<XGlyph/>}/>
      </div>

      {/* Mode/error strip - only when something's worth saying */}
      {(modeError || mode === 'mock') && (
        <div style={{
          flex: '0 0 auto',
          padding: '8px 14px',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11, color: 'var(--muted)',
        }}>
          {modeError ? `Ivy is offline - ${modeError}` : 'Demo mode - replies are placeholders.'}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '14px 14px 8px',
        background: 'var(--page)',
      }}>
        {showSuggestions ? (
          <Welcome
            context={context}
            suggestions={suggestions}
            onPick={(prompt) => submit(prompt)}
          />
        ) : (
          <MessageList messages={messages} thinking={thinking} />
        )}
      </div>

      {/* Persistent suggestion chips. Once the conversation starts the
          full Welcome panel is replaced by the message list, but the
          owner should still be able to fire other starters - the old
          behavior unmounted ALL suggestions after the first pick, which
          read as "I can't click the other options." Horizontal-scroll
          chip row above the composer keeps them one tap away. */}
      {!showSuggestions && !thinking && suggestions.length > 0 && (
        <div style={{
          flex: '0 0 auto',
          display: 'flex', gap: 6, overflowX: 'auto',
          padding: '8px 12px', borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          {suggestions.map((s) => (
            <button key={s.id} type="button"
              onClick={() => submit(s.prompt)}
              style={{
                flex: '0 0 auto', whiteSpace: 'nowrap',
                fontSize: 12, padding: '5px 10px', borderRadius: 999,
                border: '1px solid var(--border)', background: 'var(--surface-2)',
                color: 'var(--fg-2)', cursor: 'pointer',
              }}>
              {s.title || s.prompt.slice(0, 32)}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      <div style={{
        flex: '0 0 auto',
        padding: '10px 12px calc(env(safe-area-inset-bottom, 0px) + 12px)',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 8,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '8px 8px 8px 12px',
        }}>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={thinking ? 'Ivy is thinking…' : 'Ask Ivy anything…'}
            disabled={thinking}
            style={{
              flex: 1, resize: 'none', minHeight: 22, maxHeight: 120,
              border: 'none', outline: 'none', background: 'transparent',
              fontSize: 14, lineHeight: 1.4, color: 'var(--fg)',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => submit()}
            disabled={!draft.trim() || thinking}
            aria-label="Send"
            style={{
              flex: '0 0 auto',
              width: 34, height: 34, borderRadius: 999,
              border: 'none', cursor: draft.trim() && !thinking ? 'pointer' : 'default',
              background: draft.trim() && !thinking ? 'var(--accent)' : 'var(--border)',
              color: draft.trim() && !thinking ? 'var(--accent-ink)' : 'var(--muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background .15s ease',
            }}
          >
            <Icons.Arrow size={16}/>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Welcome / suggestions ──────────────────────────────────────────

function Welcome({ context, suggestions, onPick }) {
  return (
    <div style={{ padding: '6px 4px 12px' }}>
      <div style={{
        fontFamily: 'Fraunces, Georgia, serif',
        fontSize: 22, lineHeight: 1.2, color: 'var(--fg)',
        marginBottom: 6,
      }}>
        Hi - I'm Ivy.
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
        Ask me anything, or pick something to get started. I can pull data, draft outreach, and send messages or invoices for you.
      </div>

      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} onPick={onPick}/>
          ))}
        </div>
      )}

      {context && (context.activeClients > 0 || context.revenueThisMonth > 0) && (
        <div style={{
          marginTop: 10,
          padding: '10px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          fontSize: 11.5, color: 'var(--muted)',
          display: 'flex', flexWrap: 'wrap', gap: '4px 12px',
        }}>
          <span><b style={{ color: 'var(--fg-2)' }}>${Math.round(context.revenueThisMonth || 0).toLocaleString()}</b> revenue this month</span>
          <span><b style={{ color: 'var(--fg-2)' }}>{context.activeClients || 0}</b> active clients</span>
          <span><b style={{ color: 'var(--fg-2)' }}>{context.upcomingSessions || 0}</b> upcoming</span>
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ suggestion, onPick }) {
  const Icon = Icons[suggestion.icon] || Icons.Spark;
  return (
    <button
      type="button"
      onClick={() => onPick(suggestion.prompt)}
      style={{
        width: '100%', textAlign: 'left',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        cursor: 'pointer',
        transition: 'border-color .15s ease, transform .12s ease, box-shadow .15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
    >
      <span style={{
        flex: '0 0 auto',
        width: 30, height: 30, borderRadius: 8,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={16}/>
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>
          {suggestion.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
          {suggestion.subtitle}
        </div>
      </span>
    </button>
  );
}

// ── Messages ───────────────────────────────────────────────────────

function MessageList({ messages, thinking }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {messages.map((m) => <Bubble key={m.id} role={m.role} text={m.text}/>)}
      {thinking && <ThinkingBubble/>}
    </div>
  );
}

function Bubble({ role, text }) {
  const mine = role === 'me';
  return (
    <div style={{
      display: 'flex',
      justifyContent: mine ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        maxWidth: '88%',
        padding: '8px 12px',
        borderRadius: mine ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
        background: mine ? 'var(--accent)' : 'var(--surface)',
        color: mine ? 'var(--accent-ink)' : 'var(--fg)',
        border: mine ? 'none' : '1px solid var(--border)',
        fontSize: 13.5, lineHeight: 1.5,
        whiteSpace: mine ? 'pre-wrap' : 'normal', wordBreak: 'break-word',
      }}>
        {mine ? text : <MiniMarkdown text={text}/>}
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{
        padding: '10px 14px', borderRadius: '14px 14px 14px 4px',
        background: 'var(--surface)', border: '1px solid var(--border)',
        display: 'flex', gap: 4, alignItems: 'center',
      }}>
        <Dot delay={0}/><Dot delay={150}/><Dot delay={300}/>
      </div>
    </div>
  );
}

function Dot({ delay }) {
  return (
    <span aria-hidden="true" style={{
      width: 6, height: 6, borderRadius: 999,
      background: 'var(--muted)',
      animation: `ivy-dock-dot 1s ${delay}ms infinite ease-in-out`,
    }}/>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function IconBtn({ label, onClick, icon, render }) {
  const Icon = icon ? (Icons[icon] || Icons.More) : null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 32, height: 32, borderRadius: 8,
        border: 'none', background: 'transparent', color: 'var(--muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background .12s ease, color .12s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--fg)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent';      e.currentTarget.style.color = 'var(--muted)'; }}
    >
      {render ? render : <Icon size={16}/>}
    </button>
  );
}

function XGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18"/>
    </svg>
  );
}

// Build proactive suggestions from workspace context. Order matters -
// the most actionable, highest-value items go first. Keep this short
// (max 3) so the welcome screen stays readable.
function buildSuggestions(ctx) {
  const out = [];
  if (!ctx) return out;
  const quiet = ctx.quietClients || 0;
  const open = ctx.openInvoices || 0;
  const upcoming = ctx.upcomingSessions || 0;

  if (quiet > 0) {
    out.push({
      id: 'quiet',
      icon: 'Users',
      title: quiet === 1 ? 'Reach out to 1 quiet client' : `Reach out to ${quiet} quiet clients`,
      subtitle: 'Draft personalized check-ins for clients who\'ve gone silent - I can send them on your behalf.',
      prompt: `I have ${quiet} client${quiet === 1 ? '' : 's'} who have been quiet. Pull the list, draft a warm check-in for each, and ask me to confirm before sending.`,
    });
  }

  if (open > 0) {
    out.push({
      id: 'invoices',
      icon: 'Receipt',
      title: open === 1 ? 'Chase 1 open invoice' : `Chase ${open} open invoices`,
      subtitle: 'See who owes what and email reminders in one go.',
      prompt: `Show me my open invoices and draft a friendly reminder for each. I'll review before you send.`,
    });
  }

  if (upcoming > 0) {
    out.push({
      id: 'upcoming',
      icon: 'Calendar',
      title: 'Prep for upcoming sessions',
      subtitle: `${upcoming} on the books - get a quick brief on each.`,
      prompt: `What's on my calendar this week? Give me a one-line brief on each upcoming session - who, when, and anything I should know going in.`,
    });
  }

  // Always offer a coaching prompt as a fallback so the panel never
  // feels empty even on a fresh workspace.
  if (out.length < 3) {
    out.push({
      id: 'coach',
      icon: 'Trending',
      title: 'What should I focus on this week?',
      subtitle: 'Get a tight, prioritized plan based on your real numbers.',
      prompt: 'What should I focus on this week? Give me 3 specific things based on my actual numbers.',
    });
  }

  return out.slice(0, 3);
}
