// useEscapeKey - runs `onEscape` whenever the user presses Esc.
// Pass `enabled = false` to temporarily skip (e.g. when the modal is
// closed but the component is still mounted).
//
// Listens on `window` with `keydown` so it catches the keypress no
// matter where focus is inside the modal. Cleans up the listener on
// unmount or when `enabled` flips false to avoid the typical
// "modal closes but keys still trigger handler" bug.
import { useEffect } from 'react';

export function useEscapeKey(onEscape, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscape(e);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onEscape, enabled]);
}
