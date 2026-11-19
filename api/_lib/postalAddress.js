// The postal address printed at the bottom of Ivy's own emails. US email
// law requires a real mailing address on marketing email.
//
// One place, so every email shows the same thing. IVY_POSTAL_ADDRESS (if
// set in the environment) replaces it without a code change; Admin >
// Readiness shows which one is in effect.
export const IVY_POSTAL_ADDRESS = 'Ivy AI LLC · 24930 Washington Avenue Unit #268, Murrieta, CA 92564, USA';

export function ivyPostalAddress() {
  const fromEnv = String(process.env.IVY_POSTAL_ADDRESS || '').trim();
  return fromEnv || IVY_POSTAL_ADDRESS;
}

export const ivyPostalAddressSource = () => (String(process.env.IVY_POSTAL_ADDRESS || '').trim() ? 'environment setting' : 'built in');
