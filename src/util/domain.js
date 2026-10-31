// Registrable domain ("same site") without a dependency: the last two labels, or three under a known two-label public
// suffix (co.uk, co.th, com.tw ...). One helper for the corpus queue (one site per domain), inner-page choice, the tracker
// block (never the page's own site) and the freeze miss kinds (same-site data is relevant). Before 26 Oct the tracker
// block used the bare last two labels, so on a *.co.th site every *.co.th host counted as "same site".
export const MULTI = new Set([
  // UK, AU, NZ, ZA, IL, IN
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'ac.nz', 'govt.nz', 'school.nz',
  'co.za', 'org.za', 'gov.za', 'ac.za', 'net.za',
  'co.il', 'org.il', 'ac.il', 'gov.il',
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in', 'firm.in', 'gen.in', 'ind.in',
  // East Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ne.kr', 'ac.kr', 'go.kr', 're.kr',
  'com.cn', 'net.cn', 'org.cn', 'edu.cn', 'gov.cn', 'ac.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  // Thailand and South-East Asia
  'co.th', 'ac.th', 'go.th', 'in.th', 'or.th', 'net.th', 'mi.th',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
  'com.my', 'org.my', 'net.my', 'edu.my', 'gov.my',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'my.id', 'net.id', 'sch.id',
  'com.ph', 'net.ph', 'org.ph', 'edu.ph', 'gov.ph',
  'com.kh', 'com.mm', 'com.bd', 'com.pk', 'com.np', 'com.lk',
  // Americas, Middle East, Europe
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'gob.ar', 'com.co', 'com.pe', 'com.uy', 'com.ec',
  'com.tr', 'org.tr', 'gov.tr', 'com.sa', 'com.eg', 'co.ke', 'com.ng', 'com.ua', 'com.pl', 'co.at', 'or.at',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Registrable domain of a host name ("www." dropped, lower case; an IP address or a one-label host is itself). */
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (IPV4.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** True when both URLs belong to the same registrable domain (false when either cannot be parsed). */
export function sameSite(url, siteUrl) {
  if (!url || !siteUrl) return false;
  try { return registrableDomain(new URL(url).hostname) === registrableDomain(new URL(siteUrl).hostname); } catch { return false; }
}
