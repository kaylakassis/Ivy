// "What do you want to do?" at the top of Home.
//
// The answer to "the app is complicated": the owner says what they want in
// their own words and Ivy either does it (with their approval) or shows
// them where it is, so nobody has to learn the menus first. What they type
// here is sent to Ivy as their message; nothing is done to their business
// until they approve it in the chat.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { openIvy } from '../ivy/openIvy.js';

// Things there is no single button for. (Booking, adding a client and
// sending an invoice have their own buttons right above this box, so they
// are not repeated here.) Each one starts the chat with a plain request;
// Ivy asks for whatever details she needs.
export const ASK_IVY_STARTERS = [
  { label: 'Who owes me money?', prompt: 'Who owes me money right now?' },
  { label: 'What\u2019s on this week?', prompt: 'What do I have on this week?' },
  { label: 'Move a booking', prompt: 'I need to move a booking. Help me do that.' },
  { label: 'Message a client', prompt: 'I want to message a client. Help me do that.' },
];

export default function AskIvyCard() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const ask = (t) => {
    const msg = String(t || '').trim();
    if (!msg) return;
    setText('');
    openIvy({ prompt: msg, send: true, navigate });
  };
  return (
    <section className="card ask-ivy" data-ask-ivy aria-label="Ask Ivy"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <form onSubmit={(e) => { e.preventDefault(); ask(text); }}
        className="focus-within-ring"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 4px 4px 12px', borderRadius: 12,
          background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
        }}>
        <Icons.Spark size={17} sw={1.9} stroke="var(--accent)"/>
        <input value={text} onChange={(e) => setText(e.target.value)}
          aria-label="What do you want to do? Ask Ivy"
          placeholder="What do you want to do?"
          enterKeyHint="send" autoComplete="off" maxLength={500}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--fg)', fontSize: 16, padding: '10px 0' }}/>
        <button type="submit" className="btn btn-primary" aria-label="Ask Ivy" disabled={!text.trim()}
          style={{ padding: '9px 14px', borderRadius: 9, flexShrink: 0 }}>
          Ask Ivy
        </button>
      </form>
      {/* Phones show just the box (the Ivy tab is on the bar below). */}
      <div className="ask-ivy-starters" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {ASK_IVY_STARTERS.map((s) => (
          <button key={s.label} type="button" onClick={() => ask(s.prompt)}
            style={{
              padding: '6px 12px', borderRadius: 99, fontSize: 13, fontWeight: 550, cursor: 'pointer',
              background: 'transparent', color: 'var(--fg-2)', border: '1px solid var(--border-strong)',
            }}>
            {s.label}
          </button>
        ))}
      </div>
    </section>
  );
}
