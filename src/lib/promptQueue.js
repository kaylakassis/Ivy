// One prompt at a time.
//
// Anything that asks the owner for something (the billing strip, "confirm
// your email", the next set-up step, 2-step verification, notifications)
// takes a number here instead of just appearing. Only the one
// with the lowest rank is shown; the rest wait their turn, so the owner
// never has two things asking for attention at once.
//
// A component asks with usePromptSlot(id, wants, rank). It gets back true
// only while it is the one that may show. Leaving the screen gives the turn
// to whoever is next.
import { useEffect, useSyncExternalStore } from 'react';

export const PROMPT_RANK = {
  billing: 10,       // payment failed, trial ending, account ending
  verifyEmail: 20,   // confirm your email
  homeRequired: 30,  // Home: the next required set-up step (or "you're ready")
  push: 40,          // iPhone: turn on notifications
  home: 60,          // Home: everything optional (2-step, switching, invite...)
};

const claims = new Map(); // id -> rank
const listeners = new Set();
let top = null;

function settle() {
  let best = null;
  let bestRank = Infinity;
  for (const [id, rank] of claims) {
    if (rank < bestRank) { best = id; bestRank = rank; }
  }
  if (best !== top) {
    top = best;
    listeners.forEach((l) => l());
  }
}

export function claimPrompt(id, rank) { claims.set(id, rank); settle(); }
export function releasePrompt(id) { if (claims.delete(id)) settle(); }
export function topPrompt() { return top; }
export function _resetPromptsForTests() { claims.clear(); top = null; }

function subscribe(l) { listeners.add(l); return () => listeners.delete(l); }

export function usePromptSlot(id, wants, rank) {
  const current = useSyncExternalStore(subscribe, topPrompt, () => null);
  useEffect(() => {
    if (!wants) return undefined;
    claimPrompt(id, rank);
    return () => releasePrompt(id);
  }, [id, wants, rank]);
  return !!wants && current === id;
}
