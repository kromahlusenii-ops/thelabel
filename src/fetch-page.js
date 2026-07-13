let logFetch;
try {
  const db = await import('./db.js');
  logFetch = db.logFetch;
} catch {
  logFetch = () => {}; // no-op when SQLite unavailable (serverless)
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIER1_TIMEOUT = 8000;
const TIER2_TIMEOUT = 15000;
const MIN_BODY_LENGTH = 5000;

// Domains we already know need headless
const HEADLESS_ONLY = new Set();

function extractJsonLd(html) {
  const results = [];
  const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else {
        results.push(parsed);
      }
    } catch { /* malformed JSON-LD, skip */ }
  }
  return results.filter(
    obj => obj['@type'] === 'Product' || obj['@type']?.includes?.('Product')
  );
}

function isBotCheck(html) {
  // Only flag as bot check on short pages — real product pages are large
  if (html.length > 20000) return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('cf-challenge') ||
    lower.includes('please verify you are a human') ||
    lower.includes('access denied') ||
    lower.includes('checking your browser')
  );
}

async function fetchViaProxy(url) {
  const proxyKey = process.env.SCRAPING_API_KEY;
  if (!proxyKey) return null;

  const proxyUrl = `https://api.scraperapi.com?api_key=${encodeURIComponent(proxyKey)}&url=${encodeURIComponent(url)}&render=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(proxyUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    if (html.length < MIN_BODY_LENGTH) return null;
    return { html, statusCode: 200 };
  } catch {
    return null;
  }
}

async function fetchTier1(url, domain) {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER1_TIMEOUT);

    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    const elapsed = Date.now() - t0;
    const html = await res.text();

    if (!res.ok || html.length < MIN_BODY_LENGTH || isBotCheck(html)) {
      logFetch(domain, 1, false, res.status, elapsed);
      return null;
    }

    logFetch(domain, 1, true, res.status, elapsed);
    return { html, statusCode: res.status };
  } catch (err) {
    logFetch(domain, 1, false, 0, Date.now() - t0);
    return null;
  }
}

async function fetchTier2(url, domain) {
  // Skip headless in serverless (no Chromium binary)
  if (process.env.VERCEL) return null;

  const t0 = Date.now();
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: BROWSER_UA,
    });

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: TIER2_TIMEOUT,
    });

    const html = await page.content();
    const elapsed = Date.now() - t0;

    if (html.length < MIN_BODY_LENGTH || isBotCheck(html)) {
      logFetch(domain, 2, false, 0, elapsed);
      return null;
    }

    logFetch(domain, 2, true, 200, elapsed);
    return { html, statusCode: 200 };
  } catch (err) {
    logFetch(domain, 2, false, 0, Date.now() - t0);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// Shopify stores expose /products/{handle}.json — try this as a fast structured fallback
async function fetchShopifyJson(url, domain) {
  // Extract product handle from Shopify-style URLs
  const match = url.match(/\/products\/([^?#/]+)/);
  if (!match) return null;

  const handle = match[1];
  const jsonUrl = `https://${domain}/products/${handle}.json`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER1_TIMEOUT);

    const res = await fetch(jsonUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.product) return null;

    const p = data.product;
    const variant = p.variants?.[0];

    // Build a minimal JSON-LD-style object from the Shopify JSON
    const jsonLd = [{
      '@type': 'Product',
      name: p.title,
      brand: p.vendor,
      description: (p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      offers: {
        price: variant?.price || '0',
        priceCurrency: 'USD',
      },
    }];

    // Build a synthetic HTML from the Shopify data for the extractor
    const bodyText = (p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const tags = (p.tags || []).join(', ');
    const html = `
      <title>${p.title} - ${p.vendor}</title>
      <div class="product">
        <h1>${p.title}</h1>
        <div class="vendor">${p.vendor}</div>
        <div class="price">${variant?.price || ''}</div>
        <div class="type">${p.product_type || ''}</div>
        <div class="description">${bodyText}</div>
        <div class="tags">${tags}</div>
      </div>
      <script type="application/ld+json">${JSON.stringify(jsonLd[0])}</script>
    `;

    return { html, statusCode: 200 };
  } catch {
    return null;
  }
}

export async function fetchProductPage(url, domain) {
  // Check if this domain is known to need headless
  const skipTier1 = HEADLESS_ONLY.has(domain);

  let result = null;

  if (!skipTier1) {
    result = await fetchTier1(url, domain);
  }

  // Shopify JSON API fallback
  if (!result) {
    result = await fetchShopifyJson(url, domain);
  }

  // Scraping proxy fallback (if SCRAPING_API_KEY is set)
  if (!result) {
    result = await fetchViaProxy(url);
  }

  if (!result) {
    result = await fetchTier2(url, domain);
  }

  if (!result) {
    return {
      ok: false,
      error: "We can\u2019t get into that shop yet. Photograph the care label and we\u2019ll read it.",
    };
  }

  const jsonLd = extractJsonLd(result.html);

  return {
    ok: true,
    html: result.html,
    jsonLd,
    statusCode: result.statusCode,
  };
}
