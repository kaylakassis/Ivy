// Live "paper page" preview of a document. Renders the body HTML in a
// shadowed sheet styled to look like the printed/PDF version the signer
// will see at /sign/<token>, and mocks each field as the actual UI
// control the recipient interacts with (signature line, dated initial,
// labeled text input). Owner edits a field on the left → preview
// updates instantly on the right.
//
// The HTML sanitizer here matches the recipient-side one so the owner
// can't see content in the preview that would get stripped at render.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';

const FIELD_META = {
  signature: { label: 'Signature',     icon: 'Edit'   },
  initial:   { label: 'Initials',      icon: 'Edit'   },
  date:      { label: 'Date',          icon: 'Calendar' },
  text:      { label: 'Text response', icon: 'Doc'    },
};

export default function DocumentPreview({
  name, body, fields, businessName,
}) {
  const safeBody = sanitize(body || '');

  return (
    <div className="doc-preview-shell" style={{
      flex: 1, minWidth: 0,
      background: 'var(--surface-2)',
      borderRadius: 14,
      padding: 24,
      overflowY: 'auto',
      maxHeight: 'calc(100vh - 200px)',
    }}>
      <div className="doc-preview-page" style={{
        margin: '0 auto',
        maxWidth: 720,
        background: '#FFFFFF',
        color: '#1A1A1A',
        borderRadius: 4,
        boxShadow: '0 4px 14px rgba(0,0,0,0.10), 0 24px 60px -20px rgba(0,0,0,0.20)',
        padding: '56px 64px 64px',
        fontFamily: '"Inter", -apple-system, sans-serif',
      }}>
        {/* Letterhead — workspace name top-right, doc name big at the
            top. Mirrors the SignPage header so the preview lands
            close to what the recipient sees when they open the link. */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 14,
          paddingBottom: 18, borderBottom: '1px solid #E5E5E5', marginBottom: 28,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: '#6F6F6F', fontWeight: 600, marginBottom: 6,
            }}>
              {businessName || 'Your business'}
            </div>
            <div style={{
              fontFamily: 'Fraunces, Georgia, serif',
              fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em',
              color: '#0F0F0F', lineHeight: 1.2,
            }}>
              {name || 'Untitled document'}
            </div>
          </div>
          <div style={{
            padding: '4px 10px', borderRadius: 99,
            background: '#F1EEE6', color: '#6F6F6F',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>
            Preview
          </div>
        </div>

        {/* Body — same whitelist as recipient side so the preview
            matches one-to-one. */}
        {safeBody ? (
          <div className="doc-preview-body"
            style={{
              fontSize: 14.5, lineHeight: 1.7, color: '#1F1F1F',
            }}
            dangerouslySetInnerHTML={{ __html: safeBody }}/>
        ) : (
          <div style={{
            padding: '32px 0', textAlign: 'center',
            color: '#9F9F9F', fontSize: 14, fontStyle: 'italic',
          }}>
            Start typing on the left — the document fills in here.
          </div>
        )}

        {/* Fields strip — visualizes how each labeled input will appear
            to the signer. Each control is rendered as the actual UI
            element (signature line, date stamp, text box) the
            recipient will fill, not as an abstract config row. */}
        {fields && fields.length > 0 && (
          <div style={{
            marginTop: 36, paddingTop: 24, borderTop: '1px solid #E5E5E5',
          }}>
            <div style={{
              fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: '#6F6F6F', fontWeight: 600, marginBottom: 14,
            }}>
              Signer completes
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {fields.map((f, i) => (
                <FieldVisual key={f.id || i} field={f} index={i + 1}/>
              ))}
            </div>
          </div>
        )}

        {/* Footer mirrors the audit-page line shown on the flattened
            signed PDF so the owner has a reasonable sense of the final
            document's footprint. */}
        <div style={{
          marginTop: 48, paddingTop: 14, borderTop: '1px dashed #E5E5E5',
          fontSize: 10.5, color: '#9F9F9F', textAlign: 'center',
        }}>
          Signed document includes a tamper-evident audit page with timestamps,
          IP addresses, and a SHA-256 completion hash.
        </div>
      </div>
    </div>
  );
}

function FieldVisual({ field, index }) {
  const meta = FIELD_META[field.type] || FIELD_META.text;
  const Icon = Icons[meta.icon] || Icons.Doc;
  const label = field.label || meta.label;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, color: '#5A5A5A', fontWeight: 600,
      }}>
        <span style={{
          width: 18, height: 18, borderRadius: 99,
          background: '#0F0F0F', color: '#FFF',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700,
        }}>{index}</span>
        <Icon size={12} sw={1.7} stroke="#5A5A5A"/>
        <span style={{ flex: 1 }}>{label}</span>
        {field.required !== false && (
          <span style={{
            fontSize: 9.5, color: '#A05050', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>Required</span>
        )}
      </div>
      <FieldControl type={field.type}/>
    </div>
  );
}

function FieldControl({ type }) {
  if (type === 'signature') {
    return (
      <div style={{
        height: 80, borderRadius: 6,
        border: '2px dashed #C9C9C9',
        background: 'repeating-linear-gradient(45deg, transparent, transparent 8px, #F8F8F8 8px, #F8F8F8 16px)',
        display: 'flex', alignItems: 'flex-end', padding: '0 14px 10px',
        color: '#9F9F9F', fontSize: 12,
      }}>
        <span style={{
          flex: 1, borderBottom: '1px solid #BFBFBF',
          paddingBottom: 4,
          fontStyle: 'italic',
        }}>Sign here</span>
      </div>
    );
  }
  if (type === 'initial') {
    return (
      <div style={{
        width: 88, height: 56, borderRadius: 6,
        border: '2px dashed #C9C9C9',
        background: 'repeating-linear-gradient(45deg, transparent, transparent 8px, #F8F8F8 8px, #F8F8F8 16px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#9F9F9F', fontSize: 11, fontStyle: 'italic',
      }}>Initial</div>
    );
  }
  if (type === 'date') {
    return (
      <div style={{
        height: 38, borderRadius: 6,
        border: '1px solid #D5D5D5', background: '#FAFAFA',
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
        color: '#9F9F9F', fontSize: 12.5,
        maxWidth: 220,
      }}>
        <Icons.Calendar size={13} sw={1.7} stroke="#9F9F9F"/>
        MM / DD / YYYY
      </div>
    );
  }
  // text
  return (
    <div style={{
      minHeight: 44, borderRadius: 6,
      border: '1px solid #D5D5D5', background: '#FAFAFA',
      padding: '10px 14px',
      color: '#9F9F9F', fontSize: 12.5, lineHeight: 1.5,
    }}>
      Their answer goes here.
    </div>
  );
}

// Mirror of the recipient-side sanitizer (SignPage.jsx) so what the
// owner sees is exactly what the signer will get. Whitelist headings,
// paragraph, line break, strong/em, lists. Strip everything else.
function sanitize(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<\/?(?!\/?(?:h[1-3]|p|br|strong|em|ul|ol|li)\b)[^>]+>/gi, '')
    .replace(/<(\/?)(h[1-3]|p|br|strong|em|ul|ol|li)\b[^>]*>/gi, '<$1$2>');
}
