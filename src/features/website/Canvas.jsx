// Live preview canvas. Renders the full page using the template's CSS variables,
// and makes each section click-to-select with a highlighted outline when selected.
// Selected sections get a floating action toolbar (reorder / duplicate / delete)
// and a drag grip, so the canvas is a first-class editing surface - not just a
// preview you have to leave to rearrange.
import React, { useMemo, useRef, useEffect, useState } from 'react';
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';
import { FONT_PAIRS } from './sections.js';

const DEVICE_WIDTHS = { desktop: 1200, tablet: 768, mobile: 390 };

export default function Canvas({
  site, sections, selectedId, onSelect, onSectionUpdate, device = 'desktop', previewMode = false,
  onMove, onMoveTo, onDuplicate, onDelete,
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

  // Canvas drag-reorder state. `dropAt` is the FULL-array insertion index
  // (hidden sections included) so it stays consistent with the outline's
  // drag math in SectionLibrary.jsx and with moveSectionTo().
  const [dragId, setDragId] = useState(null);
  const [dropAt, setDropAt] = useState(null);

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

  const endDrag = () => { setDragId(null); setDropAt(null); };
  const handleDrop = (e) => {
    e.preventDefault();
    if (dragId && dropAt != null && onMoveTo) {
      // Splicing the dragged item out first shifts later indexes down one.
      const srcIdx = sourceSections.findIndex((s) => s.id === dragId);
      const adj = srcIdx >= 0 && srcIdx < dropAt ? dropAt - 1 : dropAt;
      onMoveTo(dragId, adj);
    }
    endDrag();
  };

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
            onDrop={handleDrop}
            onDragOver={(e) => { if (dragId) e.preventDefault(); }}
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
                    actions={previewMode ? null : { onMove, onDuplicate, onDelete }}
                    drag={previewMode ? null : {
                      dragging: dragId === section.id,
                      showLineAbove: dragId && dragId !== section.id && dropAt === fullIdx,
                      showLineBelow: dragId && dragId !== section.id && dropAt === fullIdx + 1,
                      onGripStart: (e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        try { e.dataTransfer.setData('text/plain', section.id); } catch { /* IE-ish */ }
                        setDragId(section.id);
                      },
                      onGripEnd: endDrag,
                      onFrameOver: (e) => {
                        if (!dragId || dragId === section.id) return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        const before = (e.clientY - r.top) < r.height / 2;
                        const next = before ? fullIdx : fullIdx + 1;
                        setDropAt((d) => (d === next ? d : next));
                      },
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
  isFirst, isLast, actions, drag,
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
  return (
    <div
      onClick={handleClick}
      onDragOver={drag?.onFrameOver}
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
        }}>
          {section.type}
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
          }}>
          <span
            draggable
            onDragStart={drag?.onGripStart}
            onDragEnd={drag?.onGripEnd}
            title="Drag to reorder"
            style={{ ...tbBtn, cursor: 'grab', fontSize: 13, letterSpacing: 1 }}
          >⠿</span>
          <button style={{ ...tbBtn, opacity: isFirst ? 0.35 : 1 }} disabled={isFirst}
            title="Move up" onClick={() => actions.onMove?.(section.id, 'up')}>↑</button>
          <button style={{ ...tbBtn, opacity: isLast ? 0.35 : 1 }} disabled={isLast}
            title="Move down" onClick={() => actions.onMove?.(section.id, 'down')}>↓</button>
          <button style={tbBtn} title="Duplicate section"
            onClick={() => actions.onDuplicate?.(section.id)}>⧉</button>
          <button style={{ ...tbBtn, color: '#ff8a80' }} title="Delete section"
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
  width: 26, height: 24, borderRadius: 6, cursor: 'pointer',
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
