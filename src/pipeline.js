import { normalizeUrl, hashProductKey } from './normalize.js';
import { getCachedVerdict, setCachedVerdict, logPrice, getPriceHistory } from './db.js';
import { fetchProductPage } from './fetch-page.js';
import { extractProduct, extractReviews, extractFromJsonLd } from './extract.js';
import { computeCosts } from './cost-model.js';
import { buildVerdict } from './verdict.js';

export async function readLabel(rawUrl, { forceRefresh = false } = {}) {
  // 1. Normalize
  const norm = normalizeUrl(rawUrl);
  if (!norm.ok) {
    return { ok: false, error: norm.error, stage: 'normalize' };
  }

  const { url, productKey, domain } = norm;
  const hash = hashProductKey(productKey);

  // 2. Cache check
  if (!forceRefresh) {
    const cached = getCachedVerdict(productKey);
    if (cached) {
      return { ok: true, result: cached, cached: true, productKey, hash };
    }
  }

  // 3. Fetch
  const page = await fetchProductPage(url, domain);
  if (!page.ok) {
    return { ok: false, error: page.error, stage: 'fetch' };
  }

  // 4. Extract
  let extraction;
  try {
    // Try JSON-LD first for basic fields
    const jsonLdBasics = extractFromJsonLd(page.jsonLd);

    // Always do full LLM extraction for fiber/weight/features
    extraction = await extractProduct(page.html, page.jsonLd);

    // Merge JSON-LD basics if LLM missed any
    if (jsonLdBasics) {
      if (!extraction.price && jsonLdBasics.price) extraction.price = jsonLdBasics.price;
      if (!extraction.currency && jsonLdBasics.currency) extraction.currency = jsonLdBasics.currency;
      if (!extraction.brand && jsonLdBasics.brand) extraction.brand = jsonLdBasics.brand;
      if (!extraction.name && jsonLdBasics.name) extraction.name = jsonLdBasics.name;
    }
  } catch (err) {
    return { ok: false, error: `Extraction failed: ${err.message}`, stage: 'extract' };
  }

  if (!extraction.price || !extraction.name) {
    return { ok: false, error: "Couldn\u2019t read enough from that page. Try a different product URL.", stage: 'extract' };
  }

  // 5. Log price observation (start logging immediately — this compounds)
  logPrice(productKey, extraction.price, extraction.currency || 'USD');

  // 6. Get price history
  const priceHistory = getPriceHistory(productKey);

  // 7. Extract reviews (separate call, non-blocking failure)
  let reviews = { totalReviews: 0, issues: null };
  try {
    reviews = await extractReviews(page.html);
  } catch {
    // Reviews failing is fine — row shows empty state
  }

  // 8. Cost model (deterministic — never an LLM)
  const costs = computeCosts(extraction);

  // 9. Build verdict + scorecard
  let verdict;
  try {
    verdict = await buildVerdict(extraction, costs, reviews, priceHistory);
  } catch (err) {
    return { ok: false, error: `Verdict generation failed: ${err.message}`, stage: 'verdict' };
  }

  // Add metadata
  verdict.productKey = productKey;
  verdict.hash = hash;
  verdict.url = url;
  verdict.domain = domain;
  verdict.readAt = new Date().toISOString();

  // 10. Cache
  setCachedVerdict(productKey, verdict);

  return { ok: true, result: verdict, cached: false, productKey, hash };
}
