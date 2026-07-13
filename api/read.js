import { normalizeUrl, hashProductKey } from '../src/normalize.js';
import { fetchProductPage } from '../src/fetch-page.js';
import { extractProduct, extractReviews, extractFromJsonLd } from '../src/extract.js';
import { computeCosts } from '../src/cost-model.js';
import { buildVerdict } from '../src/verdict.js';

// In-memory cache for serverless (per-instance, ephemeral)
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only.' });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'URL is required.' });
  }

  // 1. Normalize
  const norm = normalizeUrl(url.trim());
  if (!norm.ok) {
    return res.status(400).json({ ok: false, error: norm.error, stage: 'normalize' });
  }

  const { url: cleanUrl, productKey, domain } = norm;
  const hash = hashProductKey(productKey);

  // 2. Cache check
  const cached = getCached(productKey);
  if (cached) {
    return res.json({ ok: true, result: cached, cached: true, productKey, hash });
  }

  // 3. Fetch
  let page;
  try {
    page = await fetchProductPage(cleanUrl, domain);
  } catch (err) {
    return res.status(502).json({ ok: false, error: "We can\u2019t reach that shop right now.", stage: 'fetch' });
  }
  if (!page.ok) {
    return res.status(502).json({ ok: false, error: page.error, stage: 'fetch' });
  }

  // 4. Extract
  let extraction;
  try {
    extraction = await extractProduct(page.html, page.jsonLd);
    const jsonLdBasics = extractFromJsonLd(page.jsonLd);
    if (jsonLdBasics) {
      if (!extraction.price && jsonLdBasics.price) extraction.price = jsonLdBasics.price;
      if (!extraction.currency && jsonLdBasics.currency) extraction.currency = jsonLdBasics.currency;
      if (!extraction.brand && jsonLdBasics.brand) extraction.brand = jsonLdBasics.brand;
      if (!extraction.name && jsonLdBasics.name) extraction.name = jsonLdBasics.name;
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Extraction failed: ${err.message}`, stage: 'extract' });
  }

  if (!extraction.price || !extraction.name) {
    return res.status(400).json({ ok: false, error: "Couldn\u2019t read enough from that page. Try a different product URL.", stage: 'extract' });
  }

  // 5. Reviews (non-blocking)
  let reviews = { totalReviews: 0, issues: null };
  try { reviews = await extractReviews(page.html); } catch {}

  // 6. Cost model
  const costs = computeCosts(extraction);

  // 7. Verdict
  let verdict;
  try {
    verdict = await buildVerdict(extraction, costs, reviews, []);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Verdict failed: ${err.message}`, stage: 'verdict' });
  }

  verdict.productKey = productKey;
  verdict.hash = hash;
  verdict.url = cleanUrl;
  verdict.domain = domain;
  verdict.readAt = new Date().toISOString();

  // 8. Cache
  cache.set(productKey, { data: verdict, ts: Date.now() });

  return res.json({ ok: true, result: verdict, cached: false, productKey, hash });
}
