// Shared placeholder used by feature stubs until they're ported from the prototype.
import React from 'react';
import EmptyNote from '../components/EmptyNote.jsx';

export default function Stub({ icon, title, hint }) {
  return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 80 }}>
        <EmptyNote icon={icon} title={title} hint={hint} />
      </div>
    </div>
  );
}
