// useSuccessFlash - add `.btn-success` to a button for 600ms after a
// Save / Approve resolved. global.css pulses the background to the ok
// colour and back. Usage:
//
//   const [flashCls, flash] = useSuccessFlash();
//   ... await save(); flash();
//   <button className={`btn btn-primary ${flashCls}`}>Save</button>
import { useCallback, useEffect, useRef, useState } from 'react';

export const FLASH_MS = 600;

export function useSuccessFlash() {
  const [on, setOn] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    // Re-trigger even if a flash is still running: drop the class for a
    // frame so the animation restarts.
    setOn(false);
    requestAnimationFrame(() => {
      setOn(true);
      timer.current = setTimeout(() => { timer.current = null; setOn(false); }, FLASH_MS);
    });
  }, []);
  return [on ? 'btn-success' : '', flash, on];
}

export default useSuccessFlash;
