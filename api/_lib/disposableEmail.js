// Throwaway inbox providers. A business account needs an address its owner
// keeps: receipts, payout notices and password resets all go there, and a
// burner address is the cheapest way to open many fake businesses. Owner
// sign-ups from these domains are refused (api/auth/signup.js) and any
// older account using one is flagged in Admin > Risk.
//
// Curated, not exhaustive: the widely used services and their common
// alternate domains. Ordinary free mail (Gmail, Outlook, Yahoo, iCloud,
// Proton...) is never on this list, and neither are forwarding or alias
// services, which people keep.
const DOMAINS = `
0-mail.com 10minutemail.com 10minutemail.net 10minutemail.org 10minemail.com 10mail.org 20minutemail.com
anonbox.net anonymbox.com byom.de chacuo.net correotemporal.org
crazymailing.com cuvox.de dayrep.com deadaddress.com discard.email discardmail.com discardmail.de dispostable.com
dropmail.me dodgit.com einrot.com emailfake.com emailondeck.com emailsensei.com emailtemporanea.net
emailtemporario.com.br emltmp.com ephemail.net etranquil.com fakeinbox.com fakemail.net fakemailgenerator.com
fake-mail.net fleckens.hu getairmail.com getnada.com grr.la guerrillamail.biz guerrillamail.com
guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com gustr.com harakirimail.com
incognitomail.com incognitomail.org inboxbear.com inboxkitten.com jetable.org jourrapide.com
kasmail.com kurzepost.de lroid.com mail-temporaire.fr mail.tm mail7.io mailcatch.com maildrop.cc mailde.de
mailde.info mailexpire.com mailforspam.com mailinator.com mailinator.net mailinator.org mailinator2.com mailnesia.com
mailnull.com mailsac.com mailtemp.info mailtothis.com meltmail.com minutemail.com mintemail.com moakt.com
mohmal.com mt2014.com mt2015.com my10minutemail.com mytemp.email mytrashmail.com nada.email nwytg.net
objectmail.com one-time.email onetimemail.org owlymail.com pokemail.net rcpt.at reallymymail.com
rhyta.com rmqkr.net sharklasers.com sofort-mail.de spam4.me spamavert.com
spambog.com spambox.us spamfree24.org spamherelots.com spaml.com spammotel.com
superrito.com teleworm.us temp-mail.io temp-mail.org tempail.com tempemail.com tempemail.net tempinbox.com
tempmail.dev tempmail.email tempmail.net tempmail.plus tempmailaddress.com tempmailo.com tempr.email temporary-mail.net
temporaryemail.net temporaryinbox.com thankyou2010.com throwam.com throwawayemailaddress.com throwawaymail.com tmail.ws
tmailinator.com tmpmail.net tmpmail.org trashmail.com trashmail.de trashmail.me trashmail.net trashmail.ws
trbvm.com trbvn.com tyldd.com vomoto.com wegwerfmail.de wegwerfmail.net wegwerfmail.org yopmail.com yopmail.fr
yopmail.net zetmail.com
`.split(/\s+/).filter(Boolean);

const SET = new Set(DOMAINS);
export const DISPOSABLE_EMAIL_DOMAINS = DOMAINS;
export const DISPOSABLE_EMAIL_MESSAGE = 'Please use an email address you will keep. Temporary inbox services cannot be used for a business account.';

export function emailDomain(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 ? s.slice(at + 1) : '';
}

// True for a listed domain or any subdomain of one (x.mailinator.com).
export function isDisposableEmail(email) {
  let d = emailDomain(email);
  while (d.includes('.')) {
    if (SET.has(d)) return true;
    d = d.slice(d.indexOf('.') + 1);
  }
  return false;
}
