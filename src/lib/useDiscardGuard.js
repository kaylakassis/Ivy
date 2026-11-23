// "Close without saving?" for editors that only save when Save is pressed.
//
//   const guard = useDiscardGuard({ name, items, notes });   // what counts as the form's contents
//   ... after a successful save:  guard.markSaved();
//   ... instead of onClose:       <button onClick={() => guard.close(onClose)}>
//
// If nothing changed since the editor opened (or since the last save), it
// just closes. Otherwise it asks first, with "Keep editing" as the safe
// choice. Editors that can save a draft quietly on close (invoices,
// documents) do that instead of using this.
import { useCallback, useRef } from 'react';
import { confirmAction } from './confirm.js';

export function useDiscardGuard(contents) {
  const now = JSON.stringify(contents ?? null);
  const saved = useRef(now);
  const latest = useRef(now);
  latest.current = now;
  const asking = useRef(false);

  const markSaved = useCallback(() => { saved.current = latest.current; }, []);
  const isDirty = useCallback(() => saved.current !== latest.current, []);
  const close = useCallback(async (onClose) => {
    if (asking.current) return;
    if (saved.current !== latest.current) {
      asking.current = true;
      let ok = false;
      try {
        ok = await confirmAction({
          title: 'Close without saving?',
          body: 'What you changed here has not been saved.',
          confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
        });
      } finally { asking.current = false; }
      if (!ok) return;
    }
    onClose?.();
  }, []);
  return { close, markSaved, isDirty };
}
