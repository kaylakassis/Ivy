import React from 'react';
import { useParams } from 'react-router-dom';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function PublicBooking() {
  const { slug } = useParams();
  const [tweaks] = useTweaks();
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', padding: 48 }}>
      <div className="card" style={{ padding: 48, maxWidth: 720, margin: '40px auto' }}>
        <h1 className="page-title" style={{ margin: 0, fontSize: 28 }}>Book with {slug}</h1>
        <div style={{ marginTop: 24 }}>
          <EmptyNote icon="Calendar" title="Booking page — port in progress"
            hint="The business owner's available slots will show here, live from their calendar." />
        </div>
      </div>
    </div>
  );
}
