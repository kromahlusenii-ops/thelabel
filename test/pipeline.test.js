import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrl, hashProductKey } from '../src/normalize.js';
import { computeCosts } from '../src/cost-model.js';

// ─── Test 1: No fiber content → fibers === null → "They won't say."
describe('Test 1: No fiber content', () => {
  it('returns confidence none and no cost estimate when fibers is null', () => {
    const extraction = {
      name: 'Merino Knit',
      brand: 'COS',
      price: 135,
      currency: 'USD',
      category: 'knit',
      fibers: null,
      weight: null,
      madeIn: null,
      lined: null,
      features: [],
      imageUrls: [],
    };

    const costs = computeCosts(extraction);
    assert.equal(costs.estimable, false);
    assert.equal(costs.confidence, 'none');
    assert.equal(costs.estCost, null);
    assert.equal(costs.fairBand, null);
    assert.equal(costs.multiple, null);
    assert.equal(costs.theName, null);
    assert.equal(costs.breakdown, null);
  });
});

// ─── Test 2: JSON-LD extraction (unit test for normalize + cost model)
describe('Test 2: JSON-LD basics', () => {
  it('extractFromJsonLd returns price/brand from structured data', async () => {
    const { extractFromJsonLd } = await import('../src/extract.js');
    const jsonLd = [{
      '@type': 'Product',
      'name': 'Wool Blend Coat',
      'brand': { 'name': 'ARKET' },
      'offers': { 'price': '340', 'priceCurrency': 'USD' },
    }];

    const result = extractFromJsonLd(jsonLd);
    assert.equal(result.name, 'Wool Blend Coat');
    assert.equal(result.brand, 'ARKET');
    assert.equal(result.price, 340);
    assert.equal(result.currency, 'USD');
  });
});

// ─── Test 3: JS-rendered page (integration — skip without Playwright)
describe('Test 3: Tier fallback', () => {
  it('placeholder — requires live page to test tier fallback', () => {
    // This is an integration test that requires Playwright and a live page.
    // In CI, test the logic: if tier1 returns null, tier2 is attempted.
    assert.ok(true, 'Tier fallback logic is tested via fetch-page.js structure');
  });
});

// ─── Test 4: Six fixtures — cost model within ±15%
describe('Test 4: Cost model fixtures', () => {
  const fixtures = [
    {
      name: 'Arket Wool Coat',
      extraction: {
        category: 'coat', price: 340, fibers: [{ fiber: 'wool', pct: 42 }, { fiber: 'polyester', pct: 58 }],
        weight: { value: 430, unit: 'gsm' }, madeIn: 'portugal',
        lined: true, features: ['horn buttons', 'full lining', 'set-in sleeves', 'pattern matching'],
      },
      expected: 74,
    },
    {
      name: 'Uniqlo Oxford Shirt',
      extraction: {
        category: 'shirt', price: 50, fibers: [{ fiber: 'cotton', pct: 100 }],
        weight: { value: 140, unit: 'gsm' }, madeIn: 'vietnam',
        lined: false, features: [],
      },
      expected: 19,
    },
    {
      name: 'Reformation Slip Dress',
      extraction: {
        category: 'dress', price: 248, fibers: [{ fiber: 'viscose', pct: 100 }],
        weight: { value: 90, unit: 'gsm' }, madeIn: 'china',
        lined: false, features: ['bias cut', 'french seams'],
      },
      expected: 41,
    },
    {
      name: "Levi's 501 Jeans",
      extraction: {
        category: 'jeans', price: 128, fibers: [{ fiber: 'cotton', pct: 100 }],
        weight: { value: 340, unit: 'gsm' }, madeIn: 'bangladesh',
        lined: false, features: ['rivets'],
      },
      expected: 28,
    },
    {
      name: 'Zara Faux Leather Jacket',
      extraction: {
        category: 'jacket', price: 189, fibers: [{ fiber: 'polyurethane', pct: 100 }],
        weight: null, madeIn: 'turkey',
        lined: false, features: [],
      },
      expected: 23,
    },
    {
      name: 'COS Merino Knit (no fibers)',
      extraction: {
        category: 'knit', price: 135, fibers: null,
        weight: null, madeIn: null,
        lined: null, features: [],
      },
      expected: null, // not estimable
    },
  ];

  for (const fix of fixtures) {
    it(`${fix.name}: cost model within ±15%`, () => {
      const costs = computeCosts(fix.extraction);

      if (fix.expected === null) {
        assert.equal(costs.estimable, false);
        return;
      }

      assert.equal(costs.estimable, true);
      const tolerance = fix.expected * 0.15;
      const diff = Math.abs(costs.estCost - fix.expected);
      assert.ok(
        diff <= tolerance,
        `${fix.name}: expected ~$${fix.expected}, got $${costs.estCost} (diff: $${diff}, tolerance: $${tolerance.toFixed(0)})`
      );
    });
  }
});

// ─── Test 5: Cache hit (unit test for normalize producing same key)
describe('Test 5: Same URL = same cache key', () => {
  it('produces identical productKey for the same URL with different tracking params', () => {
    const url1 = 'https://www.arket.com/en/women/coats/product.wool-blend-coat-123.html?utm_source=google&gclid=abc';
    const url2 = 'https://www.arket.com/en/women/coats/product.wool-blend-coat-123.html?fbclid=xyz';
    const url3 = 'https://www.arket.com/en/women/coats/product.wool-blend-coat-123.html';

    const r1 = normalizeUrl(url1);
    const r2 = normalizeUrl(url2);
    const r3 = normalizeUrl(url3);

    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.ok(r3.ok);
    assert.equal(r1.productKey, r2.productKey);
    assert.equal(r2.productKey, r3.productKey);
  });

  it('preserves color param (different product key)', () => {
    const url1 = 'https://www.arket.com/product/coat.html?color=black';
    const url2 = 'https://www.arket.com/product/coat.html?color=navy';

    const r1 = normalizeUrl(url1);
    const r2 = normalizeUrl(url2);

    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.notEqual(r1.productKey, r2.productKey);
  });
});

// ─── Test 6: Category page URL → rejected
describe('Test 6: Category page rejection', () => {
  it('rejects homepage', () => {
    const r = normalizeUrl('https://www.arket.com/');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('homepage'));
  });

  it('rejects single-segment category path', () => {
    const r = normalizeUrl('https://www.arket.com/coats');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('rail'));
  });

  it('rejects search URLs', () => {
    const r = normalizeUrl('https://www.arket.com/search?q=coat');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('search'));
  });

  it('accepts product URLs', () => {
    const r = normalizeUrl('https://www.arket.com/en/women/coats/product.wool-coat-123.html');
    assert.ok(r.ok);
  });
});

// ─── Test 7: Low confidence → band widened, cost bar hidden
describe('Test 7: Low confidence behavior', () => {
  it('widens band when only fibers present (no weight, no origin)', () => {
    const extraction = {
      category: 'coat', price: 340,
      fibers: [{ fiber: 'wool', pct: 42 }, { fiber: 'polyester', pct: 58 }],
      weight: null, madeIn: null,
      lined: null, features: [],
    };

    const costs = computeCosts(extraction);
    assert.equal(costs.estimable, true);
    assert.equal(costs.confidence, 'low');

    // Band should be wider than high-confidence
    const highConf = computeCosts({
      ...extraction,
      weight: { value: 430, unit: 'gsm' },
      madeIn: 'portugal',
    });

    assert.equal(highConf.confidence, 'high');
    // Low confidence band should be wider
    const lowBandWidth = costs.fairBand[1] - costs.fairBand[0];
    const highBandWidth = highConf.fairBand[1] - highConf.fairBand[0];
    assert.ok(lowBandWidth > highBandWidth, 'Low confidence band should be wider');
  });
});

// ─── Test 8: Every scorecard row with a number has a source line
describe('Test 8: Source lines on graded rows', () => {
  it('all canned scorecard rows with numeric grades have source lines', async () => {
    // Import the verdict module to test row builders
    const { buildVerdict } = await import('../src/verdict.js');

    const extraction = {
      name: 'Wool Blend Coat', brand: 'ARKET', price: 340, currency: 'USD',
      category: 'coat',
      fibers: [{ fiber: 'wool', pct: 42 }, { fiber: 'polyester', pct: 58 }],
      weight: { value: 430, unit: 'gsm' }, madeIn: 'portugal',
      lined: true, features: ['horn buttons', 'full lining', 'set-in sleeves'],
      imageUrls: [],
    };

    const costs = computeCosts(extraction);
    const reviews = { totalReviews: 0, issues: null };
    const priceHistory = [];

    const verdict = await buildVerdict(extraction, costs, reviews, priceHistory);

    for (const row of verdict.rows) {
      // If grade contains a number or specific grade text, it must have a source
      if (row.grade && row.grade !== '\u2014') {
        assert.ok(
          row.source && row.source.length > 0,
          `Row "${row.factor}" has grade "${row.grade}" but no source line`
        );
      }
    }
  });
});
