// Loader - the branded "something is loading" block that pairs with
// LoadingLine. Replaces the plain spinner wherever a LoadingLine shows.
//
//   (1) the Ivy mark (/icon-512.png, 56px; rounded square on owner
//       surfaces, a circle on client-facing ones) breathing gently,
//   (2) two pulse rings expanding out of it (second one half a beat later),
//   (3) three accent dots bouncing under the mark,
//   (4) the LoadingLine text beneath (14px, muted).
//
// Nothing shows before `delay` ms so fast loads never flash. Under
// prefers-reduced-motion the mark and dots sit still (dots at .7) and only
// the line fades (global.css). `compact` is the 36px dots-only variant for
// Ivy's dock, where the chat already shows her avatar.
//
//   <Loader/>                           route fallback / page loading, owner
//   <Loader set="client"/>              client portal + public pages
//   <Loader delay={600}/>               auth check
//   <Loader compact delay={1200}/>      Ivy thinking (dock)
import React, { useEffect, useState } from 'react';
import LoadingLine from './LoadingLine.jsx';

export default function Loader({ set = 'owner', delay = 300, compact = false, minHeight, style, line = true }) {
  const [show, setShow] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return undefined;
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  if (compact) {
    return (
      <div className="loader loader-compact" data-loader data-shown={show ? '1' : '0'} style={style}>
        {show && (
          <>
            <Dots/>
            {line && <LoadingLine set={set} delay={0} align="left" style={{ marginTop: 6, padding: 0, fontSize: 13 }}/>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="loader" data-loader data-shown={show ? '1' : '0'} role="status" aria-label="Loading" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: minHeight ?? 160, padding: 16, ...style,
    }}>
      {show && (
        <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className={`loader-mark ${set === 'client' ? 'loader-mark-round' : ''}`}>
            <span className="loader-ring"/>
            <span className="loader-ring loader-ring-2"/>
            <img src="/icon-512.png" alt="" draggable="false"/>
          </div>
          <Dots/>
          {line && <LoadingLine set={set} delay={0} style={{ fontSize: 14, marginTop: 10 }}/>}
        </div>
      )}
    </div>
  );
}

function Dots() {
  return (
    <div className="loader-dots" aria-hidden="true">
      <span/><span/><span/>
    </div>
  );
}
