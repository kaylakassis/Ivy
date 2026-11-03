// Onboarding "Switching to Ivy?" step: where are your clients today? Picking
// an app shows a two-line guide for getting the export and the ways to bring
// it in right here (the same import hub as Clients, Import). "Send Ivy a
// screenshot" opens Ivy in place with the photo menu ready, because the
// wizard has no Ivy dock.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import ImportClientsModal from '../clients/ImportClientsModal.jsx';
import { IvyQuickPanel } from '../ivy/IvyDock.jsx';
import { SWITCH_SOURCES, SWITCH_SOURCE_BY_ID, screenshotPrompt } from './switchSources.js';

export default function SwitchStep({ switchFrom, onPick, imported, onImported, onJustStarting }) {
  const [hub, setHub] = useState(null);      // initial hub mode when open
  const [ivyOpen, setIvyOpen] = useState(false);
  const source = SWITCH_SOURCE_BY_ID[switchFrom];
  const actions = source?.actions || [];

  const pick = (id) => {
    onPick(id);
    if (id === 'new') onJustStarting();
  };

  return (
    <>
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 24, fontWeight: 600, margin: '0 0 6px' }}>
          Switching to Ivy?
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0, lineHeight: 1.55 }}>
          Where are your clients today? Bring them over in a few minutes. Nobody gets a message unless you say so.
        </p>
      </div>

      <div role="radiogroup" aria-label="Where are your clients today?" style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8,
      }}>
        {SWITCH_SOURCES.map((s) => {
          const on = switchFrom === s.id;
          const wide = s.id === 'new';
          return (
            <button key={s.id} type="button" role="radio" aria-checked={on} onClick={() => pick(s.id)}
              style={{
                gridColumn: wide ? '1 / -1' : undefined,
                padding: '11px 12px', borderRadius: 12, textAlign: wide ? 'center' : 'left',
                fontSize: 14, fontWeight: on ? 600 : 500, lineHeight: 1.3, cursor: 'pointer',
                border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                background: on ? 'var(--accent-soft)' : 'var(--surface)',
                color: on ? 'var(--accent)' : wide ? 'var(--fg-2)' : 'var(--fg)',
              }}>
              {s.label}
            </button>
          );
        })}
      </div>

      {source && actions.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            From {source.label}
          </div>
          {source.guide.map((l) => (
            <div key={l} style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{l}</div>
          ))}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {actions.includes('file') && (
              <ActionBtn primary icon="Doc" onClick={() => setHub('file')}>Upload the file</ActionBtn>
            )}
            {actions.includes('contacts') && (
              <ActionBtn primary icon="Phone" onClick={() => setHub('contacts')}>Add from my contacts</ActionBtn>
            )}
            {actions.includes('google') && (
              <ActionBtn primary={!actions.includes('file')} icon="Calendar" onClick={() => setHub('google')}>Google Calendar</ActionBtn>
            )}
            {actions.includes('ics') && (
              <ActionBtn icon="Calendar" onClick={() => setHub('ics')}>Upload a calendar file</ActionBtn>
            )}
            <ActionBtn primary={actions.includes('photo')} icon="Camera" onClick={() => setIvyOpen(true)}>
              {switchFrom === 'paper' ? 'Send Ivy a photo' : 'Send Ivy a screenshot'}
            </ActionBtn>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => setHub('menu')}
            style={{ padding: '8px 2px 0', fontSize: 12.5, color: 'var(--muted)' }}>
            More ways to bring clients in
          </button>
        </div>
      )}

      {imported && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--ok) 8%, var(--surface))',
          border: '1px solid color-mix(in srgb, var(--ok) 30%, var(--border))', fontSize: 13.5,
        }}>
          <Icons.Check size={16} sw={2.4} stroke="var(--ok)"/>
          <span>{imported}</span>
        </div>
      )}

      {hub && (
        <ImportClientsModal
          initialMode={hub}
          switchFrom={switchFrom}
          inWizard
          onClose={() => setHub(null)}
          onComplete={onImported}
          onScreenshot={() => { setHub(null); setIvyOpen(true); }}/>
      )}
      {ivyOpen && (
        <IvyQuickPanel prompt={screenshotPrompt(switchFrom)} photo onClose={() => setIvyOpen(false)}/>
      )}
    </>
  );
}

function ActionBtn({ primary, icon, onClick, children }) {
  const I = Icons[icon] || Icons.Doc;
  return (
    <button type="button" onClick={onClick} className={primary ? 'btn btn-primary' : 'btn btn-outline'}
      style={{ flex: '1 1 180px', justifyContent: 'center', padding: '11px 14px', gap: 7 }}>
      <I size={15}/> {children}
    </button>
  );
}
