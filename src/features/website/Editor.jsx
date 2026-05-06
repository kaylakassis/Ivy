// Main editor — 3-column layout (library | canvas | inspector) + a publish toolbar.
//
// Responsive behavior:
//   • Desktop (≥ 1024px): three columns side-by-side, full toolbar.
//   • Tablet  (721-1024): library + canvas; inspector slides in only when
//     a section is selected (no permanent right column).
//   • Mobile  (≤ 720px):  one pane at a time, switched by a tab bar.
//     Toolbar collapses to a single row of icon buttons + a "More" sheet
//     so it never overflows the viewport.
import React, { useState, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import SectionLibrary from './SectionLibrary.jsx';
import Canvas from './Canvas.jsx';
import Inspector from './Inspector.jsx';
import { mkSection } from './sections.js';
import { TEMPLATE_LIST, TEMPLATES } from './templates.js';
import { publicOrigin } from '../../lib/publicUrl.js';
import { useViewport } from '../../lib/viewport.js';

export default function Editor({ site, set, setSection, addSection, removeSection, moveSection, reset, publish, saving, saveErr }) {
  const [selectedId, setSelectedId] = useState(site.sections[0]?.id || null);
  const [device, setDevice] = useState('desktop');
  const [previewMode, setPreviewMode] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishErr, setPublishErr] = useState(null);
  const { isMobile, isTablet } = useViewport();
  // Mobile pane: 'outline' | 'canvas' | 'inspector'. The inspector tab
  // is only enabled when a section is selected — otherwise tapping it
  // would land on an empty "click a section" placeholder.
  const [mobileTab, setMobileTab] = useState('canvas');

  const selected = useMemo(
    () => site.sections.find((s) => s.id === selectedId) || null,
    [site.sections, selectedId],
  );

  const handleAdd = (type) => {
    const sec = mkSection(type, site.businessName);
    addSection(sec);
    setSelectedId(sec.id);
    // Selecting a freshly-added section on mobile? Jump straight to the
    // inspector so the user can edit its content without an extra tap.
    if (isMobile) setMobileTab('inspector');
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
  const publicUrl = site.handle ? `${publicOrigin()}/site/${site.handle}` : null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0,
    }}>
      {/* Publish toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12,
        padding: isMobile ? '10px 14px' : '12px 24px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexWrap: isMobile ? 'wrap' : 'nowrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: isMobile ? '1 1 100%' : '0 1 auto' }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}><Icons.Globe size={15} /></div>
          <div style={{ lineHeight: 1.1, minWidth: 0, overflow: 'hidden' }}>
            <div style={{
              fontSize: 13, fontWeight: 550,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{site.businessName || 'Untitled site'}</div>
            <div style={{
              fontSize: 11, color: 'var(--muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {publicUrl ? `/site/${site.handle}` : 'Set a handle to publish'}
            </div>
          </div>
        </div>

        {!isMobile && <div style={{ flex: 1 }} />}

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

        {/* Device toggle — hide on phones; the user is already on a phone
            and doesn't need a "preview at desktop width" toggle squeezed
            into a row that's already wrapping. */}
        {!isMobile && <div style={{
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
        </div>}

        <button
          className="btn btn-outline"
          onClick={() => setPreviewMode((v) => !v)}
          style={{ flexShrink: 0 }}
        >
          <Icons.Eye size={13} />
          {!isMobile && <span style={{ marginLeft: 6 }}>{previewMode ? 'Exit preview' : 'Preview'}</span>}
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

      {/* Mobile pane tab bar — only renders on phones, and only outside
          preview mode (preview takes the whole screen). The Inspector
          tab is only enabled when something is selected. */}
      {isMobile && !previewMode && (
        <div className="web-mobile-tabs" style={{
          display: 'flex', gap: 4, padding: '8px 12px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
        }}>
          <MobilePaneTab label="Sections" icon="Plus" active={mobileTab === 'outline'}   onClick={() => setMobileTab('outline')}/>
          <MobilePaneTab label="Canvas"   icon="Eye"  active={mobileTab === 'canvas'}    onClick={() => setMobileTab('canvas')}/>
          <MobilePaneTab label="Edit"     icon="Edit" active={mobileTab === 'inspector'} onClick={() => setMobileTab('inspector')} disabled={!selected}/>
        </div>
      )}

      {/* Main body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* SectionLibrary — desktop: always visible. Tablet: visible.
            Mobile: only when 'outline' tab is active. */}
        {!previewMode && (!isMobile || mobileTab === 'outline') && (
          <SectionLibrary
            site={site}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              // Tapping a section on mobile should jump to the inspector
              // so the user can immediately edit it — otherwise the tap
              // selects the section but leaves the user staring at the
              // same outline list with no visible feedback.
              if (isMobile) setMobileTab('inspector');
            }}
            onAdd={handleAdd}
            onMove={moveSection}
            mobile={isMobile}
          />
        )}
        {/* Canvas — desktop/tablet always visible. Mobile: only when
            'canvas' tab is active OR when previewMode is on. */}
        {(!isMobile || mobileTab === 'canvas' || previewMode) && (
          <Canvas
            site={site}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              if (isMobile && id) setMobileTab('inspector');
            }}
            device={device}
            previewMode={previewMode}
          />
        )}
        {/* Inspector — desktop: always. Tablet: only when a section is
            selected (saves horizontal real estate). Mobile: only when
            'inspector' tab is active. */}
        {!previewMode && (
          (!isMobile && !isTablet)
          || (isTablet && selected)
          || (isMobile && mobileTab === 'inspector')
        ) && (
          <Inspector
            section={selected}
            onChange={(patch) => selected && setSection(selected.id, patch)}
            onMoveUp={() => selected && moveSection(selected.id, 'up')}
            onMoveDown={() => selected && moveSection(selected.id, 'down')}
            onDelete={handleDelete}
            onToggleVisible={handleToggleVisible}
            mobile={isMobile}
          />
        )}
      </div>
    </div>
  );
}

function MobilePaneTab({ label, icon, active, onClick, disabled }) {
  const Icon = Icons[icon] || Icons.More;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, minHeight: 36,
        padding: '6px 12px', borderRadius: 8,
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        background: active ? 'var(--accent-soft)' : 'var(--surface)',
        color: active ? 'var(--accent)' : disabled ? 'var(--muted)' : 'var(--fg-2)',
        fontSize: 12, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={13}/>{label}
    </button>
  );
}
