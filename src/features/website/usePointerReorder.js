// Drag-to-reorder with pointer events, so it works the same with a mouse,
// a finger (iPhone / iPad, including the iPhone app) and a pen. HTML5
// `draggable` never fires on touch, which is why this replaced it.
//
// Usage: call start(e, id) from the grip's onPointerDown. The grip should
// have `touch-action: none` (only the grip, so the rest of the list still
// scrolls normally). While dragging:
//   • the pointer is captured by the grip, so moves keep arriving even when
//     the finger leaves it;
//   • `drag.gap` is the insertion gap in the FULL section list (0..n),
//     computed from the items' on-screen midpoints;
//   • the scroller auto-scrolls when the pointer nears its top or bottom;
//   • hovering an element with [data-page-drop="<pageId>"] (a page tab)
//     targets that page instead; it is outlined while targeted.
// On release, onDrop(id, gap) or onDropOnPage(id, pageId) is called. A tap
// without movement does nothing; Escape cancels.
import { useCallback, useEffect, useRef, useState } from 'react';

const START_PX = 4;   // movement before a press becomes a drag
const EDGE_PX  = 56;  // auto-scroll zone at the scroller's edges
const MAX_STEP = 22;  // px per frame at the very edge

function outline(el, on) {
  if (!el) return;
  el.style.outline = on ? '2px solid var(--accent)' : '';
  el.style.outlineOffset = on ? '2px' : '';
}

function isScrollable(el) {
  return !!el && el.scrollHeight > el.clientHeight + 1;
}

// The element that actually scrolls: the given one when it can, else its
// nearest scrolling ancestor (the app page), else the document.
function scrollTarget(el) {
  if (isScrollable(el)) return el;
  for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && isScrollable(n)) return n;
  }
  return document.scrollingElement || document.documentElement;
}

// Visible band of the scroller on screen, and how to scroll it.
function scrollerBand(el) {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const t = scrollTarget(el);
  const root = document.scrollingElement || document.documentElement;
  if (t === root) return { top: 0, bottom: vh, by: (dy) => { root.scrollTop += dy; } };
  const r = t.getBoundingClientRect();
  return { top: Math.max(0, r.top), bottom: Math.min(vh, r.bottom), by: (dy) => { t.scrollTop += dy; } };
}

export function usePointerReorder({ getScroller, getItems, onDrop, onDropOnPage }) {
  const [drag, setDrag] = useState(null); // { id, gap } while dragging
  const live = useRef(null);
  const cb = useRef({});
  cb.current = { getScroller, getItems, onDrop, onDropOnPage };

  const finish = useCallback((commit) => {
    const st = live.current;
    if (!st) return;
    live.current = null;
    cancelAnimationFrame(st.raf);
    st.cleanup();
    outline(st.pageEl, false);
    setDrag(null);
    if (!commit || !st.moved) return;
    if (st.pageEl) {
      const pageId = st.pageEl.getAttribute('data-page-drop');
      if (pageId) cb.current.onDropOnPage?.(st.id, pageId);
    } else if (st.gap != null) {
      cb.current.onDrop?.(st.id, st.gap);
    }
  }, []);

  useEffect(() => () => finish(false), [finish]);

  const start = useCallback((e, id) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
    const grip = e.currentTarget;
    try { grip.setPointerCapture(e.pointerId); } catch { /* old WebKit */ }

    const st = {
      id, pointerId: e.pointerId, x: e.clientX, y: e.clientY,
      startX: e.clientX, startY: e.clientY,
      gap: null, pageEl: null, moved: false, raf: 0, cleanup: () => {},
    };
    live.current = st;

    const compute = () => {
      let pageEl = null;
      if (cb.current.onDropOnPage) {
        const under = document.elementFromPoint(st.x, st.y);
        pageEl = under && under.closest ? under.closest('[data-page-drop]') : null;
        if (pageEl && pageEl.getAttribute('data-page-current') === '1') pageEl = null;
      }
      if (pageEl !== st.pageEl) { outline(st.pageEl, false); outline(pageEl, true); st.pageEl = pageEl; }
      let gap = null;
      if (!pageEl) {
        const items = cb.current.getItems() || [];
        for (const it of items) {
          const r = it.el.getBoundingClientRect();
          if (st.y < r.top + r.height / 2) { gap = it.index; break; }
        }
        if (gap == null && items.length) gap = items[items.length - 1].index + 1;
      }
      if (gap !== st.gap) {
        st.gap = gap;
        setDrag({ id, gap });
      }
    };

    const tick = () => {
      if (live.current !== st) return;
      if (st.moved && !st.pageEl) {
        const band = scrollerBand(cb.current.getScroller?.());
        let dy = 0;
        if (st.y < band.top + EDGE_PX) dy = -(band.top + EDGE_PX - st.y);
        else if (st.y > band.bottom - EDGE_PX) dy = st.y - (band.bottom - EDGE_PX);
        if (dy) {
          const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, Math.round(dy / 3) || Math.sign(dy)));
          band.by(step);
          compute();
        }
      }
      st.raf = requestAnimationFrame(tick);
    };

    const onMove = (ev) => {
      if (ev.pointerId !== st.pointerId) return;
      st.x = ev.clientX;
      st.y = ev.clientY;
      if (!st.moved) {
        if (Math.abs(st.x - st.startX) < START_PX && Math.abs(st.y - st.startY) < START_PX) return;
        st.moved = true;
        setDrag({ id, gap: null });
      }
      ev.preventDefault();
      compute();
    };
    const onUp = (ev) => { if (ev.pointerId === st.pointerId) finish(true); };
    const onCancel = (ev) => { if (ev.pointerId === st.pointerId) finish(false); };
    const onKey = (ev) => { if (ev.key === 'Escape') finish(false); };

    // No text selection while dragging (a mouse drag would otherwise
    // highlight the labels it passes over).
    const body = document.body;
    const prevSelect = body.style.userSelect;
    const prevWebkitSelect = body.style.webkitUserSelect;
    body.style.userSelect = 'none';
    body.style.webkitUserSelect = 'none';
    try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onCancel);
    grip.addEventListener('lostpointercapture', onUp);
    window.addEventListener('keydown', onKey);
    st.cleanup = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onCancel);
      grip.removeEventListener('lostpointercapture', onUp);
      window.removeEventListener('keydown', onKey);
      body.style.userSelect = prevSelect;
      body.style.webkitUserSelect = prevWebkitSelect;
      try { grip.releasePointerCapture(st.pointerId); } catch { /* already released */ }
    };
    st.raf = requestAnimationFrame(tick);
  }, [finish]);

  return { drag, start };
}

// Alt+ArrowUp / Alt+ArrowDown on a focused grip moves the section one place.
// Focus stays on the grip (React may move its node, which drops focus).
export function gripKeyDown(e, onMove, id) {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  e.stopPropagation();
  const grip = e.currentTarget;
  onMove?.(id, e.key === 'ArrowUp' ? 'up' : 'down');
  requestAnimationFrame(() => {
    if (grip && grip.isConnected && document.activeElement !== grip) grip.focus();
  });
}
