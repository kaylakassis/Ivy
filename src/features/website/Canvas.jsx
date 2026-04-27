// Live preview canvas. Renders the full page using the template's CSS variables,
// and makes each section click-to-select with a highlighted outline when selected.
import React, { useMemo, useRef, useEffect, useState } from 'react';
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';

const DEVICE_WIDTHS = { desktop: 1200, tablet: 768, mobile: 390 };

export default function Canvas({ site, selectedId, onSelect, device = 'desktop', previewMode = false }) {
  const tpl = TEMPLATES[site.template] || TEMPLATES.clean;
  const width = DEVICE_WIDTHS[device] || DEVICE_WIDTHS.desktop;

  const wrapRef  = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [innerH, setInnerH] = useState(0);

  // Fit the scaled preview to the available canvas width, then measure
  // the inner content so the outer wrapper reserves the correct height
  // (transform: scale alone doesn't reduce the element's box in layout).
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
  }, [width, site.sections, site.template]);

  const tplStyle = useMemo(() => tpl.vars, [tpl]);
  const visibleSections = site.sections.filter((s) => s.visible);

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
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionFrame({ section, selected, onSelect, previewMode, handle }) {
  const handleClick = (e) => {
    if (!onSelect) return;
    e.stopPropagation();
    onSelect(section.id);
  };
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
      <SectionRenderer section={section} handle={handle} />
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
