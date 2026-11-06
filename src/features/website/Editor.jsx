// Main editor - 3-column layout (library | canvas | inspector) + a publish toolbar.
//
// Responsive behavior:
//   • Desktop (≥ 1024px): three columns side-by-side, full toolbar.
//   • Tablet  (721-1024): library + canvas; inspector slides in only when
//     a section is selected (no permanent right column).
//   • Mobile  (≤ 720px):  one pane at a time, switched by a tab bar.
//     Toolbar collapses to a single row of icon buttons + a "More" sheet
//     so it never overflows the viewport.
import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { PagePicker, ConfirmDialog, ActionToast } from './EditorOverlays.jsx';
import { findSectionPage } from './pageTransforms.js';
import SectionLibrary from './SectionLibrary.jsx';
import Canvas from './Canvas.jsx';
import Inspector, { ImageInput } from './Inspector.jsx';
import AdvancedPanel from './AdvancedPanel.jsx';
import { mkSection, FONT_PAIRS, SECTION_TYPES } from './sections.js';
import { TEMPLATE_LIST, TEMPLATES } from './templates.js';
import { siteShareUrl } from '../../lib/publicUrl.js';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { useViewport } from '../../lib/viewport.js';

export default function Editor({
  site, set, setSection, addSection, removeSection, moveSection, moveSectionTo,
  duplicateSection, moveSectionToPage, copySectionToPage,
  currentPage, currentPageId, setCurrentPageId,
  addPage, removePage, renamePage, movePage,
  reset, publish, saving, saveErr, hasUnpublishedChanges,
  schedulePublish, cancelSchedule, discardChanges, restoreVersion,
  undo, redo, canUndo, canRedo,
}) {
  // Sections we're rendering / editing come from the CURRENT page,
  // not the legacy top-level site.sections. Multi-page sites have
  // pages with independent section lists; single-page sites still
  // work because state.js seeds pages[0] from the legacy sections.
  const activeSections = currentPage?.sections || site.sections || [];
  const [selectedId, setSelectedId] = useState(activeSections[0]?.id || null);
  // Set by "View" after a move/copy: the section to select once the editor
  // has switched to its page.
  const pendingSelectRef = useRef(null);
  // Reset selection when the active page changes - IDs are per-page so
  // keeping the prior selectedId would mismatch the new section list.
  useEffect(() => {
    const want = pendingSelectRef.current;
    pendingSelectRef.current = null;
    setSelectedId(want && activeSections.some((s) => s.id === want) ? want : (activeSections[0]?.id || null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPageId]);

  // Global Cmd/Ctrl+Z + Shift+Cmd/Ctrl+Z (and Ctrl+Y) for undo/redo.
  // Skipped when the user is typing into an input/textarea/contentEditable
  // so the browser's native undo still works inside text fields (we don't
  // want to yank a section while someone is editing a headline).
  useEffect(() => {
    if (!undo || !redo) return;
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && !(k === 'y' && e.ctrlKey && !e.metaKey)) return;
      const target = e.target;
      const tag = (target && target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
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

  // ── Move / copy a section to another page ─────────────────────────
  const [picker, setPicker] = useState(null);   // { sectionId, mode }
  const [toast, setToast] = useState(null);     // ActionToast payload
  const closeToast = useCallback(() => setToast(null), []);
  const sectionLabel = (id) => {
    const page = findSectionPage(site.pages, id);
    const sec = page?.sections.find((x) => x.id === id);
    return SECTION_TYPES[sec?.type]?.label || 'This section';
  };
  const pageTitle = (pageId, fallback) => (site.pages.find((p) => p.id === pageId)?.title) || fallback || 'the page';
  // Switch to a page and select a section on it (the toast's "View").
  const goToSection = (pageId, sectionId) => {
    if (pageId === currentPageId) setSelectedId(sectionId);
    else { pendingSelectRef.current = sectionId; setCurrentPageId(pageId); }
    if (isMobile) setMobileTab('canvas');
    setTimeout(() => {
      const el = document.querySelector(`[data-frame-id="${CSS.escape(sectionId)}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  };
  const doMoveOrCopy = ({ sectionId, mode, target, position }) => {
    const fromTitle = pageTitle(findSectionPage(site.pages, sectionId)?.id, 'this page');
    const newTitle = target && typeof target === 'object' ? (target.title || 'New page') : null;
    if (mode === 'copy') {
      const r = copySectionToPage(sectionId, target, position);
      if (!r.copied) return;
      const title = newTitle || pageTitle(r.pageId);
      setToast({ text: `Copied to ${title}.`, actionLabel: 'View', onAction: () => goToSection(r.pageId, r.newId) });
      return;
    }
    const r = moveSectionToPage(sectionId, target, position);
    if (!r.moved) return;
    if (selectedId === sectionId) setSelectedId(null);
    const title = newTitle || pageTitle(r.pageId);
    let sub = null;
    if (r.relinked) sub = `${r.relinked === 1 ? 'A button' : `${r.relinked} buttons`} on ${fromTitle} that pointed to it now ${r.relinked === 1 ? 'opens' : 'open'} the ${title} page.`;
    else if (r.unlinked) sub = `${r.unlinked === 1 ? 'A button' : `${r.unlinked} buttons`} on ${fromTitle} pointed to it. Check ${r.unlinked === 1 ? 'its' : 'their'} link.`;
    setToast({ text: `Moved to ${title}.`, sub, actionLabel: 'View', onAction: () => goToSection(r.pageId, sectionId) });
  };
  const openPicker = (sectionId, mode) => { setToast(null); setPicker({ sectionId, mode }); };
  // Dropping a dragged section on a page tab moves it to the end of that page.
  const dropOnPage = (sectionId, pageId) => doMoveOrCopy({ sectionId, mode: 'move', target: pageId, position: 'bottom' });

  // ── Discard changes (back to the published version) ───────────────
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardErr, setDiscardErr] = useState(null);
  const confirmDiscard = async () => {
    setDiscardBusy(true);
    setDiscardErr(null);
    try {
      await discardChanges();
      setDiscardOpen(false);
      setToast({ text: 'Changes discarded.', sub: 'Your draft matches your live site again.', actionLabel: 'Undo', onAction: undo });
    } catch (e) {
      setDiscardErr(e.message || 'Could not discard changes. Try again.');
    } finally {
      setDiscardBusy(false);
    }
  };
  const canDiscard = !!(site.publishedAt && hasUnpublishedChanges && discardChanges);

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
  const [moreOpen, setMoreOpen] = useState(false);
  const showSecondary = !isMobile || moreOpen;

  // The editor fits the screen: the page itself never scrolls, so the
  // preview, the section list and the inspector each scroll on their own
  // (body.ivy-fill in global.css gives the shell a definite height, the
  // same mode the Ivy screen uses).
  useLayoutEffect(() => {
    document.body.classList.add('ivy-fill');
    return () => document.body.classList.remove('ivy-fill');
  }, []);

  return (
    <div className="ivy-fill-page website-editor" style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0,
    }}>
      {/* Publish toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12,
        padding: isMobile ? '10px 14px' : '12px 24px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap', rowGap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: isMobile ? '1 1 0' : '0 1 auto', order: isMobile ? -5 : undefined }}>
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
              {publicUrl ? publicUrl.replace(/^https?:\/\//, '') : 'Choose a site address to publish'}
            </div>
          </div>
        </div>

        {!isMobile && <div style={{ flex: 1 }} />}

        {/* Visibility selector - Public / Link only / Only me. Mirrors
            the same control on Services + Packages so owners learn one
            mental model for "where does this show up". */}
        {showSecondary && <SiteVisibilityButton
          visibility={site.visibility || 'public'}
          onChange={(v) => set({ visibility: v })}
          isMobile={isMobile}
        />}

        {/* Template selector */}
        {showSecondary && <div style={{ position: 'relative' }}>
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
        </div>}

        {/* Undo / redo - sits next to the template menu so it stays
            on-screen on every viewport (labels on desktop, icons with
            aria-labels on phones). Undo reaches back to the last publish.
            Wired to the keyboard shortcuts above. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, order: isMobile ? -4 : undefined }}>
          <UndoRedo undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} compact={isMobile}/>
          {/* Phones: the status only takes room when it says something
              that needs attention (or the More row is open). */}
          {(!isMobile || saveErr || publishErr) && (
            <DraftStatus saving={saving} saveErr={saveErr} publishErr={publishErr}
              published={!!site.publishedAt} hasUnpublishedChanges={hasUnpublishedChanges}/>
          )}
        </div>

        {/* Site-style affordances - font pair + custom CSS. Both apply
            site-wide (every page, every section). */}
        {showSecondary && <SiteStyleButton site={site} set={set}/>}

        {/* Advanced - domain / forms / redirects / popups / history / traffic */}
        {showSecondary && <button className="btn btn-outline" onClick={() => setShowAdvanced(true)}
          title="Domain, forms, redirects, history, traffic">
          <Icons.Settings size={13}/> Advanced
        </button>}

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

        {(showSecondary || previewMode) && <button
          className="btn btn-outline"
          onClick={() => setPreviewMode((v) => !v)}
          style={{ flexShrink: 0 }}
        >
          <Icons.Eye size={13} />
          {(!isMobile || previewMode) && <span style={{ marginLeft: 6 }}>{previewMode ? 'Exit preview' : 'Preview'}</span>}
        </button>}

        <button
          className="btn btn-primary"
          onClick={handlePublish}
          disabled={publishing || !site.handle}
          title={!site.handle ? 'Choose your site address first' : (publicUrl ? `Publish to ${publicUrl}` : 'Publish')}
          style={{ opacity: (publishing || !site.handle) ? 0.6 : 1, order: isMobile ? -3 : undefined }}
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

        {/* Phones: one row (name, undo/redo, publish, More). Everything
            else opens under it, so the preview keeps most of the screen. */}
        {isMobile && (
          <button className="btn btn-outline" onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen} aria-label={moreOpen ? 'Fewer options' : 'More options'}
            style={{ flexShrink: 0, minWidth: 40, justifyContent: 'center', order: -2 }}>
            {moreOpen ? <Icons.X size={14}/> : <Icons.More size={14}/>}
          </button>
        )}
        {isMobile && moreOpen && <div style={{ flexBasis: '100%', height: 0, order: -1 }}/>}
        {isMobile && moreOpen && !saveErr && !publishErr && (
          <div style={{ flexBasis: '100%' }}>
            <DraftStatus saving={saving} saveErr={saveErr} publishErr={publishErr}
              published={!!site.publishedAt} hasUnpublishedChanges={hasUnpublishedChanges}/>
          </div>
        )}

        {/* Schedule publish. If already scheduled, show the time + a way to
            cancel; otherwise a popover with a datetime-local picker. */}
        {!showSecondary ? null : site.scheduledPublishAt ? (
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
              disabled={!site.handle} title={!site.handle ? 'Choose your site address first' : 'Schedule publish for later'}
              style={{ opacity: site.handle ? 1 : 0.6 }}>
              <Icons.Clock size={13}/>{!isMobile && <span style={{ marginLeft: 6 }}>Schedule</span>}
            </button>
            {scheduleOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, padding: 12, width: 'min(250px, calc(100vw - 24px))', boxShadow: 'var(--shadow-md)',
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


        {/* Destructive - distinct icon + color so it can't be mistaken
            for the Advanced-settings cog next to it. */}
        {showSecondary && <button className="btn btn-ghost" title="Start over (clears all draft content)"
          style={{ color: 'var(--danger)' }}
          onClick={() => {
            if (confirm('Start over? This clears ALL pages and sections from your draft.\n\nYour published version history is kept (Advanced → History), but the current draft cannot be recovered.')) reset();
          }}>
          <Icons.Trash size={14} />
        </button>}
      </div>

      {/* Published banner (phones: inside More, the name row already shows the address) */}
      {site.publishedAt && publicUrl && showSecondary && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 10, flexWrap: 'wrap',
          padding: isMobile ? '8px 14px' : '8px 24px',
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
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: isMobile ? '8px 14px' : '8px 24px', fontSize: 12,
          background: 'color-mix(in srgb, var(--warn) 12%, var(--surface))',
          color: 'var(--warn)',
          borderBottom: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
        }}>
          <Icons.Edit size={13}/>
          <span style={{ color: 'var(--fg-2)', flex: '1 1 220px', minWidth: 0 }}>
            You have unpublished edits, saved as a draft. Click <strong>Republish</strong> to push them live.
          </span>
          {canDiscard && (
            <button type="button" className="btn btn-outline" onClick={() => { setToast(null); setDiscardErr(null); setDiscardOpen(true); }}
              title="Go back to the version that is live now"
              style={{ padding: '5px 10px', fontSize: 12, minHeight: isMobile ? 36 : undefined }}>
              <Icons.Undo size={13}/> Discard changes
            </button>
          )}
        </div>
      )}
      {discardOpen && (
        <ConfirmDialog
          title="Discard all changes since you last published?"
          body="Your live site is not affected. You can undo this right after."
          confirmLabel="Discard changes"
          danger busy={discardBusy} error={discardErr} mobile={isMobile}
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardOpen(false)}
        />
      )}
      {picker && (
        <PagePicker
          initialMode={picker.mode}
          sectionLabel={sectionLabel(picker.sectionId)}
          pages={site.pages}
          fromPageId={findSectionPage(site.pages, picker.sectionId)?.id}
          mobile={isMobile}
          onClose={() => setPicker(null)}
          onSubmit={({ mode, target, position }) => {
            const sectionId = picker.sectionId;
            setPicker(null);
            doMoveOrCopy({ sectionId, mode, target, position });
          }}
        />
      )}
      <ActionToast toast={toast} onClose={closeToast}/>
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
          onRename={(pageId, patch) => {
            // Renaming auto-derives a new slug. If the page was already
            // published under the old slug, add a 301 automatically so
            // inbound links (Instagram bio, business cards) keep working.
            const p = (site.pages || []).find((x) => x.id === pageId);
            if (p && patch.slug && patch.slug !== p.slug && p.slug !== '' && site.publishedAt) {
              const existing = site.redirects || [];
              if (!existing.some((r) => r.from === p.slug)) {
                set({ redirects: [...existing, { from: p.slug, to: `/${patch.slug}` }] });
              }
            }
            renamePage(pageId, patch);
          }}
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
            onPagePicker={moveSectionToPage ? openPicker : null}
            onDropOnPage={moveSectionToPage ? dropOnPage : null}
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
            onMove={moveSection}
            onMoveTo={moveSectionTo}
            onDuplicate={(id) => duplicateSection && duplicateSection(id)}
            onDelete={(id) => { removeSection(id); if (selectedId === id) setSelectedId(null); }}
            onPagePicker={moveSectionToPage ? openPicker : null}
            onDropOnPage={moveSectionToPage ? dropOnPage : null}
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
            onMoveToPage={moveSectionToPage && selected ? () => openPicker(selected.id, 'move') : null}
            onCopyToPage={copySectionToPage && selected ? () => openPicker(selected.id, 'copy') : null}
            mobile={isMobile}
            currentPage={currentPage}
            onPageChange={(patch) => currentPage && renamePage(currentPage.id, patch)}
            pages={site.pages}
            sections={activeSections}
            onOpenLibrary={() => {
              // Desktop: the library is the left rail, already visible; just
              // deselect so the eye lands on "Add section". Phone: switch tab.
              setSelectedId(null);
              if (isMobile) setMobileTab('outline');
            }}
          />
        )}
      </div>
      {showAdvanced && (
        <AdvancedPanel site={site} set={set} restoreVersion={restoreVersion} onClose={() => setShowAdvanced(false)}/>
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
    private: 'Hidden from lists. Anyone with the link can view.',
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

const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const UNDO_KEYS = IS_MAC ? '⌘Z' : 'Ctrl+Z';
const REDO_KEYS = IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z';

// Undo / Redo buttons. Text labels on desktop; icon-only (with aria-labels)
// on phones, where the toolbar is tight.
function UndoRedo({ undo, redo, canUndo, canRedo, compact }) {
  const btn = (enabled) => ({
    padding: compact ? '6px 10px' : '6px 11px', minHeight: compact ? 36 : undefined,
    opacity: enabled ? 1 : 0.45, cursor: enabled ? 'pointer' : 'default',
  });
  return (
    <div role="group" aria-label="Undo and redo" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
      <button type="button" className="btn btn-outline" disabled={!canUndo} onClick={undo}
        aria-label="Undo" title={canUndo ? `Undo (${UNDO_KEYS})` : 'Nothing to undo since you last published'}
        style={btn(canUndo)}>
        <Icons.Undo size={14} sw={1.8}/>{!compact && <span>Undo</span>}
      </button>
      <button type="button" className="btn btn-outline" disabled={!canRedo} onClick={redo}
        aria-label="Redo" title={`Redo (${REDO_KEYS})`}
        style={btn(canRedo)}>
        <Icons.Redo size={14} sw={1.8}/>{!compact && <span>Redo</span>}
      </button>
    </div>
  );
}

// Where the owner's edits stand: saving, saved as a draft, or all live.
function DraftStatus({ saving, saveErr, publishErr, published, hasUnpublishedChanges }) {
  let text; let color = 'var(--muted)'; let icon = null;
  if (publishErr) { text = publishErr; color = 'var(--danger)'; }
  else if (saveErr) { text = `Save failed: ${saveErr.message}`; color = 'var(--danger)'; }
  else if (saving) text = 'Saving…';
  else if (published && !hasUnpublishedChanges) { text = 'All changes published'; icon = <Icons.Check size={12} sw={2}/>; }
  else text = 'Saved as draft';
  return (
    <span role="status" aria-live="polite" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11.5, color, whiteSpace: icon || color === 'var(--muted)' ? 'nowrap' : 'normal', flexShrink: 0,
    }}>{icon}{text}</span>
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
              data-page-drop={p.id}
              data-page-current={active ? '1' : '0'}
              title="Click to switch · double-click to rename · drop a section here to move it to this page"
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
// + search / sharing defaults decoupled from the template:
//   • Font pair: presets that override the template's font choice
//   • Site search listing: default title / description / share image /
//     browser-tab icon that every page inherits unless it sets its own.
// Owners never see code here. A site that already has customCss (set
// before code was removed from the builder) gets a plain note with a
// way to clear it; the field itself is no longer offered.
function SiteStyleButton({ site, set }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab]   = useState('style');
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-outline" onClick={() => setOpen((v) => !v)}
        title="Fonts, search listing and share image">
        <Icons.Edit size={13}/> Style &amp; search
        <Icons.ArrowDown size={11}/>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 60 }}/>
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 70,
            width: 'min(380px, calc(100vw - 24px))', maxHeight: '70vh', overflowY: 'auto', padding: 16,
            background: 'var(--surface)', border: '1px solid var(--border-strong)',
            borderRadius: 10, boxShadow: 'var(--shadow, 0 10px 30px rgba(0,0,0,0.16))',
            display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {[['style','Fonts'], ['seo','Search and sharing']].map(([id, label]) => (
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
                  <label style={fieldLabelSt}>Fonts</label>
                  <select value={site.fontPair || ''}
                    onChange={(e) => set({ fontPair: e.target.value || null })}
                    style={fieldInputSt}>
                    <option value="">Use the template's fonts</option>
                    {Object.entries(FONT_PAIRS).map(([id, fp]) => (
                      <option key={id} value={id}>{fp.label}</option>
                    ))}
                  </select>
                  <div style={fieldHintSt}>
                    Changes the headline and body fonts on every page.
                  </div>
                </div>
                {site.customCss ? (
                  <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)', border: '1px dashed var(--border)' }}>
                    <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                      This site has extra styling that was added with code before Ivy stopped using code. It still applies. You can clear it here.
                    </div>
                    <button type="button" className="btn btn-outline" onClick={() => set({ customCss: '' })}
                      style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>
                      Clear the extra styling
                    </button>
                  </div>
                ) : null}
              </>
            )}

            {tab === 'seo' && (
              <>
                <div style={{ ...fieldHintSt, marginTop: 0 }}>
                  Used by every page unless a page sets its own (click an empty
                  spot on the canvas to set a page's own).
                </div>
                <div>
                  <label style={fieldLabelSt}>Site name shown in Google</label>
                  <input type="text" value={site.seoTitle || ''}
                    onChange={(e) => set({ seoTitle: e.target.value })}
                    placeholder={site.businessName || 'Your business'}
                    maxLength={200}
                    style={fieldInputSt}/>
                </div>
                <div>
                  <label style={fieldLabelSt}>Short description shown in Google</label>
                  <textarea value={site.seoDescription || ''}
                    onChange={(e) => set({ seoDescription: e.target.value })}
                    placeholder="A short pitch - shown in Google results and when the link is shared."
                    rows={3}
                    maxLength={400}
                    style={{ ...fieldInputSt, resize: 'vertical', lineHeight: 1.5 }}/>
                </div>
                <div>
                  <label style={fieldLabelSt}>Image shown when the site is shared (a wide photo works best)</label>
                  <ImageInput value={site.seoOgImage || ''}
                    onChange={(url) => set({ seoOgImage: url })}/>
                </div>
                <div>
                  <label style={fieldLabelSt}>Browser tab icon</label>
                  <ImageInput value={site.faviconUrl || ''}
                    onChange={(url) => set({ faviconUrl: url })}
                    placeholder="Upload a small square image"/>
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
