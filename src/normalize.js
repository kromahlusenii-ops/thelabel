const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gclsrc', 'srsltid', 'fbclid', 'msclkid', 'dclid',
  'mc_cid', 'mc_eid', 'ref', 'ref_', '_ga', '_gl',
]);

const CATEGORY_PATH_PATTERNS = [
  /^\/(?:collections?|categories?|c|shop|browse|plp)\b/i,
  /^\/[^/]+\/?$/,  // bare single-segment like /coats
];

const SEARCH_PATTERNS = [
  /[?&](?:q|query|search|s)=/i,
  /\/search\b/i,
];

export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'Not a valid URL.' };
  }

  url.protocol = 'https:';

  // Strip tracking params, keep meaningful ones like color
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  // Reject search pages
  if (SEARCH_PATTERNS.some(p => p.test(url.pathname + url.search))) {
    return { ok: false, error: "That\u2019s a search, not a garment. Give me one item." };
  }

  // Reject homepages
  if (url.pathname === '/' || url.pathname === '') {
    return { ok: false, error: "That\u2019s a homepage, not a garment. Give me one item." };
  }

  // Reject obvious category pages (heuristic — short path, no product-like slug)
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 1 && !segments[0].match(/\d/)) {
    // Single segment with no numbers — likely a category
    return { ok: false, error: "That\u2019s a rail, not a garment. Give me one item." };
  }

  const productKey = `${url.hostname}:${url.pathname}${url.search}`.toLowerCase();

  return {
    ok: true,
    url: url.toString(),
    productKey,
    domain: url.hostname.replace(/^www\./, ''),
  };
}

export function hashProductKey(productKey) {
  // Simple numeric hash for shareable URLs
  let h = 0;
  for (let i = 0; i < productKey.length; i++) {
    h = ((h << 5) - h + productKey.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 4).padStart(4, '0');
}
