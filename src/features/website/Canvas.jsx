// Live preview canvas. Renders the full page using the template's CSS variables,
// and makes each section click-to-select with a highlighted outline when selected.
// Selected sections get a floating action toolbar (reorder / duplicate / delete
// / move or copy to another page) and a drag grip, so the canvas is a
// first-class editing surface - not just a preview you have to leave to
// rearrange. Dragging uses pointer events (usePointerReorder) so it works with
// a mouse, a finger and a pen.
import React, { useMemo, useRef, useEffect, useState } from 'react';
import { usePointerReorder, gripKeyDown } from './usePointerReorder.js';
import { SECTION_TYPES } from './sections.js';
import { dropGapToIndex } from './pageTransforms.js';
import { ActionMenu } from './EditorOverlays.jsx';
import { ensureBuilderFonts } from '../../lib/builderFonts.js';
// These modules only load when a customer site is rendered or edited, so
// requesting the builder font palette here keeps it off every other page.
ensureBuilderFonts();
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';
import { FONT_PAIRS } from './sections.js';

const DEVICE_WIDTHS = { desktop: 1200, tablet: 768, mobile: 390 };

export default function Canvas({
  site, sections, selectedId, onSelect, onSectionUpdate, device = 'desktop', previewMode = false,
  onMove, onMoveTo, onDuplicate, onDelete, onPagePicker, onDropOnPage,
}) {
  const tpl = TEMPLATES[site.template] || TEMPLATES.clean;
  const width = DEVICE_WIDTHS[device] || DEVICE_WIDTHS.desktop;
  // Editor passes the current-page's sections in; fall back to legacy
  // site.sections for single-page sites that pre-date the multi-page
  // migration.
  const sourceSections = Array.isArray(sections) ? sections : (site.sections || []);

  const wrapRef  = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [innerH, setInnerH] = useState(0);

  // Canvas drag-reorder. `drag.gap` is the FULL-array insertion gap
  // (hidden sections included) so it stays consistent with the outline's
  // drag math in SectionLibrary.jsx and with moveSectionTo().
  const { drag, start: startDrag } = usePointerReorder({
    getScroller: () => wrapRef.current,
    getItems: () => Array.from(innerRef.current?.querySelectorAll('[data-frame-id]') || [])
      .map((el) => ({ el, index: Number(el.getAttribute('data-full-index')) })),
    onDrop: (id, gap) => {
      const idx = dropGapToIndex(gap, sourceSections.findIndex((s) => s.id === id));
      if (idx != null && onMoveTo) onMoveTo(id, idx);
    },
    onDropOnPage,
  });
  const dragId = drag?.id || null;
  const dragSrcIdx = dragId ? sourceSections.findIndex((s) => s.id === dragId) : -1;
  const dropAt = drag && dropGapToIndex(drag.gap, dragSrcIdx) != null ? drag.gap : null;

  useEffect(() => {
    if (!wrapRef.current || !innerRef.current) return;
    const update = () => {
      const avail = wrapRef.current.clientWidth - 48;
      const s = Math.min(1, avail / width);
      setScale(s);
      setInnerH(innerRef.current.offsetHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapRef.current);
    ro.observe(innerRef.current);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [width, sourceSections, site.template, site.fontPair, site.customCss]);

  // Build CSS-var bag: template defaults first, font-pair override
  // on top (so a font_pair preset wins over the template's fonts).
  const tplStyle = useMemo(() => {
    const vars = { ...tpl.vars };
    const fp = site.fontPair && FONT_PAIRS[site.fontPair];
    if (fp) {
      vars['--site-font-display'] = fp.display;
      vars['--site-font-body']    = fp.body;
    }
    return vars;
  }, [tpl, site.fontPair]);
  const visibleSections = sourceSections.filter((s) => s.visible);

  return (
    <div
      ref={wrapRef}
      className="scroll"
      style={{
        flex: 1,
        background: 'var(--surface-2)',
        overflow: 'auto',
        padding: 24,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
      }}
    >
      <div style={{
        width: width * scale,
        height: innerH * scale,
        position: 'relative',
      }}>
        <div
          ref={innerRef}
          style={{
            width,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            position: 'absolute', top: 0, left: 0,
          }}
        >
          <div
            style={{
              ...tplStyle,
              background: 'var(--site-bg)',
              color: 'var(--site-fg)',
              fontFamily: 'var(--site-font-body)',
              borderRadius: 14,
              overflow: 'hidden',
              boxShadow: '0 30px 60px -30px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.04)',
              border: '1px solid var(--border)',
            }}
          >
            {visibleSections.length === 0 ? (
              <EmptyCanvas />
            ) : (
              visibleSections.map((section, vi) => {
                const fullIdx = sourceSections.findIndex((s) => s.id === section.id);
                return (
                  <SectionFrame
                    key={section.id}
                    section={section}
                    selected={section.id === selectedId}
                    onSelect={previewMode ? null : onSelect}
                    previewMode={previewMode}
                    handle={site.handle}
                    onSectionUpdate={onSectionUpdate}
                    isFirst={vi === 0}
                    isLast={vi === visibleSections.length - 1}
                    fullIndex={fullIdx}
                    scale={scale}
                    actions={previewMode ? null : { onMove, onDuplicate, onDelete, onPagePicker }}
                    drag={previewMode ? null : {
                      dragging: dragId === section.id,
                      showLineAbove: dropAt != null && dragId !== section.id && dropAt === fullIdx,
                      showLineBelow: dropAt != null && dragId !== section.id && dropAt === fullIdx + 1,
                      onGripDown: (e) => startDrag(e, section.id),
                    }}
                  />
                );
              })
            )}
            {/* Owner-supplied CSS - wraps the rendered tree so styles
                scope naturally to within the site shell. Empty when no
                customCss is set. */}
            {site.customCss && <style>{site.customCss}</style>}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionFrame({
  section, selected, onSelect, previewMode, handle, onSectionUpdate,
  isFirst, isLast, actions, drag, fullIndex, scale = 1,
}) {
  const handleClick = (e) => {
    if (!onSelect) return;
    e.stopPropagation();
    onSelect(section.id);
  };
  // Selected + not preview = headlines + body copy are inline-editable.
  // Renderers that support it (Hero, About, CtaBanner, Stats) gate the
  // contentEditable handling on this `editable` flag.
  const editable = selected && !previewMode && !!onSectionUpdate;
  const showToolbar = selected && !previewMode && actions;
  // The canvas is scaled to fit (a 1200px page on a phone is ~0.3x). The
  // label and toolbar are scaled back up so they stay real-size and
  // tappable at any zoom.
  const unscale = scale > 0 && scale < 1 ? 1 / scale : 1;
  return (
    <div
      onClick={handleClick}
      data-frame-id={section.id}
      data-full-index={fullIndex}
      style={{
        position: 'relative',
        cursor: previewMode ? 'default' : 'pointer',
        outline: selected ? '2px solid var(--accent)' : 'none',
        outlineOffset: -2,
        opacity: drag?.dragging ? 0.35 : 1,
      }}
    >
      {drag?.showLineAbove && <DropLine top/>}
      {drag?.showLineBelow && <DropLine/>}
      {selected && !previewMode && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 2,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          padding: '3px 8px', fontSize: 10, fontWeight: 600,
          borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase',
          transform: unscale !== 1 ? `scale(${unscale})` : undefined, transformOrigin: 'top left',
        }}>
          {SECTION_TYPES[section.type]?.label || 'Section'}
        </div>
      )}
      {showToolbar && (
        <div
          data-canvas-toolbar
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 3,
            display: 'flex', alignItems: 'center', gap: 2,
            background: 'rgba(17,18,16,0.92)', color: '#fff',
            borderRadius: 8, padding: 3,
            boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
            transform: unscale !== 1 ? `scale(${unscale})` : undefined, transformOrigin: 'top right',
          }}>
          <button
            type="button"
            data-grip-id={section.id}
            onPointerDown={drag?.onGripDown}
            onKeyDown={(e) => gripKeyDown(e, actions.onMove, section.id)}
            title="Drag to reorder (or Alt+Up / Alt+Down)"
            aria-label="Drag to reorder. Alt plus Up or Down arrow moves the section."
            style={{ ...tbBtn, cursor: drag?.dragging ? 'grabbing' : 'grab', fontSize: 13, letterSpacing: 1, touchAction: 'none' }}
          >⠿</button>
          <button style={{ ...tbBtn, opacity: isFirst ? 0.35 : 1 }} disabled={isFirst}
            title="Move up" aria-label="Move up" onClick={() => actions.onMove?.(section.id, 'up')}>↑</button>
          <button style={{ ...tbBtn, opacity: isLast ? 0.35 : 1 }} disabled={isLast}
            title="Move down" aria-label="Move down" onClick={() => actions.onMove?.(section.id, 'down')}>↓</button>
          <button style={tbBtn} title="Duplicate section" aria-label="Duplicate section"
            onClick={() => actions.onDuplicate?.(section.id)}>⧉</button>
          {actions.onPagePicker && (
            <ActionMenu label="More section actions" buttonStyle={tbBtn} items={[
              { label: 'Move to page…', icon: 'MoveTo', onClick: () => actions.onPagePicker(section.id, 'move') },
              { label: 'Copy to page…', icon: 'Copy', onClick: () => actions.onPagePicker(section.id, 'copy') },
            ]}>
              <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>⋯</span>
            </ActionMenu>
          )}
          <button style={{ ...tbBtn, color: '#ff8a80' }} title="Delete section" aria-label="Delete section"
            onClick={() => actions.onDelete?.(section.id)}>✕</button>
        </div>
      )}
      <SectionRenderer
        section={section}
        handle={handle}
        editable={editable}
        onUpdate={editable ? (patch) => onSectionUpdate(section.id, patch) : null}
      />
    </div>
  );
}

const tbBtn = {
  background: 'transparent', border: 'none', color: 'inherit',
  width: 30, height: 28, borderRadius: 6, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, lineHeight: 1, padding: 0,
};

// Accent insertion marker shown while dragging a section over a frame.
function DropLine({ top }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, height: 3, zIndex: 4,
      top: top ? -2 : 'auto', bottom: top ? 'auto' : -2,
      background: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)',
      pointerEvents: 'none',
    }}/>
  );
}

function EmptyCanvas() {
  return (
    <div style={{
      padding: '120px 48px', textAlign: 'center',
      color: 'var(--site-muted)',
    }}>
      <div style={{ fontFamily: 'var(--site-font-display)', fontSize: 28, color: 'var(--site-fg)' }}>Blank page</div>
      <div style={{ marginTop: 12, fontSize: 14 }}>Add a section from the library on the left.</div>
    </div>
  );
}
