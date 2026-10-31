// api/_lib/safeUrl.js - the outbound-fetch guard. Pure unit test: DNS is
// injected so nothing here touches the network.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/safe-url.test.mjs

import {
  assertPublicHttpsUrl, assertPlatformBlobUrl, isPlatformBlobUrl, isPrivateAddress,
} from '../api/_lib/safeUrl.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const rejects = async (url, lookup = publicDns) => {
  try { await assertPublicHttpsUrl(url, { lookup }); return false; } catch { return true; }
};

console.log('\n[1] private / loopback / link-local literals are refused (all notations)');
for (const u of [
  'https://127.0.0.1/', 'https://127.1/', 'https://0x7f000001/', 'https://017700000001/', 'https://2130706433/',
  'https://10.1.2.3/', 'https://172.16.5.5/', 'https://172.31.255.1/', 'https://192.168.1.1/',
  'https://169.254.169.254/latest/meta-data/', 'https://0.0.0.0/', 'https://100.64.0.1/', 'https://224.0.0.1/',
  'https://[::1]/', 'https://[::]/', 'https://[fc00::1]/', 'https://[fd12::1]/', 'https://[fe80::1]/',
  'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:10.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/',
  'https://[64:ff9b::7f00:1]/', 'https://localhost/', 'https://foo.localhost/', 'https://db.internal/',
]) assert(await rejects(u), `rejects ${u}`);

console.log('\n[2] scheme and userinfo rules');
assert(await rejects('http://example.com/'), 'http refused');
assert(await rejects('ftp://example.com/'), 'ftp refused');
assert(await rejects('https://user:pw@example.com/'), 'userinfo refused');
assert(await rejects('not a url'), 'garbage refused');

console.log('\n[3] hostnames resolving to private space are refused, public ones pass');
assert(await rejects('https://rebind.example/', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.9' }]), 'one private A record among public ones → refused');
assert(await rejects('https://meta.example/', async () => [{ address: '169.254.169.254' }]), 'resolves to metadata address → refused');
assert(await rejects('https://v6.example/', async () => [{ address: '::ffff:192.168.0.1' }]), 'resolves to v4-mapped private v6 → refused');
assert(await rejects('https://v6loop.example/', async () => [{ address: '::1' }]), 'resolves to ::1 → refused');
assert(await rejects('https://nx.example/', async () => { throw new Error('ENOTFOUND'); }), 'unresolvable → refused');
assert(await rejects('https://empty.example/', async () => []), 'no addresses → refused');
let out = await assertPublicHttpsUrl('https://hooks.example.com/path?x=1', { lookup: publicDns });
assert(out === 'https://hooks.example.com/path?x=1', 'public hostname passes and returns the URL');
out = await assertPublicHttpsUrl('https://hooks.example.com/', { lookup: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946' }] });
assert(out === 'https://hooks.example.com/', 'public v6 answer passes');
let dnsCalls = 0;
out = await assertPublicHttpsUrl('https://93.184.216.34/x', { lookup: async () => { dnsCalls++; return []; } });
assert(out === 'https://93.184.216.34/x' && dnsCalls === 0, 'public IP literal passes without a DNS lookup');

console.log('\n[4] isPrivateAddress edge cases');
assert(isPrivateAddress('::ffff:7f00:1') && isPrivateAddress('::FFFF:127.0.0.1'), 'mapped loopback in both spellings');
assert(!isPrivateAddress('8.8.8.8') && !isPrivateAddress('2001:4860:4860::8888'), 'public addresses are not private');
assert(!isPrivateAddress('example.com'), 'hostnames are not literals');
assert(isPrivateAddress('fe80::1%eth0'), 'zone id does not hide link-local');

console.log('\n[5] platform blob host rule');
assert(isPlatformBlobUrl('https://abc123.public.blob.vercel-storage.com/docs/x.pdf'), 'public blob host accepted');
assert(isPlatformBlobUrl('https://abc123.blob.vercel-storage.com/docs/x.pdf'), 'private blob host accepted');
assert(!isPlatformBlobUrl('http://abc123.public.blob.vercel-storage.com/x.pdf'), 'http refused');
assert(!isPlatformBlobUrl('https://evil.example.com/x.pdf'), 'other host refused');
assert(!isPlatformBlobUrl('https://blob.vercel-storage.com.evil.example/x.pdf'), 'suffix trick refused');
assert(!isPlatformBlobUrl('https://a@abc.public.blob.vercel-storage.com/x.pdf'), 'userinfo refused');
assert(!isPlatformBlobUrl('https://169.254.169.254/x.pdf'), 'IP literal refused');
let threw = false;
try { assertPlatformBlobUrl('https://evil.example.com/x.pdf'); } catch { threw = true; }
assert(threw, 'assertPlatformBlobUrl throws for a foreign host');
assert(assertPlatformBlobUrl('https://abc.public.blob.vercel-storage.com/x.pdf') === 'https://abc.public.blob.vercel-storage.com/x.pdf', 'assertPlatformBlobUrl returns the URL');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
