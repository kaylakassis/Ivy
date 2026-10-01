// Finance → Services tab. Relocated from Calendar's drawer overlay
// to a proper Finance page section so owners discover + manage them
// alongside the rest of their monetization surfaces (Products, Memberships,
// Gift cards, Packages). Re-uses the existing ServicesDrawer component
// in `inline` mode so we don't fork its 1300+ lines of editor UI.
import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCalendar } from '../calendar/state.js';
import ServicesDrawer from '../calendar/ServicesDrawer.jsx';

export default function FinanceServices() {
  const { cal, saveServices, loading } = useCalendar();
  // ?service=<id> (search palette hit, forwarded from /calendar) opens
  // that service's editor. Read once, then strip so a refresh doesn't
  // reopen it after the user closes the modal.
  const location = useLocation();
  const navigate = useNavigate();
  const [openId] = useState(() => new URLSearchParams(location.search).get('service'));
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('service')) return;
    params.delete('service');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (loading) {
    return <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>Loading…</div>;
  }
  return (
    <ServicesDrawer
      initial={cal?.services || []}
      onSave={saveServices}
      openId={openId}
      inline
    />
  );
}
