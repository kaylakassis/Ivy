// Finance → Packages tab. Same relocation as Services — formerly a
// Calendar drawer, now an inline Finance page section. Owners reach
// packages alongside Products / Memberships / Gift cards.
import React from 'react';
import { useCalendar } from '../calendar/state.js';
import PackagesDrawer from '../calendar/PackagesDrawer.jsx';

export default function FinancePackages() {
  const { cal, loading } = useCalendar();
  if (loading) {
    return <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>Loading…</div>;
  }
  return (
    <PackagesDrawer services={cal?.services || []} inline />
  );
}
