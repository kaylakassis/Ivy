// One line under a public form (booking, contact, sign-up to a list,
// checkout details): who receives what the person types, and where the
// privacy policy is. The business that owns the page is the one collecting
// the details; Ivy handles them on its behalf.
//
// The link is absolute because these forms also run on a business's own
// domain and inside an embed on someone else's site.
export const PRIVACY_URL = 'https://www.joinivy.ai/privacy';

export default function PrivacyNote({ business, color, style }) {
  const who = business && String(business).trim() ? String(business).trim() : 'this business';
  return (
    <p data-privacy-note style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: color || 'var(--muted, #5F6B67)', ...style }}>
      Your details are shared with {who} and handled by Ivy on their behalf. See the{' '}
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer"
        style={{ color: 'inherit', textDecoration: 'underline' }}>Privacy Policy</a>.
    </p>
  );
}
