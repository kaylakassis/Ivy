// Tutorial state - one round-trip on app boot pulls every tab's
// completion status, and PATCH updates persist the user-side decision.
//
// Lifecycle:
//   1. AppShell mounts <TutorialProvider> once (inside the auth-gated
//      shell so an unauthenticated user never triggers a request).
//   2. Pages call useTutorial() to read their own tab's state and
//      open / mark-complete / mark-skipped.
//   3. The Topbar's auto-trigger effect opens the modal when a user
//      lands on a tab they've never seen and the GET has resolved.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const TutorialCtx = createContext(null);

export function TutorialProvider({ children }) {
  const [tutorials, setTutorials] = useState(null); // null = loading, {} = empty
  const [activeTabId, setActiveTabId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/me/tutorials')
      .then((r) => { if (live) setTutorials(r.tutorials || {}); })
      .catch((e) => {
        if (!live) return;
        setError(e);
        // Fail soft - never let a tutorial fetch crash the app shell.
        // An empty map means everything looks unseen which is the
        // worst-case behavior; better than blocking nav.
        setTutorials({});
      });
    return () => { live = false; };
  }, []);

  // Mark a tab complete or skipped. Optimistic so the modal can close
  // immediately; rollback on failure is rare enough to skip in v1.
  const recordStatus = useCallback(async (tabId, status) => {
    setTutorials((prev) => ({ ...(prev || {}), [tabId]: status }));
    try {
      await api.patch('/me/tutorials', { tabId, status });
    } catch (e) {
      // Optimistic - don't surface; the next page-load GET will be
      // authoritative. If the PATCH consistently fails it'll show up
      // in the user's Vercel logs.
      // eslint-disable-next-line no-console
      console.warn('[tutorial] PATCH failed:', e?.message);
    }
  }, []);

  const open = useCallback((tabId) => setActiveTabId(tabId), []);
  const close = useCallback(() => setActiveTabId(null), []);

  const seen = useCallback(
    (tabId) => Boolean(tutorials && tutorials[tabId]),
    [tutorials],
  );

  return (
    <TutorialCtx.Provider value={{
      tutorials, error,
      activeTabId, open, close,
      seen,
      complete:  (tabId) => { recordStatus(tabId, 'completed'); close(); },
      skip:      (tabId) => { recordStatus(tabId, 'skipped');   close(); },
      ready: tutorials !== null,
    }}>
      {children}
    </TutorialCtx.Provider>
  );
}

export function useTutorial() {
  const ctx = useContext(TutorialCtx);
  if (!ctx) {
    // No provider - return a no-op object so a page rendered outside
    // the shell (e.g. Storybook, isolated dev preview) doesn't crash.
    return {
      tutorials: {}, ready: false, error: null,
      activeTabId: null, open: () => {}, close: () => {},
      seen: () => true, complete: () => {}, skip: () => {},
    };
  }
  return ctx;
}
