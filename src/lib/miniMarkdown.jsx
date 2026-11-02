// Tiny, dependency-free markdown renderer for Ivy's chat replies.
//
// The app ships no markdown library on purpose, but Ivy's replies use a
// little inline markup (**bold**, *italic*, `code`, "- " bullets). Rendered
// as plain text that markup leaks as literal asterisks/backticks. This
// converts the common inline subset into React elements - NO
// dangerouslySetInnerHTML, so model output can never inject markup.
//
// Supported: **bold** / __bold__, *italic* / _italic_, `inline code`,
// "- " / "* " bullet lines, and newline -> <br/>, plus [label](/path)
// links to pages INSIDE Ivy only (the path must start with a single "/";
// anything else, including outside sites, renders as plain text). No
// images, tables, or headings (Ivy is instructed not to emit those, and
// the server sanitizer strips stray headings/rules).
import React from 'react';
import { Link } from 'react-router-dom';

// Split one line of text into bold/italic/code spans. Greedy, left-to-
// right, non-nested - enough for chat copy and safe against unmatched
// delimiters (a lone ** just renders as text).
function renderInline(text, keyPrefix) {
  const out = [];
  // Order matters: ** and __ before single * and _ so bold wins over italic.
  const pattern = /\[([^\]\n]{1,80})\]\((\/(?!\/)[A-Za-z0-9/_\-?=&%.]{0,200})\)|(\*\*|__)(.+?)\3|(\*|_)(.+?)\5|`([^`]+?)`/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {
      out.push(<Link key={`${keyPrefix}-l${i}`} to={m[2]} style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline' }}>{m[1]}</Link>);
    } else if (m[3]) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{m[4]}</strong>);
    } else if (m[5]) {
      out.push(<em key={`${keyPrefix}-i${i}`}>{m[6]}</em>);
    } else if (m[7] != null) {
      out.push(
        <code key={`${keyPrefix}-c${i}`} style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: '0.92em', background: 'var(--surface-2)',
          padding: '1px 5px', borderRadius: 5,
        }}>{m[7]}</code>,
      );
    }
    last = pattern.lastIndex;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Render a multi-line markdown-ish string into React nodes. Bullet lines
// ("- " / "* ") become a styled list; everything else is a paragraph-ish
// run with <br/> between lines.
export function MiniMarkdown({ text }) {
  if (!text) return null;
  const lines = String(text).split('\n');
  const nodes = [];
  let bullets = null; // accumulates consecutive bullet lines

  const flushBullets = (key) => {
    if (!bullets) return;
    nodes.push(
      <ul key={`ul-${key}`} style={{ margin: '4px 0', paddingLeft: 18 }}>
        {bullets.map((b, j) => <li key={j} style={{ margin: '1px 0' }}>{renderInline(b, `li-${key}-${j}`)}</li>)}
      </ul>,
    );
    bullets = null;
  };

  lines.forEach((line, idx) => {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      (bullets ||= []).push(bullet[1]);
      return;
    }
    flushBullets(idx);
    if (line.trim() === '') {
      nodes.push(<br key={`br-${idx}`}/>);
    } else {
      nodes.push(
        <span key={`ln-${idx}`}>
          {renderInline(line, `ln-${idx}`)}
          {idx < lines.length - 1 ? <br/> : null}
        </span>,
      );
    }
  });
  flushBullets('end');
  return <>{nodes}</>;
}

// Plain-text flattening for previews / notifications: drop the inline
// markdown delimiters so a session-list preview never shows "**" or "`".
export function stripMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')   // bold
    .replace(/(\*|_)(.+?)\1/g, '$2')      // italic
    .replace(/`([^`]+?)`/g, '$1')         // inline code
    .replace(/^\s*[-*]\s+/gm, '• ');      // bullets -> dot
}

export default MiniMarkdown;
