import React from 'react';
import Wizard from './Wizard.jsx';
import Editor from './Editor.jsx';
import { useWebsite } from './state.js';
import EmptyNote from '../../components/EmptyNote.jsx';

export default function Website() {
  const store = useWebsite();
  const { site, loading, loadErr, set } = store;

  if (loading) {
    return (
      <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>
        Loading your site…
      </div>
    );
  }

  if (loadErr) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote
            icon="Globe"
            title="Couldn't load your site"
            hint={loadErr.message || 'Check your connection and try again.'}
          />
        </div>
      </div>
    );
  }

  if (!site.launched) {
    return <Wizard onLaunch={(patch) => set(patch)} />;
  }

  return <Editor {...store} />;
}
