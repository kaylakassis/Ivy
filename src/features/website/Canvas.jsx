// Live preview canvas. Renders the full page using the template's CSS variables,
// and makes each section click-to-select with a highlighted outline when selected.
import React, { useMemo, useRef, useEffect, useState } from 'react';
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';
import { FONT_PAIRS } from './sections.js';

const DEVICE_WIDTHS = { desktop: 1200, tablet: 768, mobile: 390 };

export default function Canvas({ site, sections, selectedId, onSelect, onSectionUpdate, device = 'desktop', previewMode = false }) {
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
              visibleSections.map((section) => (
                <SectionFrame
                  key={section.id}
                  section={section}
                  selected={section.id === selectedId}
                  onSelect={previewMode ? null : onSelect}
                  previewMode={previewMode}
                  handle={site.handle}
                  onSectionUpdate={onSectionUpdate}
                />
              ))
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

function SectionFrame({ section, selected, onSelect, previewMode, handle, onSectionUpdate }) {
  const handleClick = (e) => {
    if (!onSelect) return;
    e.stopPropagation();
    onSelect(section.id);
  };
  // Selected + not preview = headlines + body copy are inline-editable.
  // Renderers that support it (Hero, About, CtaBanner, Stats) gate the
  // contentEditable handling on this `editable` flag.
  const editable = selected && !previewMode && !!onSectionUpdate;
  return (
    <div
      onClick={handleClick}
      style={{
        position: 'relative',
        cursor: previewMode ? 'default' : 'pointer',
        outline: selected ? '2px solid var(--accent)' : 'none',
        outlineOffset: -2,
      }}
    >
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
      <SectionRenderer
        section={section}
        handle={handle}
        editable={editable}
        onUpdate={editable ? (patch) => onSectionUpdate(section.id, patch) : null}
      />
    </div>
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
