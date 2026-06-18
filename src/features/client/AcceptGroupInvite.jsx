// /invite/group/:token landing page. Pulls the token from the URL,
// POSTs to /api/me/groups/accept-invite. If the user isn't signed in
// yet, redirects to /signup?next=<current> so they can claim, then
// returns here.
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useClientPortal } from './clientContext.jsx';

export default function AcceptGroupInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { data: ctx, loading: ctxLoading } = useClientPortal();
  const [status, setStatus] = useState('idle'); // idle | accepting | done | error
  const [error, setError]   = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (ctxLoading) return;
    if (!ctx?.user) {
      // Not signed in - bounce to signup with a return URL.
      const next = encodeURIComponent(`/invite/group/${token}`);
      navigate(`/signup?next=${next}`, { replace: true });
      return;
    }
    if (status !== 'idle') return;
    setStatus('accepting');
    api.post('/me/groups/accept-invite', { token })
      .then((r) => {
        setResult(r);
        setStatus('done');
      })
      .catch((e) => {
        setError(e);
        setStatus('error');
      });
  }, [token, ctx, ctxLoading, status, navigate]);

  if (ctxLoading || status === 'idle' || status === 'accepting') {
    return <CenteredCard title="Joining group…" body="Hang tight."/>;
  }
  if (status === 'error') {
    return <CenteredCard title="Couldn't accept invite" body={error?.message || 'Try again.'}
      cta={{ label: 'Open my portal', onClick: () => navigate('/me') }}/>;
  }
  if (status === 'done' && result?.groupId) {
    return <Navigate to={`/me/messages?group=${result.groupId}`} replace/>;
  }
  return <CenteredCard title="All set" body="" cta={{ label: 'Open my portal', onClick: () => navigate('/me') }}/>;
}

function CenteredCard({ title, body, cta }) {
  return (
    <div style={{
      minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div className="card" style={{ padding: 28, maxWidth: 440, textAlign: 'center' }}>
        <EmptyNote icon="Chat" title={title} hint={body}/>
        {cta && (
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={cta.onClick}>
            {cta.label}
          </button>
        )}
      </div>
    </div>
  );
}
