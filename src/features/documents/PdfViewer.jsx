// Shared PDF page renderer. Loads pdfjs-dist asynchronously (it's a
// 300+ KB dep so we don't want it in the main bundle) and renders each
// page into a canvas. Caller wraps each page with field overlays.
//
// Hosts a worker via `?url` import so Vite emits it as a static asset
// instead of trying to bundle it.
import React, { useEffect, useRef, useState } from 'react';

let pdfjsPromise = null;

async function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const lib = await import('pdfjs-dist/build/pdf.mjs');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
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
  const [pages, setPages] = useState([]); // [{ idx, width, height, canvasRef }]
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const containerRefs = useRef({});
  const renderToken = useRef(0);

  useEffect(() => {
    let cancelled = false;
    renderToken.current += 1;
    const myToken = renderToken.current;
    setLoading(true); setError(null); setPages([]);

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const loadingTask = pdfjs.getDocument({ url });
        const pdf = await loadingTask.promise;
        if (cancelled || myToken !== renderToken.current) return;
        const count = pdf.numPages;
        if (typeof onPagesReady === 'function') onPagesReady(count);
        const pageList = [];
        for (let i = 1; i <= count; i++) {
          // eslint-disable-next-line no-await-in-loop
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale });
          pageList.push({ idx: i - 1, width: viewport.width, height: viewport.height });
          if (typeof onPageDimensions === 'function') {
            onPageDimensions(i - 1, viewport.width, viewport.height);
          }
        }
        if (cancelled || myToken !== renderToken.current) return;
        setPages(pageList);
        setLoading(false);

        // Render after pages mount.
        for (const p of pageList) {
          // eslint-disable-next-line no-await-in-loop
          const page = await pdf.getPage(p.idx + 1);
          const viewport = page.getViewport({ scale });
          const canvas = containerRefs.current[p.idx];
          if (!canvas) continue;
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          // eslint-disable-next-line no-await-in-loop
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled || myToken !== renderToken.current) return;
        }
      } catch (e) {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [url, scale]);

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
