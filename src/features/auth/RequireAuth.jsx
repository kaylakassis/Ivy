// Redirects to /signin if there's no authenticated user.
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const [tweaks] = useTweaks();
  const location = useLocation();

  if (loading) {
    return (
      <div className={`app-root dir-${tweaks.direction}`} style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', fontSize: 13,
      }}>
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return children;
}
