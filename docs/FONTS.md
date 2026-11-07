# Typeface: Neue Haas Grotesk

Ivy uses one typeface everywhere: the website, the web app, the iPhone app
and the emails. Regular (400) for text, Medium (500) and Bold (700) for
headings and titles. Nothing else needs to change when the font files
arrive: every font-family in the code points at the stack below.

    'Neue Haas Grotesk Text', 'Helvetica Neue', 'Inter', Helvetica, Arial, system-ui, sans-serif
    'Neue Haas Grotesk Display', 'Neue Haas Grotesk Text', 'Helvetica Neue', ...   (headings)

## Why the files are not in the repo

Neue Haas Grotesk is a commercial typeface from Monotype. It is not on
Google Fonts and cannot be bundled without a license, so the source only
carries the `@font-face` declarations (src/styles/fonts.css and the top of
public/blog.css). Until the files exist, iPhone and Mac show Helvetica Neue,
which was designed from the same drawings and is very close; Windows and
Android show Inter.

The build only keeps an `@font-face` rule while its file is in
`public/fonts/` (`licensedFonts` in vite.config.js), so while the files are
missing no page requests them (no 404s, no wasted round trips). Adding the
files and rebuilding turns the rules back on by themselves.

## Getting the font (two routes)

**1. Self-host (recommended, works inside the iPhone app and offline).**
Buy a web license (and an app license, since the files ship inside the
iOS bundle) from Monotype at fonts.com or MyFonts, download the .woff2
files, rename them and drop them into `public/fonts/`:

    NeueHaasGroteskText-Regular.woff2
    NeueHaasGroteskText-Italic.woff2
    NeueHaasGroteskText-Medium.woff2
    NeueHaasGroteskText-Bold.woff2
    NeueHaasGroteskDisplay-Medium.woff2
    NeueHaasGroteskDisplay-Bold.woff2

Commit, push, rebuild the app (`npm run ios:sync`). Done.

**2. Adobe Fonts (if you have Creative Cloud).** Neue Haas Grotesk Text and
Display are on Adobe Fonts. Create a web project, and add its stylesheet
link to index.html. Two catches: the Content-Security-Policy in vercel.json
must allow `https://use.typekit.net` (style-src) and
`https://use.typekit.net https://p.typekit.net` (font-src), and the font
loads from Adobe's servers each time, so the iPhone app shows the fallback
whenever it is offline. Route 1 avoids both.

## Fonts that stay

The website builder (src/features/website) keeps its full Google Fonts
menu: those are the fonts customers pick for their own public sites, not
Ivy's brand.
