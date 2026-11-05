// Shared PDF page renderer. Loads pdfjs-dist asynchronously (it's a
// 300+ KB dep so we don't want it in the main bundle) and renders each
// page into a canvas. Caller draws field overlays on top of each page.
//
// Sizing: pages fit the width of their container (a 390px phone shows a
// whole page width, a desktop drawer shows it up to `maxScale` times its
// point size), and the canvas is drawn at the screen's pixel density so
// text stays crisp on Retina screens. Pages are drawn as they come near
// the screen, so a long contract doesn't stall a phone.
//
// Uses pdfjs-dist's LEGACY build deliberately. The default build targets
// very recent engines - it calls Map.prototype.getOrInsertComputed, a 2025
// proposal - and throws "getOrInsertComputed is not a function" on anything
// older, which shows up as a blank page rather than an error. The legacy
// build is transpiled and polyfilled, so contracts still render for a client
// signing on an older phone or browser.
import React, { useEffect, useRef, useState } from 'react';

let pdfjsPromise = null;

async function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  })();
  return pdfjsPromise;
}

// Keep canvases within what iOS Safari will allocate.
const MAX_CANVAS_PX = 4096;

// renderOverlay: ({ pageIndex, pageWidth, pageHeight }) => node, drawn
// ABOVE each page (sizes in CSS pixels) so callers can place
// absolutely-positioned field overlays.
export default function PdfViewer({
  url,
  scale,             // legacy prop: treated as maxScale
  maxScale,
  onPagesReady,
  onPageDimensions,
  renderOverlay,
}) {
  const cap = maxScale || scale || 1.5;
  const [doc, setDoc] = useState(null);
  const [base, setBase] = useState([]);     // [{ idx, w, h }] in PDF points (rotation applied)
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [width, setWidth] = useState(0);    // container width in CSS px
  const wrapRef = useRef(null);
  const canvases = useRef({});
  const drawn = useRef({});                 // idx → css width it was drawn at
  const cbs = useRef({ onPagesReady, onPageDimensions });
  cbs.current = { onPagesReady, onPageDimensions };

  // 1. Load the document and read each page's size.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setBase([]); setDoc(null);
    canvases.current = {}; drawn.current = {};
    let loaded = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        loaded = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
        if (cancelled) return;
        const count = loaded.numPages;
        cbs.current.onPagesReady?.(count);
        const list = [];
        for (let i = 1; i <= count; i++) {
          // eslint-disable-next-line no-await-in-loop
          const page = await loaded.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          list.push({ idx: i - 1, w: vp.width, h: vp.height });
        }
        if (cancelled) return;
        setDoc(loaded);
        setBase(list);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e); setLoading(false); }
      }
    })();
    return () => { cancelled = true; try { loaded?.destroy(); } catch { /* ignore */ } };
  }, [url]);

  // 2. Track the container width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const sizes = base.map((p) => {
    const cssW = Math.max(120, Math.min(width || p.w, p.w * cap));
    return { idx: p.idx, cssW, cssH: cssW * (p.h / p.w), base: p };
  });

  useEffect(() => {
    sizes.forEach((s) => cbs.current.onPageDimensions?.(s.idx, s.cssW, s.cssH));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, base]);

  // 3. Draw pages as they come near the screen (and redraw on resize).
  useEffect(() => {
    if (!doc || base.length === 0 || !width) return undefined;
    let cancelled = false;
    const tasks = new Map();
    const draw = async (idx) => {
      const s = sizes[idx];
      const canvas = canvases.current[idx];
      if (!s || !canvas || drawn.current[idx] === s.cssW || tasks.has(idx)) return;
      try {
        const page = await doc.getPage(idx + 1);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        let renderScale = (s.cssW / s.base.w) * dpr;
        const maxSide = Math.max(s.base.w, s.base.h) * renderScale;
        if (maxSide > MAX_CANVAS_PX) renderScale *= MAX_CANVAS_PX / maxSide;
        const viewport = page.getViewport({ scale: renderScale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        tasks.set(idx, task);
        await task.promise;
        tasks.delete(idx);
        if (!cancelled) drawn.current[idx] = s.cssW;
      } catch (e) {
        tasks.delete(idx);
        if (!cancelled && e?.name !== 'RenderingCancelledException') setError(e);
      }
    };
    let io = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.isIntersecting) draw(Number(en.target.getAttribute('data-pdf-page')));
        }
      }, { rootMargin: '600px 0px' });
      Object.values(canvases.current).forEach((c) => c && io.observe(c.parentElement));
    } else {
      (async () => { for (const s of sizes) { if (cancelled) return; await draw(s.idx); } })();
    }
    return () => {
      cancelled = true;
      io?.disconnect();
      tasks.forEach((t) => { try { t.cancel(); } catch { /* done */ } });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, base, width]);

  if (error) {
    return (
      <div style={{
        padding: 16, borderRadius: 10,
        background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
        color: 'var(--danger)', fontSize: 13,
      }}>Couldn't load the PDF. Check your connection and try again.</div>
    );
  }

  return (
    <div ref={wrapRef} style={{ width: '100%', minWidth: 0 }}>
      {loading ? (
        <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading PDF…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
          {sizes.map((s) => (
            <div key={s.idx} data-pdf-page={s.idx} style={{
              position: 'relative',
              width: s.cssW, height: s.cssH,
              background: '#fff',
              boxShadow: 'var(--shadow-sm)',
              borderRadius: 4,
              flexShrink: 0,
            }}>
              <canvas
                ref={(el) => { canvases.current[s.idx] = el; }}
                aria-label={`Page ${s.idx + 1}`}
                style={{ display: 'block', width: '100%', height: '100%', borderRadius: 4 }}
              />
              {typeof renderOverlay === 'function' && (
                <div style={{ position: 'absolute', inset: 0 }}>
                  {renderOverlay({ pageIndex: s.idx, pageWidth: s.cssW, pageHeight: s.cssH })}
                </div>
              )}
              {sizes.length > 1 && (
                <div style={{
                  position: 'absolute', right: 6, bottom: -14, fontSize: 10, color: 'var(--muted)',
                  pointerEvents: 'none',
                }}>{s.idx + 1} / {sizes.length}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
