// Phase-2 placeholder for /me/bookings, /me/invoices, /me/documents.
// Real implementations land in the next commit.
import React from 'react';
import EmptyNote from '../../components/EmptyNote.jsx';

export default function ClientStub({ icon, title, hint }) {
  return (
    <div className="page-pad">
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon={icon} title={title} hint={hint}/>
      </div>
    </div>
  );
}
