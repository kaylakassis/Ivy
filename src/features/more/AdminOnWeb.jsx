// What the iPhone app shows at /admin.
//
// The Admin screen is not part of the app's bundle on purpose: a phone app
// can be unpacked by anyone who installs it, and the operator tools are not
// for them to read (vite.config.js leaves the real screen out of this
// build; on the website it is only served to a signed-in operator). So in
// the app, Admin opens on the website.
import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';

export default function AdminOnWeb() {
  const { user } = useAuth();
  // The app opens from a saved copy of the account and confirms who it is
  // a moment later, so "not the operator" may only mean "not confirmed
  // yet". Never redirect on it: show a plain note that turns into the link
  // once the account is confirmed as the operator's.
  if (!user?.isSuperAdmin) {
    return (
      <div className="app-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
        <div className="card" style={{ padding: 18, fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)' }}>
          This page is not available in the app. <Link to="/dashboard" style={{ color: 'var(--accent)', fontWeight: 600 }}>Back to Home</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="app-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
      <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 24, letterSpacing: '-0.02em' }}>Admin</h2>
      <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)' }}>
          Admin opens on the website. It is kept out of the app so the operator tools are never on anyone's phone.
        </div>
        <a className="btn btn-primary" href="https://www.joinivy.ai/admin" style={{ alignSelf: 'flex-start', minHeight: 44 }}>
          Open Admin
        </a>
      </div>
    </div>
  );
}
