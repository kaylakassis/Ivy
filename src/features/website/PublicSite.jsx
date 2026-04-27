// Renders the published site at /site/:handle — reads from /api/website/public/:handle.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';
import { api } from '../../lib/api.js';
import EmptyNote from '../../components/EmptyNote.jsx';

export default function PublicSite() {
  const { handle } = useParams();
  const [site, setSite]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.get(`/website/public/${encodeURIComponent(handle)}`)
      .then((r) => live && setSite(r.site))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [handle]);

  useEffect(() => {
    if (site) document.title = site.businessName || `${handle} · thryve`;
  }, [site, handle]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#FFFFFF', color: '#85827B',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  if (error || !site) {
    return (
      <div style={{ minHeight: '100vh', padding: 48, background: '#FFFFFF' }}>
        <div style={{ maxWidth: 560, margin: '80px auto' }}>
          <EmptyNote
            icon="Globe"
            title="Site not found"
            hint={`No published site for "${handle}".`}
          />
        </div>
      </div>
    );
  }

  const tpl = TEMPLATES[site.template] || TEMPLATES.clean;
  const visible = (site.sections || []).filter((s) => s.visible);

  return (
    <div style={{
      ...tpl.vars,
      minHeight: '100vh',
      background: 'var(--site-bg)',
      color: 'var(--site-fg)',
      fontFamily: 'var(--site-font-body)',
    }}>
      {visible.map((section) => (
        <SectionRenderer key={section.id} section={section} handle={site.handle} />
      ))}
    </div>
  );
}
