// GET /marketing-sitemap.xml - XML sitemap for every static marketing
// page (homepage, /pricing, /blog, /vs/*, /for/*, /security, etc.).
// Crawlers fetch this to discover the full marketing surface in one go.
//
// Routed by vercel.json so the URL is /marketing-sitemap.xml (no /api/).

const HOST = process.env.PUBLIC_HOST || 'joinivy.ai';

const STATIC_PATHS = [
  '/',
  '/pricing',
  '/blog',
  '/tour',
  '/features',
  '/compare',
  '/about',
  '/security',
  '/mobile',
  '/integrations',
  '/privacy',
  '/terms',
];

// Vertical + competitor slugs duplicated here so the API function can
// build the sitemap without importing JSX. Keep these in sync with
// src/features/marketing/verticalsData.js + compareData.js.
const VERTICAL_SLUGS = [
  'massage-therapists', 'hair-stylists', 'personal-trainers', 'coaches', 'cleaners',
  'photographers', 'videographers', 'makeup-artists', 'nail-techs', 'lash-artists',
  'estheticians', 'yoga-instructors', 'pilates-teachers', 'tattoo-artists',
  'chiropractors', 'physical-therapists', 'doulas', 'tutors', 'music-teachers',
  'life-coaches', 'career-coaches', 'consultants', 'therapists', 'nutritionists',
  'dog-walkers', 'pet-groomers', 'real-estate-agents', 'event-planners',
  'wedding-planners', 'freelance-designers', 'copywriters', 'handymen',
];
const COMPETITOR_SLUGS = [
  'honeybook', 'dubsado', 'vagaro', 'mindbody', 'acuity', 'calendly', 'practice', 'paperbell',
];
const BLOG_SLUGS = [
  'ai-for-solo-businesses',
  'are-esignatures-legally-binding',
  'booking-deposits-guide',
  'calendly-alternatives',
  'cancellation-policy-templates',
  'client-contracts-101',
  'client-intake-form-template',
  'client-intake-forms',
  'client-retention-beats-acquisition',
  'does-your-business-need-a-website',
  'email-marketing-solo-business',
  'email-vs-sms-reminders',
  'get-first-clients-coaches',
  'get-first-clients-contractors',
  'get-first-clients-photographers',
  'get-first-clients-stylists',
  'get-first-clients-therapists',
  'get-first-clients-trainers',
  'get-first-clients-tutors',
  'get-more-google-reviews',
  'get-paid-faster',
  'get-paid-on-time-coaches',
  'get-paid-on-time-contractors',
  'get-paid-on-time-photographers',
  'get-paid-on-time-stylists',
  'get-paid-on-time-therapists',
  'get-paid-on-time-trainers',
  'get-paid-on-time-tutors',
  'get-your-first-10-clients',
  'gift-cards-small-business',
  'honeybook-alternatives',
  'how-to-fire-a-client',
  'how-to-price-your-services',
  'how-to-raise-your-rates',
  'how-to-reduce-no-shows',
  'ivy-vs-dubsado',
  'ivy-vs-honeybook',
  'ivy-vs-jobber',
  'ivy-vs-vagaro',
  'late-cancellation-fees',
  'local-seo-for-service-businesses',
  'no-show-cost-calculator',
  'no-show-policy-template',
  'overdue-invoice-scripts',
  'packages-vs-hourly-pricing',
  'payment-reminder-email-templates',
  'price-increase-letter-templates',
  'quarterly-taxes-explained',
  'reduce-no-shows-coaches',
  'reduce-no-shows-contractors',
  'reduce-no-shows-photographers',
  'reduce-no-shows-stylists',
  'reduce-no-shows-therapists',
  'reduce-no-shows-trainers',
  'reduce-no-shows-tutors',
  'referral-program-service-business',
  'respond-to-negative-reviews',
  'self-employed-tax-deductions',
  'should-you-charge-late-fees',
  'true-cost-of-your-tool-stack',
  'where-your-admin-hours-go',
  'win-back-clients-who-ghosted',
];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || HOST;
  const now = new Date().toISOString();
  const all = [
    ...STATIC_PATHS,
    ...VERTICAL_SLUGS.map((s) => `/for/${s}`),
    ...COMPETITOR_SLUGS.map((s) => `/vs/${s}`),
    ...BLOG_SLUGS.map((s) => `/blog/${s}`),
  ];
  const urls = all.map((p) => `  <url>
    <loc>https://${host}${p}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${p === '/' ? '1.0' : '0.7'}</priority>
  </url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.end(xml);
}
