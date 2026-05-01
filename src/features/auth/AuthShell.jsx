// Shared layout for every public auth page (Sign in, Sign up, Forgot,
// Reset, Verify email). Centers the form vertically + horizontally with a
// consistent Privacy / Terms footer underneath. Keeping this in one place
// means future pages can't introduce sibling-alignment bugs.
import React from 'react';
import { Link } from 'react-router-dom';
import { useTweaks } from '../../lib/tweaks.js';

export default function AuthShell({ children }) {
  const [tweaks] = useTweaks();
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 24, gap: 18,
    }}>
      {children}
      <div style={{
        display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--muted)',
      }}>
        <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
        <Link to="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
      </div>
    </div>
  );
}
