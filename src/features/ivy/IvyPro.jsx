// Ivy Pro — full-page AI business coach.
// Three-column layout: left (history + new chat), center (chat / welcome),
// right (workspace context + upload placeholder).
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { useIvy } from './state.js';

export default function IvyPro() {
  const [tweaks] = useTweaks();
  const direction = tweaks.direction;
  const {
    sessions, activeId, messages, context,
    loading, thinking, error, mode, modeError, usage,
    openSession, newChat, send, removeSession,
  } = useIvy();

  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, thinking]);

  const submit = (text) => {
    const t = (text ?? draft).trim();
    if (!t || thinking) return;
    setDraft('');
    send(t);
  };

  if (loading) {
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading Ivy…</div>;
  }

  return (
    <div style={{
      height: 'calc(100vh - 60px)', display: 'grid',
      gridTemplateColumns: '260px 1fr 320px',
      overflow: 'hidden',
    }}>
      {/* LEFT: history */}
      <div style={{
        borderRight: '1px solid var(--border)', background: 'var(--surface)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '20px 18px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <SparkBadge direction={direction} size={32}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="page-title" style={{ fontSize: 17, margin: 0 }}>Ivy Pro</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>AI business coach</div>
            </div>
          </div>
          {mode && <ModeChip mode={mode} modeError={modeError}/>}
          {mode === 'live' && usage && <UsageMeter usage={usage}/>}
          <button className="btn btn-primary" onClick={newChat}
            style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
            <Icons.Plus size={13} sw={2.2}/> New chat
          </button>
        </div>
        <div style={{
          padding: '4px 12px', fontSize: 10, color: 'var(--muted)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Recent
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 16px' }}>
          {sessions.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
              No conversations yet.
            </div>
          ) : sessions.map((s) => (
            <SessionRow key={s.id} session={s}
              active={activeId === s.id}
              onOpen={() => openSession(s.id)}
              onRemove={() => removeSession(s.id)}/>
          ))}
        </div>
      </div>

      {/* CENTER */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface-2)' }}>
        <div style={{ padding: 24, paddingBottom: 0 }}>
          <InsightBanner context={context} direction={direction} onAct={submit}/>
        </div>

        <div ref={scrollRef} className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {error && (
            <div style={{
              maxWidth: 720, margin: '0 auto 12px',
              padding: '10px 14px', borderRadius: 10,
              background: 'color-mix(in srgb, var(--danger) 12%, transparent)',
              border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5,
            }}>
              {error.message || 'Something went wrong.'}
            </div>
          )}
          {!activeId && messages.length === 0 ? (
            <WelcomePanel onPrompt={submit} direction={direction}/>
          ) : (
            <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {messages.map((m) => <ChatBubble key={m.id} msg={m}/>)}
              {thinking && <ThinkingBubble/>}
            </div>
          )}
        </div>

        {/* Composer */}
        <div style={{ padding: '16px 24px 24px', background: 'var(--surface-2)' }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: 8,
              padding: 10, borderRadius: 16,
              background: 'var(--surface)', border: '1px solid var(--border-strong)',
              boxShadow: '0 4px 14px -4px rgba(10,12,8,0.08)',
            }}>
              <textarea value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                placeholder="Ask Ivy about revenue, retention, pricing, content…"
                rows={1}
                style={{
                  flex: 1, border: 0, outline: 0, resize: 'none',
                  background: 'transparent', fontFamily: 'inherit', fontSize: 14,
                  lineHeight: 1.5, color: 'var(--fg)', maxHeight: 140, padding: '6px 8px',
                }}/>
              <button className="btn btn-primary" onClick={() => submit()}
                disabled={!draft.trim() || thinking}
                style={{ padding: '8px 12px' }}>
                <Icons.Arrow size={13} sw={2.4}/>
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
              Ivy reads your real THRYVE data — clients, finance, calendar — and stays inside this workspace.
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: context panel */}
      <div style={{
        borderLeft: '1px solid var(--border)', background: 'var(--surface)',
        padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <UploadPlaceholder/>
        <DataContext context={context}/>
      </div>
    </div>
  );
}

function ModeChip({ mode, modeError }) {
  const live = mode === 'live';
  const tooltip = live
    ? 'Connected to Anthropic — replies are generated by Claude.'
    : `Mock mode — set ANTHROPIC_API_KEY in Vercel and redeploy. ${modeError ? '(' + modeError + ')' : ''}`;
  return (
    <div title={tooltip} style={{
      marginTop: 10, padding: '5px 9px', borderRadius: 8, fontSize: 11,
      background: live ? 'color-mix(in srgb, var(--ok) 14%, transparent)' : 'color-mix(in srgb, var(--warn) 14%, transparent)',
      color: live ? 'var(--ok)' : 'var(--warn)',
      border: '1px solid ' + (live ? 'var(--ok)' : 'var(--warn)'),
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: 99,
        background: live ? 'var(--ok)' : 'var(--warn)',
      }}/>
      <span style={{ fontWeight: 600 }}>{live ? 'Claude live' : 'Mock mode'}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.8 }}>
        {live ? 'opus 4.7' : 'no API key'}
      </span>
    </div>
  );
}

function UsageMeter({ usage }) {
  const reqPct = Math.min(100, Math.round((usage.requests / usage.requestCap) * 100)) || 0;
  const tokPct = Math.min(100, Math.round((usage.outputTokens / usage.outputTokenCap) * 100)) || 0;
  const pct = Math.max(reqPct, tokPct);
  const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--muted)';
  return (
    <div title={`Today's Ivy usage — resets at midnight UTC.\n${usage.requests}/${usage.requestCap} messages\n${usage.outputTokens.toLocaleString()}/${usage.outputTokenCap.toLocaleString()} reply tokens`}
      style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span>Today</span>
        <span className="mono-num" style={{ color }}>{usage.requests}/{usage.requestCap} msgs</span>
      </div>
      <div style={{ height: 3, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .3s' }}/>
      </div>
    </div>
  );
}

function SparkBadge({ direction, size = 32 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.31,
      background: `linear-gradient(135deg, var(--accent), ${direction === 'bold' ? '#E5FF80' : '#5966B8'})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--accent-ink)', flexShrink: 0,
    }}>
      <Icons.Spark size={Math.round(size * 0.5)} sw={2}/>
    </div>
  );
}

function SessionRow({ session, active, onOpen, onRemove }) {
  return (
    <div onClick={onOpen}
      style={{
        display: 'flex', width: '100%', padding: '9px 10px', borderRadius: 8,
        cursor: 'pointer',
        background: active ? 'var(--surface-2)' : 'transparent',
        color: 'var(--fg)', alignItems: 'center', gap: 8,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      <Icons.Chat size={13} sw={1.8} stroke="var(--muted)"/>
      <div style={{
        flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{session.title}</div>
      <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
        style={{ color: 'var(--muted)', opacity: 0.7, padding: 2, display: 'inline-flex' }}
        title="Delete chat">
        <Icons.X size={11}/>
      </button>
    </div>
  );
}

function InsightBanner({ context, direction, onAct }) {
  const ctx = context || {};
  const headline = pickInsight(ctx);
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      padding: '18px 20px', borderRadius: 14,
      background: `linear-gradient(110deg, ${direction === 'bold' ? 'var(--accent)' : '#E8E4F2'}, ${direction === 'bold' ? '#E5FF80' : '#D5DBF2'})`,
      color: direction === 'bold' ? 'var(--accent-ink)' : '#2D2847',
      display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        background: 'rgba(255,255,255,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={20} sw={2}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75 }}>
          Ivy's insight today
        </div>
        <div className="page-title" style={{ fontSize: 20, margin: '2px 0 0' }}>{headline.title}</div>
        <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 3 }}>{headline.body}</div>
      </div>
      <button onClick={() => onAct(headline.prompt)} style={{
        padding: '8px 14px', borderRadius: 10, border: 0, cursor: 'pointer',
        background: 'rgba(10,12,8,0.85)', color: 'white', fontSize: 12.5, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}>
        Show me how
        <Icons.Arrow size={11} sw={2.4}/>
      </button>
    </div>
  );
}

function pickInsight(ctx) {
  if ((ctx.openInvoices || 0) > 0) {
    return {
      title: 'Money is sitting in unpaid invoices',
      body: `${ctx.openInvoices} invoice${ctx.openInvoices === 1 ? '' : 's'} open right now. A short nudge often unlocks them.`,
      prompt: 'Help me draft a friendly follow-up for my unpaid invoices.',
    };
  }
  if ((ctx.quietClients || 0) > 0) {
    return {
      title: 'A few clients have gone quiet',
      body: `${ctx.quietClients} active client${ctx.quietClients === 1 ? '' : 's'} hasn't heard from you in 3+ weeks.`,
      prompt: 'Help me write a check-in to my quietest clients.',
    };
  }
  if ((ctx.upcomingSessions || 0) > 0) {
    return {
      title: 'Your next 7 days are booked',
      body: `${ctx.upcomingSessions} session${ctx.upcomingSessions === 1 ? '' : 's'} on the calendar. Pre-confirms cut no-shows.`,
      prompt: 'Draft a quick pre-confirm message for upcoming sessions.',
    };
  }
  return {
    title: 'Kickstart client acquisition',
    body: 'Your funnel has room — three small moves could refill it this week.',
    prompt: 'Help me kickstart client acquisition.',
  };
}

function WelcomePanel({ onPrompt, direction }) {
  const prompts = [
    { icon: <Icons.Dollar size={16} sw={1.8}/>,   title: 'Revenue analysis',    body: 'Where is my money coming from this month?',  tone: '#0A8A4B' },
    { icon: <Icons.Users size={16} sw={1.8}/>,    title: 'Client retention',    body: 'Which clients are at risk of churning?',     tone: '#4E63C7' },
    { icon: <Icons.Trending size={16} sw={1.8}/>, title: 'Pricing strategy',    body: 'Am I ready to raise my rates?',              tone: '#C97B22' },
    { icon: <Icons.Calendar size={16} sw={1.8}/>, title: 'Content calendar',    body: 'Plan my next 4 weeks of posts.',             tone: '#7A33C7' },
    { icon: <Icons.Check size={16} sw={1.8}/>,    title: 'Weekly plan',         body: 'What are the 3 things I should do this week?', tone: '#B23A48' },
    { icon: <Icons.Chat size={16} sw={1.8}/>,     title: 'Client outreach',     body: 'Draft a check-in message to quiet clients.', tone: '#0D7E8A' },
  ];

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{ display: 'inline-flex', marginBottom: 16 }}>
          <SparkBadge direction={direction} size={56}/>
        </div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Welcome to Ivy Pro</h2>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
          Your AI business coach. Ask anything or start with a prompt below.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {prompts.map((p, i) => (
          <button key={i} onClick={() => onPrompt(p.body)} style={{
            padding: 16, borderRadius: 12, cursor: 'pointer', textAlign: 'left',
            background: 'var(--surface)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'flex-start', gap: 12,
            transition: 'transform .12s, box-shadow .12s, border-color .12s',
          }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = '0 6px 18px -8px rgba(10,12,8,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: `color-mix(in srgb, ${p.tone} 13%, var(--surface-2))`,
              color: p.tone,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{p.icon}</div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{p.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>{p.body}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({ msg }) {
  const isMe = msg.role === 'me';
  return (
    <div style={{
      display: 'flex', gap: 10, flexDirection: isMe ? 'row-reverse' : 'row',
      alignItems: 'flex-start',
    }}>
      {!isMe && (
        <div style={{
          width: 28, height: 28, borderRadius: 8, flexShrink: 0,
          background: 'linear-gradient(135deg, var(--accent), #E5FF80)',
          color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Spark size={13} sw={2}/>
        </div>
      )}
      <div style={{
        maxWidth: '82%', padding: '11px 15px', borderRadius: 14,
        fontSize: 13.5, lineHeight: 1.55,
        background: isMe ? 'var(--accent)' : 'var(--surface)',
        color: isMe ? 'var(--accent-ink)' : 'var(--fg)',
        border: isMe ? 'none' : '1px solid var(--border)',
        whiteSpace: 'pre-wrap',
      }}>{msg.text}</div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
        background: 'linear-gradient(135deg, var(--accent), #E5FF80)',
        color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={13} sw={2}/>
      </div>
      <div style={{
        padding: '11px 15px', borderRadius: 14,
        background: 'var(--surface)', border: '1px solid var(--border)',
        display: 'flex', gap: 5, alignItems: 'center',
      }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{
            width: 6, height: 6, borderRadius: 99, background: 'var(--muted)',
            animation: `ivyPulse 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}/>
        ))}
      </div>
      <style>{`@keyframes ivyPulse { 0%,60%,100% { opacity: 0.3; transform: scale(0.9); } 30% { opacity: 1; transform: scale(1.1); } }`}</style>
    </div>
  );
}

function UploadPlaceholder() {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        Upload report for analysis
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        padding: 20, borderRadius: 12,
        border: '1.5px dashed var(--border-strong)', background: 'var(--surface-2)',
        textAlign: 'center', opacity: 0.7,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10, background: 'var(--surface)',
          border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--muted)',
        }}>
          <Icons.Plus size={16} sw={2}/>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Coming soon</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
          Drop CSVs, PDFs, or images and Ivy will pull out the takeaways.
        </div>
      </div>
    </div>
  );
}

function DataContext({ context }) {
  const ctx = context || {};
  const fmt$ = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        What Ivy sees
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <DataRow label="Revenue this month"   value={fmt$(ctx.revenueThisMonth)}/>
        <DataRow label="Active clients"       value={ctx.activeClients ?? 0}/>
        <DataRow label="Open invoices"        value={ctx.openInvoices ?? 0} tone={ctx.openInvoices > 0 ? 'warn' : 'neutral'}/>
        <DataRow label="Sessions next 7 days" value={ctx.upcomingSessions ?? 0}/>
        <DataRow label="Quiet clients (3w+)"  value={ctx.quietClients ?? 0}     tone={ctx.quietClients > 0 ? 'warn' : 'neutral'}/>
      </div>
      <div style={{
        marginTop: 12, padding: 10, borderRadius: 8,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        fontSize: 11, lineHeight: 1.5, display: 'flex', gap: 6,
      }}>
        <Icons.Spark size={12} sw={2}/>
        <div>Ivy auto-syncs with THRYVE. No data leaves your workspace.</div>
      </div>
    </div>
  );
}

function DataRow({ label, value, tone = 'neutral' }) {
  const colors = { warn: 'var(--warn)', neutral: 'var(--fg)' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)',
    }}>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{label}</span>
      <span className="mono-num" style={{ fontSize: 13, fontWeight: 600, color: colors[tone] }}>{value}</span>
    </div>
  );
}
