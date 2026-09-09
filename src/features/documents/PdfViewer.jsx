// Shared PDF page renderer. Loads pdfjs-dist asynchronously (it's a
// 300+ KB dep so we don't want it in the main bundle) and renders each
// page into a canvas. Caller wraps each page with field overlays.
//
// Hosts a worker via `?url` import so Vite emits it as a static asset
// instead of trying to bundle it.
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

// Renders all pages of `url`. Calls onPagesReady(count) once we know
// the page count. children is a render prop:
//   ({ pageIndex, pageWidth, pageHeight, container }) => React node
// drawn ABOVE each canvas so callers can place absolutely-positioned
// field overlays.
export default function PdfViewer({
  url,
  scale = 1.4,
  onPagesReady,
  onPageDimensions,
  renderOverlay,
}) {
  const [doc, setDoc] = useState(null);
  const [pages, setPages] = useState([]); // [{ idx, width, height }]
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const containerRefs = useRef({});

  // Latest callbacks without making them effect dependencies: callers pass
  // inline arrows, which would re-run the effect on every parent render.
  const cbs = useRef({ onPagesReady, onPageDimensions });
  cbs.current = { onPagesReady, onPageDimensions };

  // 1. Load the document and work out page sizes. This only sets state -
  //    it deliberately does NOT draw, because the canvases it would draw
  //    into do not exist until React has committed `pages`.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setPages([]); setDoc(null);
    containerRefs.current = {};
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const loaded = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;
        const count = loaded.numPages;
        cbs.current.onPagesReady?.(count);
        const pageList = [];
        for (let i = 1; i <= count; i++) {
          // eslint-disable-next-line no-await-in-loop
          const page = await loaded.getPage(i);
          const viewport = page.getViewport({ scale });
          pageList.push({ idx: i - 1, width: viewport.width, height: viewport.height });
          cbs.current.onPageDimensions?.(i - 1, viewport.width, viewport.height);
        }
        if (cancelled) return;
        setDoc(loaded);
        setPages(pageList);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [url, scale]);

  // 2. Draw, once the canvases are actually on screen. Running this in the
  //    same pass as the load raced React's commit: the refs were still empty,
  //    every page was skipped, and the viewer showed blank 300x150 canvases
  //    with no error - which is what a signer would have seen.
  useEffect(() => {
    if (!doc || pages.length === 0) return undefined;
    let cancelled = false;
    const tasks = [];
    (async () => {
      for (const p of pages) {
        if (cancelled) return;
        const canvas = containerRefs.current[p.idx];
        if (!canvas) continue;
        // eslint-disable-next-line no-await-in-loop
        const page = await doc.getPage(p.idx + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        tasks.push(task);
        try {
          // eslint-disable-next-line no-await-in-loop
          await task.promise;
        } catch (e) {
          // A cancelled render (url/scale changed mid-draw) is expected.
          if (!cancelled && e?.name !== 'RenderingCancelledException') {
            setError(e);
            return;
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      // Stop in-flight rasterisation so a fast url change can't have two
      // renders writing to the same canvas.
      tasks.forEach((t) => { try { t.cancel(); } catch { /* already done */ } });
    };
  }, [doc, pages, scale]);

  if (error) {
    return (
      <div style={{
        padding: 16, borderRadius: 10,
        background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
        color: 'var(--danger)', fontSize: 13,
      }}>Couldn't load PDF: {error.message || 'unknown error'}</div>
    );
  }
  if (loading) {
    return <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading PDF…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
      {pages.map((p) => (
        <div key={p.idx} style={{
          position: 'relative',
          width: p.width, height: p.height,
          background: '#fff',
          boxShadow: 'var(--shadow-sm)',
          borderRadius: 4,
          overflow: 'hidden',
        }}>
          <canvas
            ref={(el) => { containerRefs.current[p.idx] = el; }}
            style={{ display: 'block', width: '100%', height: '100%' }}
          />
          {typeof renderOverlay === 'function' && (
            <div style={{ position: 'absolute', inset: 0 }}>
              {renderOverlay({ pageIndex: p.idx, pageWidth: p.width, pageHeight: p.height })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
