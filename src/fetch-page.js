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
  const lower = html.toLowerCase();
  return (
    lower.includes('captcha') ||
    lower.includes('cf-challenge') ||
    lower.includes('please verify') ||
    lower.includes('access denied') ||
    (lower.includes('checking your browser') && html.length < 10000)
  );
}

async function fetchTier1(url, domain) {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER1_TIMEOUT);

    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
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

export async function fetchProductPage(url, domain) {
  // Check if this domain is known to need headless
  const skipTier1 = HEADLESS_ONLY.has(domain);

  let result = null;

  if (!skipTier1) {
    result = await fetchTier1(url, domain);
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
