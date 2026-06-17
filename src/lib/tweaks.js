// Persisted UI preferences (visual direction, layout).
import { useEffect, useState } from 'react';

const KEY = 'Ivy OS:tweaks';
const DEFAULTS = { direction: 'bold', layout: 'desktop' };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return DEFAULTS; }
}

export function useTweaks() {
  const [tweaks, setTweaks] = useState(load);
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(tweaks)); }, [tweaks]);
  const setKey = (k, v) => setTweaks((t) => ({ ...t, [k]: v }));
  return [tweaks, setKey];
}
