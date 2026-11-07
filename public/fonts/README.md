# Ivy fonts

Neue Haas Grotesk is licensed, so its files are not committed. Drop the
.woff2 files here with exactly these names and the site, the web app and the
iPhone app all switch to it on the next build (src/styles/fonts.css; the
build leaves out the rule for any file that is missing, so nothing 404s):

    NeueHaasGroteskText-Regular.woff2
    NeueHaasGroteskText-Italic.woff2
    NeueHaasGroteskText-Medium.woff2
    NeueHaasGroteskText-Bold.woff2
    NeueHaasGroteskDisplay-Medium.woff2
    NeueHaasGroteskDisplay-Bold.woff2

Until they exist, iPhone and Mac show Helvetica Neue, everything else Inter.
See docs/FONTS.md for where to license the font.
