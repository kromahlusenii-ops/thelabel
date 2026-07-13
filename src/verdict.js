import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tables = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'cost-model.json'), 'utf-8')
);

const client = new Anthropic();

// --- Fabric grade ---
function gradeFiber(extraction, costs) {
  if (!extraction.fibers) return null;

  const cat = extraction.category || 'other';
  const benchmark = tables.categoryBenchmarks[cat];

  // Check fiber quality: natural vs synthetic ratio
  const naturalFibers = ['wool', 'cotton', 'silk', 'linen', 'cashmere', 'alpaca', 'mohair', 'hemp', 'ramie'];
  let naturalPct = 0;
  for (const { fiber, pct } of extraction.fibers) {
    if (naturalFibers.includes(fiber.toLowerCase())) naturalPct += pct;
  }

  // Grade based on category expectations
  if (cat === 'coat' || cat === 'jacket') {
    if (naturalPct >= 80) return 'strong';
    if (naturalPct >= 50) return 'ok';
    return 'poor';
  }
  if (cat === 'shirt' || cat === 'tee') {
    if (naturalPct >= 95) return 'strong';
    if (naturalPct >= 70) return 'ok';
    return 'poor';
  }
  if (cat === 'dress') {
    if (naturalPct >= 80 || extraction.fibers.some(f => f.fiber === 'silk')) return 'strong';
    if (naturalPct >= 40) return 'ok';
    return 'poor';
  }
  if (cat === 'jeans') {
    if (naturalPct >= 98) return 'strong';
    if (naturalPct >= 90) return 'ok';
    return 'poor';
  }
  // Default
  if (naturalPct >= 70) return 'strong';
  if (naturalPct >= 40) return 'ok';
  return 'poor';
}

// --- The four calls ---
export function computeCall(costs, fabricGrade) {
  if (!costs.estimable) {
    return { call: "They won\u2019t say.", color: '#888780', slug: 'wont-say' };
  }

  const { multiple } = costs;

  if (multiple <= 2.5) {
    return { call: 'Buy it.', color: '#639922', slug: 'buy' };
  }

  // "Wait." would go here when discount history exists
  // if (multiple > 2.5 && discountHistory === 'strong') {
  //   return { call: 'Wait.', color: '#EF9F27', slug: 'wait' };
  // }

  if (multiple > 3.5 && fabricGrade === 'poor') {
    return { call: "Don\u2019t.", color: '#A32D2D', slug: 'dont' };
  }

  if (multiple > 3.5 && fabricGrade === 'strong') {
    return { call: 'Your call.', color: '#888780', slug: 'your-call' };
  }

  // 2.5 < multiple <= 3.5 — moderate territory
  if (fabricGrade === 'poor') {
    return { call: "Don\u2019t.", color: '#A32D2D', slug: 'dont' };
  }
  return { call: 'Your call.', color: '#888780', slug: 'your-call' };
}

// --- Scorecard rows ---
function buildFabricRow(extraction, costs) {
  if (!extraction.fibers) {
    return {
      factor: 'Fabric', sub: 'unknown',
      evidence: "They don\u2019t list it. That\u2019s the whole story.",
      source: 'FIBER CONTENT: NOT LISTED',
      grade: '\u2014', color: 'red',
    };
  }

  const fiberStr = extraction.fibers.map(f => `${f.pct}% ${f.fiber}`).join(', ');
  const weightStr = extraction.weight
    ? `${extraction.weight.value}${extraction.weight.unit}`
    : 'weight not listed';

  const cat = extraction.category || 'other';
  const benchmark = tables.categoryBenchmarks[cat];
  const fabricGrade = gradeFiber(extraction, costs);
  const gradeLabel = fabricGrade === 'strong' ? 'STRONG' : fabricGrade === 'ok' ? 'OK' : 'POOR';
  const gradeColor = fabricGrade === 'strong' ? 'green' : fabricGrade === 'ok' ? 'amber' : 'red';

  const sub = costs.breakdown ? `${Math.round((costs.breakdown.fabricCost / costs.estCost) * 100)}% of cost` : '';

  return {
    factor: 'Fabric', sub,
    evidence: `${fiberStr} at ${weightStr}.`,
    source: benchmark ? `CATEGORY AVG AT THIS PRICE: ${benchmark.fiberExpectation.toUpperCase()}` : '',
    grade: gradeLabel, color: gradeColor,
  };
}

function buildConstructionRow(extraction, costs) {
  if (!extraction.features?.length && extraction.lined === null && !extraction.madeIn) {
    return {
      factor: 'Construction', sub: 'unknown',
      evidence: "The page doesn\u2019t describe the build.",
      source: '',
      grade: '\u2014', color: 'red',
    };
  }

  const feats = extraction.features?.length
    ? extraction.features.join(', ')
    : 'no construction details listed';

  const origin = extraction.madeIn
    ? `Sewn in ${extraction.madeIn.charAt(0).toUpperCase() + extraction.madeIn.slice(1)}`
    : 'origin not listed';

  const sub = costs.breakdown ? `$${costs.breakdown.cmtCost + costs.breakdown.trimsCost} of build` : '';
  const cmtSource = extraction.madeIn
    ? `SEWN IN ${extraction.madeIn.toUpperCase()} \u00b7 ~$${costs.breakdown?.cmtCost || '?'} CMT`
    : 'ORIGIN NOT LISTED';

  // Grade: more features = better construction
  const featureCount = extraction.features?.length || 0;
  let grade, color;
  if (featureCount >= 3 || extraction.features?.some(f => f.toLowerCase().includes('canvas'))) {
    grade = 'STRONG'; color = 'green';
  } else if (featureCount >= 1) {
    grade = 'OK'; color = 'amber';
  } else {
    grade = 'POOR'; color = 'red';
  }

  return {
    factor: 'Construction', sub,
    evidence: `${feats.charAt(0).toUpperCase() + feats.slice(1)}. ${origin}.`,
    source: cmtSource,
    grade, color,
  };
}

function buildMultipleRow(costs) {
  if (!costs.estimable) return null; // Hidden when confidence is None

  const { multiple } = costs;
  const filled = Math.min(12, Math.round(multiple / 0.5));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(12 - filled);

  let grade, color;
  if (multiple <= 2.5) { grade = `${multiple}x`; color = 'green'; }
  else if (multiple <= 3.5) { grade = `${multiple}x`; color = 'amber'; }
  else { grade = `${multiple}x`; color = 'red'; }

  return {
    factor: 'The multiple', sub: 'retail \u00f7 cost',
    evidence: `${multiple}x. Wholesale brands run 2.1\u20132.4x; direct-to-consumer 3\u20135x.`,
    source: `${multiple}x ${bar} FAIR: 2.2x`,
    grade, color,
  };
}

function buildPriceHistoryRow(priceHistory, extraction) {
  const today = new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

  if (!priceHistory || priceHistory.length <= 1) {
    return {
      factor: 'Price history', sub: 'just started',
      evidence: `We started watching this on ${today}. Check back.`,
      source: `FIRST OBSERVATION: ${today.toUpperCase()}`,
      grade: '\u2014', color: 'amber',
    };
  }

  // Analyze price observations
  const prices = priceHistory.map(p => p.price);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const discountPct = Math.round(((maxPrice - minPrice) / maxPrice) * 100);

  let grade, color;
  if (discountPct >= 30) { grade = 'WAIT'; color = 'amber'; }
  else if (discountPct >= 15) { grade = 'OK'; color = 'amber'; }
  else { grade = 'STRONG'; color = 'green'; }

  return {
    factor: 'Price history', sub: `${priceHistory.length} observations`,
    evidence: `Range: $${minPrice}\u2013$${maxPrice}. ${discountPct}% spread.`,
    source: `$${maxPrice} \u2192 $${minPrice} (${discountPct}% OFF)`,
    grade, color,
  };
}

function buildResaleRow() {
  return {
    factor: 'Resale', sub: 'coming soon',
    evidence: 'Not enough sold comps yet.',
    source: '',
    grade: '\u2014', color: 'amber',
  };
}

function buildAgingRow(reviews) {
  if (!reviews || !reviews.issues || reviews.totalReviews === 0) {
    return {
      factor: 'How it ages', sub: 'no data',
      evidence: 'No reviews on the page yet.',
      source: '',
      grade: '\u2014', color: 'amber',
    };
  }

  const issues = reviews.issues;
  const total = reviews.totalReviews;

  // Find top issues
  const issueCounts = [
    { name: 'PILL', count: issues.pilling?.count || 0 },
    { name: 'SHRINK', count: issues.shrinking?.count || 0 },
    { name: 'SEAM', count: issues.seamFailure?.count || 0 },
    { name: 'LINING', count: issues.liningTear?.count || 0 },
    { name: 'SIZING', count: issues.sizing?.count || 0 },
    { name: 'COLOR', count: issues.color?.count || 0 },
    { name: 'QUALITY', count: issues.quality?.count || 0 },
  ].filter(i => i.count > 0).sort((a, b) => b.count - a.count);

  if (issueCounts.length === 0) {
    return {
      factor: 'How it ages', sub: `from ${total} reviews`,
      evidence: 'No significant durability complaints found in reviews.',
      source: `${total} REVIEWS ANALYZED`,
      grade: 'STRONG', color: 'green',
    };
  }

  const topIssues = issueCounts.slice(0, 2);
  const sourceStr = topIssues.map(i => `\u201c${i.name}\u201d IN ${i.count}`).join(' \u00b7 ');

  const complaintRate = topIssues[0].count / total;
  let grade, color;
  if (complaintRate > 0.15) { grade = 'POOR'; color = 'red'; }
  else if (complaintRate > 0.05) { grade = 'OK'; color = 'amber'; }
  else { grade = 'STRONG'; color = 'green'; }

  // Find a quote
  const topIssueName = topIssues[0].name.toLowerCase();
  const issueKey = Object.keys(issues).find(k => {
    return issues[k]?.count === topIssues[0].count;
  });
  const quote = issueKey && issues[issueKey]?.quotes?.[0]
    ? ` "${issues[issueKey].quotes[0]}"`
    : '';

  return {
    factor: 'How it ages', sub: `from ${total} reviews`,
    evidence: `Top complaint: ${topIssues[0].name.toLowerCase()} (${topIssues[0].count} of ${total} reviews).${quote}`,
    source: sourceStr,
    grade, color,
  };
}

// --- Reason generation ---
async function generateReason(extraction, costs, call) {
  if (!costs.estimable) {
    return `No fiber content anywhere on the page. Brands proud of the cloth tell you about the cloth.`;
  }

  const fiberStr = extraction.fibers
    ? extraction.fibers.map(f => `${f.pct}% ${f.fiber}`).join(', ')
    : 'unknown fiber';

  const fallback = `${fiberStr} at ${costs.multiple}x markup \u2014 a $${costs.estCost} garment tagged at $${extraction.price}.`;

  try {
    const prompt = `Write ONE sentence (max 25 words) explaining why this ${extraction.category} is "${call.call}" at $${extraction.price}. Name a material fact first, then the number. Fiber: ${fiberStr}. Cost to make: ~$${costs.estCost}. Multiple: ${costs.multiple}x. Be sharp, not mean. No quotes around the sentence.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0]?.text?.trim() || fallback;
  } catch {
    return fallback;
  }
}

// --- Confidence text ---
function buildConfidenceText(extraction, costs) {
  const brand = extraction.brand || 'the brand';
  const listed = [];
  const missing = [];

  if (extraction.fibers) listed.push('fiber'); else missing.push('fiber content');
  if (extraction.weight) listed.push('weight'); else missing.push('weight');
  if (extraction.madeIn) listed.push('origin'); else missing.push('origin');

  if (costs.confidence === 'none') {
    return `Confidence: none \u2014 ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} missing from the product page. We cannot estimate costs without this information.`;
  }

  const listedStr = listed.join(', ');
  const qualifier = costs.confidence === 'high' ? 'high' : costs.confidence === 'medium' ? 'medium' : 'low';

  let text = `Confidence: ${qualifier} \u2014 ${listedStr} ${listed.length === 1 ? 'was' : 'were'} listed`;
  if (missing.length > 0) {
    text += `; ${missing.join(' and ')} ${missing.length === 1 ? 'was' : 'were'} not`;
  }
  text += `. Costs are estimates from category benchmarks, not ${brand}\u2019s books.`;

  return text;
}

// --- Main verdict builder ---
export async function buildVerdict(extraction, costs, reviews, priceHistory) {
  const fabricGrade = gradeFiber(extraction, costs);
  const call = computeCall(costs, fabricGrade);

  const reason = await generateReason(extraction, costs, call);

  // Build meta line
  const metaParts = [];
  // Season (guess from current date)
  const month = new Date().getMonth();
  metaParts.push(month >= 2 && month <= 7 ? 'SS' + (new Date().getFullYear() % 100) : 'FW' + (new Date().getFullYear() % 100));
  if (extraction.madeIn) {
    metaParts.push(`SEWN IN ${extraction.madeIn.toUpperCase()}`);
  }
  metaParts.push(`READ ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase()}`);
  const metaLine = metaParts.join(' \u00b7 ');

  // Scorecard rows
  const rows = [
    buildFabricRow(extraction, costs),
    buildConstructionRow(extraction, costs),
    buildMultipleRow(costs),
    buildPriceHistoryRow(priceHistory, extraction),
    buildResaleRow(),
    buildAgingRow(reviews),
  ].filter(Boolean);

  // Confidence text
  const confidenceText = buildConfidenceText(extraction, costs);

  // Bar segments
  let bar = null;
  if (costs.estimable && costs.confidence !== 'low' && costs.confidence !== 'none') {
    bar = {
      garment: costs.estCost,
      margin: costs.fairMargin,
      name: costs.theName,
      total: extraction.price,
    };
  }

  return {
    // Header data
    name: extraction.name,
    brand: extraction.brand,
    price: extraction.price,
    currency: extraction.currency,
    category: extraction.category,
    metaLine,

    // Verdict
    call,
    reason,

    // Cost summary
    costs: {
      estCost: costs.estCost,
      fairBand: costs.fairBand,
      multiple: costs.multiple,
      theName: costs.theName,
      confidence: costs.confidence,
      breakdown: costs.breakdown,
    },

    // Scorecard
    bar,
    rows,
    confidenceText,

    // Fibers for display
    fibers: extraction.fibers,
    madeIn: extraction.madeIn,
    weight: extraction.weight,
  };
}
