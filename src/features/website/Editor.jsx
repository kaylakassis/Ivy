// Main editor — 3-column layout (library | canvas | inspector) + a publish toolbar.
import React, { useState, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import SectionLibrary from './SectionLibrary.jsx';
import Canvas from './Canvas.jsx';
import Inspector from './Inspector.jsx';
import { mkSection } from './sections.js';
import { TEMPLATE_LIST, TEMPLATES } from './templates.js';

export default function Editor({ site, set, setSection, addSection, removeSection, moveSection, reset, publish, saving, saveErr }) {
  const [selectedId, setSelectedId] = useState(site.sections[0]?.id || null);
  const [device, setDevice] = useState('desktop');
  const [previewMode, setPreviewMode] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishErr, setPublishErr] = useState(null);

  const selected = useMemo(
    () => site.sections.find((s) => s.id === selectedId) || null,
    [site.sections, selectedId],
  );

  const handleAdd = (type) => {
    const sec = mkSection(type, site.businessName);
    addSection(sec);
    setSelectedId(sec.id);
  };

  const handleDelete = () => {
    if (!selected) return;
    removeSection(selected.id);
    setSelectedId(null);
  };

  const handleToggleVisible = () => {
    if (!selected) return;
    setSection(selected.id, { visible: !selected.visible });
  };

  const handlePublish = async () => {
    setPublishing(true);
    setPublishErr(null);
    try {
      await publish();
    } catch (e) {
      setPublishErr(e.message || 'Publish failed');
    } finally {
      setPublishing(false);
    }
  };
  const publicUrl = site.handle ? `${window.location.origin}/site/${site.handle}` : null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0,
    }}>
      {/* Publish toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 24px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Globe size={15} /></div>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontSize: 13, fontWeight: 550 }}>{site.businessName || 'Untitled site'}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {publicUrl ? `/site/${site.handle}` : 'Set a handle to publish'}
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* Template selector */}
        <div style={{ position: 'relative' }}>
          <button className="btn btn-outline" onClick={() => setShowTemplateMenu((v) => !v)}>
            <span style={{
              width: 12, height: 12, borderRadius: 99,
              background: TEMPLATES[site.template]?.vars['--site-accent'],
              display: 'inline-block',
            }} />
            {TEMPLATES[site.template]?.name || 'Template'}
            <Icons.ArrowDown size={12} />
          </button>
          {showTemplateMenu && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50,
              minWidth: 240, padding: 6,
              background: 'var(--surface)', border: '1px solid var(--border-strong)',
              borderRadius: 10, boxShadow: 'var(--shadow)',
            }}>
              {TEMPLATE_LIST.map((t) => (
                <button key={t.id}
                  onClick={() => { set({ template: t.id }); setShowTemplateMenu(false); }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8,
                    background: site.template === t.id ? 'var(--accent-soft)' : 'transparent',
                    textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  <div style={{
                    width: 24, height: 24, borderRadius: 6,
                    background: t.vars['--site-bg'],
                    border: `1px solid ${t.vars['--site-border']}`,
                    position: 'relative', flexShrink: 0,
                  }}>
                    <div style={{
                      position: 'absolute', inset: 4, borderRadius: 3,
                      background: t.vars['--site-accent'],
                    }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Device toggle */}
        <div style={{
          display: 'flex', gap: 2, padding: 3,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 8,
        }}>
          {[
            { id: 'desktop', label: 'Desktop', icon: 'Globe' },
            { id: 'tablet',  label: 'Tablet',  icon: 'FileIcon' },
            { id: 'mobile',  label: 'Mobile',  icon: 'Phone' },
          ].map((d) => {
            const Icon = Icons[d.icon];
            const on = device === d.id;
            return (
              <button key={d.id} onClick={() => setDevice(d.id)}
                title={d.label}
                style={{
                  padding: '5px 9px', borderRadius: 6,
                  background: on ? 'var(--surface)' : 'transparent',
                  color: on ? 'var(--fg)' : 'var(--muted)',
                  border: on ? '1px solid var(--border)' : '1px solid transparent',
                  boxShadow: on ? 'var(--shadow-sm)' : 'none',
                }}>
                <Icon size={13} sw={1.7} />
              </button>
            );
          })}
        </div>

        <button
          className="btn btn-outline"
          onClick={() => setPreviewMode((v) => !v)}
        >
          <Icons.Eye size={13} /> {previewMode ? 'Exit preview' : 'Preview'}
        </button>

        <button
          className="btn btn-primary"
          onClick={handlePublish}
          disabled={publishing || !site.handle}
          title={!site.handle ? 'Set a handle first' : (publicUrl ? `Publish to ${publicUrl}` : 'Publish')}
          style={{ opacity: (publishing || !site.handle) ? 0.6 : 1 }}
        >
          <Icons.Arrow size={13} sw={2} />
          {publishing ? 'Publishing…' : site.publishedAt ? 'Republish' : 'Publish'}
        </button>

        {(saving || saveErr || publishErr) && (
          <span style={{ fontSize: 11, color: saveErr || publishErr ? 'var(--danger)' : 'var(--muted)' }}>
            {publishErr || (saveErr ? `Save failed: ${saveErr.message}` : 'Saving…')}
          </span>
        )}

        <button className="btn btn-ghost" title="Reset site" onClick={() => { if (confirm('Reset your website? This clears all content.')) reset(); }}>
          <Icons.Settings size={14} />
        </button>
      </div>

      {/* Published banner */}
      {site.publishedAt && publicUrl && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 24px',
          background: 'var(--accent-soft)', color: 'var(--accent)',
          borderBottom: '1px solid var(--accent-tint)',
          fontSize: 12,
        }}>
          <Icons.Check size={14} />
          <span>Published — your site is live at</span>
          <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>{publicUrl}</a>
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 6px', fontSize: 11, color: 'var(--accent)' }}
            onClick={() => { navigator.clipboard?.writeText(publicUrl); }}
          >
            <Icons.Copy size={12} /> Copy
          </button>
        </div>
      )}

      {/* Main body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!previewMode && (
          <SectionLibrary
            site={site}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAdd={handleAdd}
            onMove={moveSection}
          />
        )}
        <Canvas
          site={site}
          selectedId={selectedId}
          onSelect={setSelectedId}
          device={device}
          previewMode={previewMode}
        />
        {!previewMode && (
          <Inspector
            section={selected}
            onChange={(patch) => selected && setSection(selected.id, patch)}
            onMoveUp={() => selected && moveSection(selected.id, 'up')}
            onMoveDown={() => selected && moveSection(selected.id, 'down')}
            onDelete={handleDelete}
            onToggleVisible={handleToggleVisible}
          />
        )}
      </div>
    </div>
  );
}
