// The website Instagram section only frames real instagram.com post / reel
// links. Anything else (javascript:, data:, another host) gets the plain
// "View on Instagram" link instead, which goes through safeHref.
// Run: node --import ./tests/bootstrap.mjs ./tests/instagram-embed.test.mjs
import { instagramEmbedUrl } from '../src/lib/videoEmbed.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

console.log('\n[1] real post / reel links embed');
assert(instagramEmbedUrl('https://www.instagram.com/p/CxYz123AbC/') === 'https://www.instagram.com/p/CxYz123AbC/embed', 'post link');
assert(instagramEmbedUrl('https://instagram.com/reel/Abc_def-12/?igsh=xyz') === 'https://www.instagram.com/reel/Abc_def-12/embed', 'reel link with query');
assert(instagramEmbedUrl('instagram.com/p/CxYz123AbC') === 'https://www.instagram.com/p/CxYz123AbC/embed', 'link pasted without https://');
assert(instagramEmbedUrl('https://www.instagram.com/glowstudio/p/CxYz123AbC/') === 'https://www.instagram.com/p/CxYz123AbC/embed', 'post under a profile path');

console.log('\n[2] everything else is not framed');
for (const bad of [
  'javascript:alert(1)//p/x',
  'data:text/html,<script>alert(1)</script>/p/x',
  'https://evil.example/p/CxYz123AbC/',
  'https://instagram.com.evil.example/p/CxYz123AbC/',
  'https://www.instagram.com/glowstudio/',
  'https://www.instagram.com/p/"><x/',
  '', null,
]) {
  assert(instagramEmbedUrl(bad) === null, `no embed for ${JSON.stringify(bad)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
