// Skeleton placeholders shown while data loads. Three primitives + two
// pre-composed patterns covering the layouts used across the client portal.
//
// Use a primitive for one-off cases; reach for the composed patterns first
// since they keep the rhythm consistent (height, gaps, card padding) page
// over page.
import React from 'react';

export function SkelLine({ width = '100%', height = 12, style }) {
  return (
    <span className="skel" style={{
      display: 'inline-block', width, height, ...style,
    }}/>
  );
}

export function SkelBlock({ width = '100%', height = 80, radius = 12, style }) {
  return (
    <span className="skel" style={{
      display: 'block', width, height, borderRadius: radius, ...style,
    }}/>
  );
}

export function SkelCircle({ size = 36, style }) {
  return (
    <span className="skel" style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%', ...style,
    }}/>
  );
}

// Header (title + subtitle) used at the top of every client page. Keeps
// page jumps small when real data renders.
export function SkelPageHeader() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
      <SkelLine width={220} height={26} style={{ borderRadius: 8 }}/>
      <SkelLine width={300} height={12}/>
    </div>
  );
}

// Grid of stat-card placeholders matching the .grid-auto-sm rhythm used on
// ClientHome.
export function SkelStatGrid({ count = 4 }) {
  return (
    <div className="grid-auto-sm">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card" style={{
          padding: 18, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <SkelLine width={90} height={10}/>
          <SkelLine width={64} height={26} style={{ borderRadius: 8 }}/>
        </div>
      ))}
    </div>
  );
}

// List of equally-tall row placeholders inside a card. Used for bookings,
// invoices, documents, and discover.
export function SkelRowList({ rows = 5, withAvatar = false, height = 56 }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 16px',
          borderTop: i === 0 ? 'none' : '1px solid var(--border)',
          minHeight: height,
        }}>
          {withAvatar && <SkelCircle size={32}/>}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SkelLine width={`${40 + (i * 7) % 40}%`} height={12}/>
            <SkelLine width={`${20 + (i * 11) % 35}%`} height={10}/>
          </div>
          <SkelLine width={70} height={10}/>
        </div>
      ))}
    </div>
  );
}

// Default export - a generic page skeleton used as a fallback.
export default function Skeleton() {
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SkelPageHeader/>
      <SkelStatGrid/>
      <SkelRowList/>
    </div>
  );
}
