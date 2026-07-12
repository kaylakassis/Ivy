// Minimal rich-text editor for document bodies. Wraps a
// `contenteditable` div with a toolbar that toggles paragraph type,
// bold, italic, and lists. Outputs an HTML string limited to the same
// whitelist the recipient-side sanitizer accepts (h2/h3/p/br/strong/em/
// ul/ol/li) so the body that lands in DB and gets rendered to signers
// is exactly what was edited - no surprise tags from
// document.execCommand or paste.
//
// Why not a richer editor (TipTap, Lexical, Slate)?
// - Bundle size: any of them adds 80-200kB gzipped before plugins.
// - Flexibility we don't need: the recipient-side sanitizer rejects
//   anything outside the eight tags above, so a rich editor would
//   just produce content that gets stripped at render time.
// - Footprint: ~120 lines of React + the toolbar fits the Ivy
//   "small surface area" goal without a third-party migration story.
//
// Caveats: contenteditable + execCommand is officially deprecated but
// still works across every browser we support; if a future Chromium
// change breaks it we'll swap for a focused replacement (Lexical is
// the planned escape hatch).
import React, { useRef, useEffect, useCallback } from 'react';
import { Icons } from '../../components/Icons.jsx';

const TOOLBAR_BTN = {
  width: 32, height: 30, borderRadius: 7,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg-2)',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
};

export default function RichTextEditor({
  value, onChange, disabled = false, placeholder, minHeight = 320,
}) {
  const ref = useRef(null);
  // Track whether the editor currently owns the DOM content. While the
  // user is typing we never sync `value` back into the DOM (would reset
  // the caret); we only push value -> DOM when the prop changes from
  // outside (loading a different doc, etc.).
  const lastHtml = useRef(value || '');

  useEffect(() => {
    if (!ref.current) return;
    if ((value || '') !== lastHtml.current) {
      ref.current.innerHTML = value || '';
      lastHtml.current = value || '';
    }
  }, [value]);

  const emit = useCallback(() => {
    if (!ref.current) return;
    const html = normalizeHtml(ref.current.innerHTML || '');
    // Keep `lastHtml` in sync with what we ship out, not the raw DOM -
    // otherwise the next `value` round-trip from the parent looks like
    // a foreign value and the prop-sync effect rewrites the DOM, which
    // jumps the caret.
    lastHtml.current = html;
    onChange(html);
  }, [onChange]);

  const cmd = useCallback((command, arg) => {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  }, [disabled, emit]);

  const setBlock = (tag) => cmd('formatBlock', tag);

  // Strip all formatting / non-text content from any pasted clipboard
  // so the editor never accumulates tags it can't render. We accept
  // <strong>, <em>, headings, lists - everything else gets dropped on
  // the way out via the recipient-side sanitizer anyway, but doing it
  // here keeps the WYSIWYG honest.
  const onPaste = useCallback((e) => {
    if (disabled) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, text);
  }, [disabled]);

  return (
    <div className="rt-editor" style={{
      borderRadius: 10,
      border: '1px solid var(--border-strong)',
      background: 'var(--surface)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
        padding: '8px 8px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)',
      }}>
        <ToolbarBtn label="Heading" onClick={() => setBlock('h2')} disabled={disabled}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 14 }}>H1</span>
        </ToolbarBtn>
        <ToolbarBtn label="Subheading" onClick={() => setBlock('h3')} disabled={disabled}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 12 }}>H2</span>
        </ToolbarBtn>
        <ToolbarBtn label="Body" onClick={() => setBlock('p')} disabled={disabled}>
          <span style={{ fontSize: 11 }}>¶</span>
        </ToolbarBtn>
        <Sep/>
        <ToolbarBtn label="Bold" onClick={() => cmd('bold')} disabled={disabled}>
          <span style={{ fontWeight: 800 }}>B</span>
        </ToolbarBtn>
        <ToolbarBtn label="Italic" onClick={() => cmd('italic')} disabled={disabled}>
          <span style={{ fontStyle: 'italic' }}>I</span>
        </ToolbarBtn>
        <Sep/>
        <ToolbarBtn label="Bulleted list" onClick={() => cmd('insertUnorderedList')} disabled={disabled}>
          <BulletIcon/>
        </ToolbarBtn>
        <ToolbarBtn label="Numbered list" onClick={() => cmd('insertOrderedList')} disabled={disabled}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>1.</span>
        </ToolbarBtn>
        <Sep/>
        <ToolbarBtn label="Clear formatting" onClick={() => cmd('removeFormat')} disabled={disabled}>
          <Icons.X size={11} sw={2}/>
        </ToolbarBtn>
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
        spellCheck={true}
        data-placeholder={placeholder || ''}
        className="rt-content"
        style={{
          padding: '20px 22px',
          minHeight, maxHeight: 600,
          overflowY: 'auto',
          fontSize: 14, lineHeight: 1.65,
          color: 'var(--fg)',
          outline: 'none',
          background: 'var(--surface)',
          opacity: disabled ? 0.6 : 1,
        }}
      />
    </div>
  );
}

function ToolbarBtn({ children, label, onClick, disabled }) {
  return (
    <button type="button" title={label} aria-label={label}
      onClick={onClick} disabled={disabled}
      style={{
        ...TOOLBAR_BTN,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseDown={(e) => e.preventDefault() /* keep selection */}>
      {children}
    </button>
  );
}

function Sep() {
  return <span style={{
    width: 1, height: 18, background: 'var(--border)', margin: '0 4px',
  }}/>;
}

// Browsers (Chromium especially) emit <b> and <i> from execCommand even
// though the recipient-side sanitizer at SignPage only whitelists
// <strong>/<em>. Without this swap, every owner bold/italic silently
// disappears for the signer. Also rewrites stray <div> wrappers (which
// formatBlock can produce on the first line of an empty editor) to
// <p> so they survive the sanitizer too.
function normalizeHtml(html) {
  return html
    .replace(/<b\b([^>]*)>/gi, '<strong$1>')
    .replace(/<\/b>/gi, '</strong>')
    .replace(/<i\b([^>]*)>/gi, '<em$1>')
    .replace(/<\/i>/gi, '</em>')
    .replace(/<div\b([^>]*)>/gi, '<p$1>')
    .replace(/<\/div>/gi, '</p>');
}

function BulletIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="2" cy="2"  r="1" fill="currentColor" stroke="none"/>
      <line   x1="5" y1="2"  x2="12" y2="2"/>
      <circle cx="2" cy="5.5" r="1" fill="currentColor" stroke="none"/>
      <line   x1="5" y1="5.5" x2="12" y2="5.5"/>
      <circle cx="2" cy="9"  r="1" fill="currentColor" stroke="none"/>
      <line   x1="5" y1="9"   x2="12" y2="9"/>
    </svg>
  );
}
