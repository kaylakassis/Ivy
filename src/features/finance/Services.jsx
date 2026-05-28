// Finance → Services tab. Relocated from Calendar's drawer overlay
// to a proper Finance page section so owners discover + manage them
// alongside the rest of their monetization surfaces (Products, Memberships,
// Gift cards, Packages). Re-uses the existing ServicesDrawer component
// in `inline` mode so we don't fork its 1300+ lines of editor UI.
import React from 'react';
import { useCalendar } from '../calendar/state.js';
import ServicesDrawer from '../calendar/ServicesDrawer.jsx';

export default function FinanceServices() {
  const { cal, saveServices, loading } = useCalendar();
  if (loading) {
    return <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>Loading…</div>;
  }
  return (
    <ServicesDrawer
      initial={cal?.services || []}
      onSave={saveServices}
      inline
    />
  );
}
