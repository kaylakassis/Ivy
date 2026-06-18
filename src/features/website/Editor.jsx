// Main editor - 3-column layout (library | canvas | inspector) + a publish toolbar.
//
// Responsive behavior:
//   • Desktop (≥ 1024px): three columns side-by-side, full toolbar.
//   • Tablet  (721-1024): library + canvas; inspector slides in only when
//     a section is selected (no permanent right column).
//   • Mobile  (≤ 720px):  one pane at a time, switched by a tab bar.
//     Toolbar collapses to a single row of icon buttons + a "More" sheet
//     so it never overflows the viewport.
import React, { useState, useMemo, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import SectionLibrary from './SectionLibrary.jsx';
import Canvas from './Canvas.jsx';
import Inspector, { ImageInput } from './Inspector.jsx';
import AdvancedPanel from './AdvancedPanel.jsx';
import { mkSection, FONT_PAIRS } from './sections.js';
import { TEMPLATE_LIST, TEMPLATES } from './templates.js';
import { siteShareUrl } from '../../lib/publicUrl.js';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { useViewport } from '../../lib/viewport.js';

export default function Editor({
  site, set, setSection, addSection, removeSection, moveSection, moveSectionTo,
  duplicateSection,
  currentPage, currentPageId, setCurrentPageId,
  addPage, removePage, renamePage, movePage,
  reset, publish, saving, saveErr, hasUnpublishedChanges,
  schedulePublish, cancelSchedule,
  undo, redo, canUndo, canRedo,
}) {
  // Sections we're rendering / editing come from the CURRENT page,
  // not the legacy top-level site.sections. Multi-page sites have
  // pages with independent section lists; single-page sites still
  // work because state.js seeds pages[0] from the legacy sections.
  const activeSections = currentPage?.sections || site.sections || [];
  const [selectedId, setSelectedId] = useState(activeSections[0]?.id || null);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  // Reset selection when the active page changes - IDs are per-page so
  // keeping the prior selectedId would mismatch the new section list.
  useEffect(() => {
    setSelectedId(activeSections[0]?.id || null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPageId]);

  // Global Cmd/Ctrl+Z + Shift+Cmd/Ctrl+Z for undo/redo. Skipped when
  // the user is typing into an input/textarea/contentEditable so the
  // browser's native undo still works inside text fields (we don't
  // want to yank a section while someone is editing a headline).
  useEffect(() => {
    if (!undo || !redo) return;
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k !== 'z') return;
      const target = e.target;
      const tag = (target && target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo]);
  const [device, setDevice] = useState('desktop');
  const [previewMode, setPreviewMode] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [siteQrOpen, setSiteQrOpen] = useState(false);
  const [publishErr, setPublishErr] = useState(null);
  const { isMobile, isTablet } = useViewport();
  // Mobile pane: 'outline' | 'canvas' | 'inspector'. The inspector tab
  // is only enabled when a section is selected - otherwise tapping it
  // would land on an empty "click a section" placeholder.
  const [mobileTab, setMobileTab] = useState('canvas');

  const selected = useMemo(
    () => activeSections.find((s) => s.id === selectedId) || null,
    [activeSections, selectedId],
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

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const doSchedule = async () => {
    if (!scheduleAt) return;
    setScheduling(true);
    setPublishErr(null);
    try {
      await schedulePublish(new Date(scheduleAt).toISOString());
      setScheduleOpen(false);
    } catch (e) {
      setPublishErr(e.message || 'Could not schedule');
    } finally {
      setScheduling(false);
    }
  };
  const doCancelSchedule = async () => {
    try { await cancelSchedule(); } catch (e) { setPublishErr(e.message || 'Could not cancel'); }
  };
  // Share the owner's verified custom domain when connected; otherwise
  // the platform /site/<handle> URL. The "Published - live at", Copy
  // button, and QR all read from this.
  const publicUrl = siteShareUrl(site);

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
              {publicUrl ? publicUrl.replace(/^https?:\/\//, '') : 'Set a handle to publish'}
            </div>
          </div>
        </div>

        {!isMobile && <div style={{ flex: 1 }} />}

        {/* Visibility selector - Public / Link only / Only me. Mirrors
            the same control on Services + Packages so owners learn one
            mental model for "where does this show up". */}
        <SiteVisibilityButton
          visibility={site.visibility || 'public'}
          onChange={(v) => set({ visibility: v })}
          isMobile={isMobile}
        />

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

        {/* Undo / redo - sits next to the template menu so it stays
            on-screen on every viewport. Wired to global Cmd/Ctrl+Z and
            Cmd/Ctrl+Shift+Z below via a keyboard listener on document. */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-outline" disabled={!canUndo} onClick={undo}
            title="Undo (Cmd/Ctrl+Z)" style={{ padding: '6px 8px', opacity: canUndo ? 1 : 0.45 }}>
            <Icons.ArrowUp size={13} style={{ transform: 'rotate(-90deg)' }}/>
          </button>
          <button className="btn btn-outline" disabled={!canRedo} onClick={redo}
            title="Redo (Cmd/Ctrl+Shift+Z)" style={{ padding: '6px 8px', opacity: canRedo ? 1 : 0.45 }}>
            <Icons.ArrowUp size={13} style={{ transform: 'rotate(90deg)' }}/>
          </button>
        </div>

        {/* Site-style affordances - font pair + custom CSS. Both apply
            site-wide (every page, every section). */}
        <SiteStyleButton site={site} set={set}/>

        {/* Advanced - domain / forms / redirects / popups / history / traffic */}
        <button className="btn btn-outline" onClick={() => setShowAdvanced(true)}
          title="Domain, forms, redirects, history, traffic">
          <Icons.Settings size={13}/> Advanced
        </button>

        {/* Device toggle - hide on phones; the user is already on a phone
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
          {hasUnpublishedChanges && site.publishedAt && !publishing && (
            <span title="You have unpublished changes" style={{
              width: 7, height: 7, borderRadius: 99, marginLeft: 4,
              background: 'var(--warn)', display: 'inline-block',
            }}/>
          )}
        </button>

        {/* Schedule publish. If already scheduled, show the time + a way to
            cancel; otherwise a popover with a datetime-local picker. */}
        {site.scheduledPublishAt ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5,
            padding: '4px 8px', borderRadius: 8,
            background: 'var(--accent-soft)', color: 'var(--accent)',
          }}>
            <Icons.Clock size={12}/> Goes live {new Date(site.scheduledPublishAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            <button className="btn btn-ghost" onClick={doCancelSchedule} title="Cancel scheduled publish"
              style={{ padding: 2, color: 'var(--accent)' }}><Icons.X size={12}/></button>
          </span>
        ) : (
          <div style={{ position: 'relative' }}>
            <button className="btn btn-outline" onClick={() => setScheduleOpen((o) => !o)}
              disabled={!site.handle} title={!site.handle ? 'Set a handle first' : 'Schedule publish for later'}
              style={{ opacity: site.handle ? 1 : 0.6 }}>
              <Icons.Clock size={13}/>{!isMobile && <span style={{ marginLeft: 6 }}>Schedule</span>}
            </button>
            {scheduleOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, padding: 12, width: 250, boxShadow: 'var(--shadow-md)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 8 }}>
                  Publish the current draft at:
                </div>
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, marginBottom: 8 }}/>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={() => setScheduleOpen(false)} style={{ fontSize: 12 }}>Cancel</button>
                  <button className="btn btn-primary" onClick={doSchedule} disabled={!scheduleAt || scheduling} style={{ fontSize: 12 }}>
                    {scheduling ? 'Scheduling…' : 'Schedule'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

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
          <span>Published - your site is live at</span>
          <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>{publicUrl}</a>
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 6px', fontSize: 11, color: 'var(--accent)' }}
            onClick={() => { navigator.clipboard?.writeText(publicUrl); }}
          >
            <Icons.Copy size={12} /> Copy
          </button>
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 6px', fontSize: 11, color: 'var(--accent)' }}
            onClick={() => setSiteQrOpen(true)}
            title="Generate a QR code for this website"
          >
            <Icons.Image size={12} /> QR
          </button>
        </div>
      )}

      {/* Unpublished-changes cue: edits are saved as a draft and do NOT
          appear on the live site until the owner clicks Republish. Without
          this, the new draft/publish behavior would look like "my edits
          aren't showing." */}
      {site.publishedAt && hasUnpublishedChanges && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 24px', fontSize: 12,
          background: 'color-mix(in srgb, var(--warn) 12%, var(--surface))',
          color: 'var(--warn)',
          borderBottom: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
        }}>
          <Icons.Edit size={13}/>
          <span style={{ color: 'var(--fg-2)' }}>
            You have unpublished edits - saved as a draft. Click <strong>Republish</strong> to push them live.
          </span>
        </div>
      )}
      {siteQrOpen && publicUrl && (
        <QRCodeModal
          url={publicUrl}
          label={`${site.businessName || site.handle || 'Website'} QR`}
          sublabel="Print, drop in a story, or hand out at events. Anyone who scans lands on your published mini-site."
          onClose={() => setSiteQrOpen(false)}
        />
      )}

      {/* Mobile pane tab bar - only renders on phones, and only outside
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

      {/* Page tabs - sites with > 1 page show a pill row that switches
          which page is edited. Single-page sites hide it entirely so
          the bar isn't noise. The "+ Page" button appends a new page. */}
      {!previewMode && (
        <PageTabs
          pages={site.pages}
          currentPageId={currentPageId}
          onSelect={setCurrentPageId}
          onAdd={() => addPage({ title: 'New page', slug: 'page-' + (site.pages.length + 1) })}
          onRename={renamePage}
          onMove={movePage}
          onRemove={removePage}
        />
      )}

      {/* Main body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* SectionLibrary - desktop: always visible. Tablet: visible.
            Mobile: only when 'outline' tab is active. */}
        {!previewMode && (!isMobile || mobileTab === 'outline') && (
          <SectionLibrary
            site={site}
            sections={activeSections}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              // Tapping a section on mobile should jump to the inspector
              // so the user can immediately edit it - otherwise the tap
              // selects the section but leaves the user staring at the
              // same outline list with no visible feedback.
              if (isMobile) setMobileTab('inspector');
            }}
            onAdd={handleAdd}
            onMove={moveSection}
            onMoveTo={moveSectionTo}
            mobile={isMobile}
          />
        )}
        {/* Canvas - desktop/tablet always visible. Mobile: only when
            'canvas' tab is active OR when previewMode is on. */}
        {(!isMobile || mobileTab === 'canvas' || previewMode) && (
          <Canvas
            site={site}
            sections={activeSections}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              if (isMobile && id) setMobileTab('inspector');
            }}
            onSectionUpdate={setSection}
            device={device}
            previewMode={previewMode}
          />
        )}
        {/* Inspector - desktop: always. Tablet: only when a section is
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
            onDuplicate={() => selected && duplicateSection && duplicateSection(selected.id)}
            onDelete={handleDelete}
            onToggleVisible={handleToggleVisible}
            mobile={isMobile}
            currentPage={currentPage}
            onPageChange={(patch) => currentPage && renamePage(currentPage.id, patch)}
          />
        )}
      </div>
      {showAdvanced && (
        <AdvancedPanel site={site} set={set} onClose={() => setShowAdvanced(false)}/>
      )}
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

// Compact visibility dropdown for the publish toolbar. Same three
// states as the per-service / per-package picker. Click → small
// popover with three radio cards. The cog status icon next to the
// label tells the owner at a glance which mode is active without
// opening the menu.
function SiteVisibilityButton({ visibility, onChange, isMobile }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const labels = { public: 'Public', private: 'Link only', only_me: 'Only me' };
  const icons  = { public: 'Globe',  private: 'Lock',      only_me: 'EyeOff' };
  const subs   = {
    public:  'Listed on Discover and your booking page.',
    private: 'Hidden from lists. Anyone with /site/<handle> can view.',
    only_me: 'Hidden from everyone except you.',
  };
  const Icon = Icons[icons[visibility]] || Icons.Globe;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-outline" onClick={() => setOpen((o) => !o)}
        title={subs[visibility]}>
        <Icon size={13} sw={1.7}/>
        {!isMobile && <span style={{ marginLeft: 4 }}>{labels[visibility]}</span>}
        <Icons.ArrowDown size={11} sw={2}/>
      </button>
      {open && (
        <div className="card" style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60,
          minWidth: 240, padding: 8, boxShadow: 'var(--shadow)',
        }}>
          {['public', 'private', 'only_me'].map((id) => {
            const RowIcon = Icons[icons[id]] || Icons.Globe;
            const active = visibility === id;
            return (
              <button key={id} type="button"
                onClick={() => { onChange(id); setOpen(false); }}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '8px 10px', borderRadius: 8,
                  background: active ? 'var(--accent-soft)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--fg)',
                  border: 'none', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                  <RowIcon size={13} sw={1.7}/> {labels[id]}
                </span>
                <span style={{
                  fontSize: 11, color: active ? 'var(--accent)' : 'var(--muted)',
                  opacity: active ? 0.85 : 1, lineHeight: 1.45,
                }}>
                  {subs[id]}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// PageTabs - pill row above the main editor body. Renders the list of
// pages for the site, lets the owner switch which page is being edited,
// rename via prompt, reorder, and delete (with home-page protection).
function PageTabs({ pages, currentPageId, onSelect, onAdd, onRename, onMove, onRemove }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');

  if (!Array.isArray(pages) || pages.length === 0) return null;

  const startRename = (p) => {
    setEditingId(p.id);
    setDraft(p.title);
  };
  const commitRename = (p) => {
    if (draft.trim() && draft !== p.title) {
      // Auto-derive slug from title only if this isn't the home page.
      const patch = { title: draft.trim() };
      if (p.slug !== '') {
        patch.slug = draft.trim().toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .slice(0, 40);
      }
      onRename(p.id, patch);
    }
    setEditingId(null);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      padding: '10px 16px',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{
        fontSize: 11, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        marginRight: 4,
      }}>Pages</span>
      {pages.map((p) => {
        const active = p.id === currentPageId;
        const isHome = p.slug === '';
        if (editingId === p.id) {
          return (
            <input key={p.id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commitRename(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(p);
                if (e.key === 'Escape') setEditingId(null);
              }}
              autoFocus
              style={{
                padding: '5px 11px', fontSize: 12.5, borderRadius: 999,
                border: '1px solid var(--accent)',
                background: 'var(--surface)', color: 'var(--fg)',
                outline: 'none', minWidth: 120,
              }}/>
          );
        }
        return (
          <div key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
            <button
              onClick={() => onSelect(p.id)}
              onDoubleClick={() => startRename(p)}
              title="Click to switch · double-click to rename"
              style={{
                padding: '5px 11px', fontSize: 12.5,
                borderTopLeftRadius: 999, borderBottomLeftRadius: 999,
                borderTopRightRadius: !isHome ? 0 : 999,
                borderBottomRightRadius: !isHome ? 0 : 999,
                border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
                borderRight: !isHome ? '0' : undefined,
                background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: active ? 'var(--accent)' : 'var(--fg-2)',
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              {isHome && <Icons.Home size={10} sw={1.7}/>}
              {p.title}
            </button>
            {!isHome && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete page "${p.title}"? The sections on it will be removed.`)) {
                    onRemove(p.id);
                  }
                }}
                title="Delete page"
                style={{
                  padding: '5px 8px', fontSize: 11,
                  borderTopRightRadius: 999, borderBottomRightRadius: 999,
                  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
                  background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: 'var(--muted)', cursor: 'pointer',
                }}>×</button>
            )}
          </div>
        );
      })}
      <button
        onClick={onAdd}
        style={{
          padding: '5px 11px', fontSize: 12.5, borderRadius: 999,
          border: '1px dashed var(--border-strong)',
          background: 'transparent', color: 'var(--muted)',
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
        <Icons.Plus size={11} sw={2}/> Page
      </button>
    </div>
  );
}

// SiteStyleButton - toolbar dropdown that surfaces site-wide style
// + SEO overrides decoupled from the template:
//   • Font pair: 6 presets that override the template's font choice
//   • Custom CSS: textarea injected as a <style> tag inside the site
//     shell on both Canvas + PublicSite
//   • Site SEO: default title / description / share image / favicon
//     that every page inherits unless it sets its own overrides.
function SiteStyleButton({ site, set }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab]   = useState('style');
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-outline" onClick={() => setOpen((v) => !v)}
        title="Override fonts, drop custom CSS, set SEO defaults">
        <Icons.Edit size={13}/> Style &amp; SEO
        <Icons.ArrowDown size={11}/>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 60 }}/>
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 70,
            width: 380, maxHeight: '70vh', overflowY: 'auto', padding: 16,
            background: 'var(--surface)', border: '1px solid var(--border-strong)',
            borderRadius: 10, boxShadow: 'var(--shadow, 0 10px 30px rgba(0,0,0,0.16))',
            display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {[['style','Style'], ['seo','SEO']].map(([id, label]) => (
                <button key={id} type="button" onClick={() => setTab(id)}
                  style={{
                    flex: 1, padding: '7px 8px', fontSize: 12.5, fontWeight: 600,
                    border: '1px solid var(--border)',
                    background: tab === id ? 'var(--accent)' : 'var(--surface-2)',
                    color: tab === id ? 'var(--accent-ink)' : 'var(--fg)',
                    borderRadius: 8, cursor: 'pointer',
                  }}>{label}</button>
              ))}
            </div>

            {tab === 'style' && (
              <>
                <div>
                  <label style={fieldLabelSt}>Font pair</label>
                  <select value={site.fontPair || ''}
                    onChange={(e) => set({ fontPair: e.target.value || null })}
                    style={fieldInputSt}>
                    <option value="">Use template default</option>
                    {Object.entries(FONT_PAIRS).map(([id, fp]) => (
                      <option key={id} value={id}>{fp.label}</option>
                    ))}
                  </select>
                  <div style={fieldHintSt}>
                    Overrides the template's display + body fonts site-wide.
                  </div>
                </div>
                <div>
                  <label style={fieldLabelSt}>Custom CSS</label>
                  <textarea value={site.customCss || ''}
                    onChange={(e) => set({ customCss: e.target.value })}
                    placeholder="/* Style anything in your site - written exactly as standard CSS. */"
                    rows={6}
                    style={{ ...fieldInputSt, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, resize: 'vertical', minHeight: 120 }}/>
                  <div style={fieldHintSt}>
                    Injected as a &lt;style&gt; tag inside the site shell. Use to tweak
                    spacing, colors, hover states, fonts, etc. without changing the template.
                  </div>
                </div>
              </>
            )}

            {tab === 'seo' && (
              <>
                <div style={{ ...fieldHintSt, marginTop: 0 }}>
                  Defaults inherited by every page. Each page can override
                  these from the right-rail inspector.
                </div>
                <div>
                  <label style={fieldLabelSt}>Default site title</label>
                  <input type="text" value={site.seoTitle || ''}
                    onChange={(e) => set({ seoTitle: e.target.value })}
                    placeholder={site.businessName || 'Your business'}
                    maxLength={200}
                    style={fieldInputSt}/>
                </div>
                <div>
                  <label style={fieldLabelSt}>Default description</label>
                  <textarea value={site.seoDescription || ''}
                    onChange={(e) => set({ seoDescription: e.target.value })}
                    placeholder="A short pitch - shown in Google results and link previews."
                    rows={3}
                    maxLength={400}
                    style={{ ...fieldInputSt, resize: 'vertical', lineHeight: 1.5 }}/>
                </div>
                <div>
                  <label style={fieldLabelSt}>Default share image (1200×630 ideal)</label>
                  <ImageInput value={site.seoOgImage || ''}
                    onChange={(url) => set({ seoOgImage: url })}/>
                </div>
                <div>
                  <label style={fieldLabelSt}>Favicon (browser tab icon)</label>
                  <ImageInput value={site.faviconUrl || ''}
                    onChange={(url) => set({ faviconUrl: url })}
                    placeholder="https://… or upload a 64×64 PNG"/>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const fieldLabelSt = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: 'var(--muted)', letterSpacing: '0.04em',
  textTransform: 'uppercase', marginBottom: 6,
};
const fieldInputSt = {
  width: '100%', padding: '8px 11px', fontSize: 13,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--fg)', borderRadius: 8, outline: 'none',
};
const fieldHintSt = {
  fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5,
};
