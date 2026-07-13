import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tables = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'cost-model.json'), 'utf-8')
);

function fiberPricePerMeter(fibers, weightGsm) {
  // Blended cost: weighted average of component fibers
  let total = 0;
  for (const { fiber, pct } of fibers) {
    const f = tables.fiberPricePerMeter[fiber.toLowerCase()];
    if (!f) {
      // Unknown fiber — use polyester as conservative default
      const fallback = tables.fiberPricePerMeter['polyester'];
      total += (pct / 100) * (fallback.base + fallback.perGsm * weightGsm);
    } else {
      total += (pct / 100) * (f.base + f.perGsm * weightGsm);
    }
  }
  return total;
}

export function computeCosts(extraction) {
  const { category, fibers, weight, madeIn, features, lined, price } = extraction;

  // If no fibers, we can't compute anything
  if (!fibers || fibers.length === 0) {
    return {
      estimable: false,
      confidence: 'none',
      estCost: null,
      fairBand: null,
      multiple: null,
      theName: null,
      breakdown: null,
    };
  }

  const cat = category || 'other';

  // Resolve weight — use listed or default
  let weightGsm;
  let weightSource = 'listed';
  if (weight) {
    weightGsm = weight.unit === 'oz' ? weight.value * 28.35 : weight.value;
  } else {
    weightGsm = tables.defaultWeight[cat] || 200;
    weightSource = 'estimated';
  }

  // 1. Fabric cost
  const yieldMeters = tables.fabricYield[cat] || 1.5;
  const pricePerMeter = fiberPricePerMeter(fibers, weightGsm);
  const fabricCost = yieldMeters * pricePerMeter;

  // 2. Trims cost
  let trimsCost = tables.trimsBase[cat] || 2.0;
  const matchedFeatures = [];
  if (features) {
    for (const feat of features) {
      const normalized = feat.toLowerCase().trim();
      if (tables.featureCost[normalized] !== undefined) {
        trimsCost += tables.featureCost[normalized];
        matchedFeatures.push(normalized);
      }
    }
  }
  if (lined === true && !matchedFeatures.includes('full lining') && !matchedFeatures.includes('half lining')) {
    trimsCost += tables.featureCost['full lining'];
    matchedFeatures.push('full lining');
  }

  // 3. CMT cost
  let cmtCost;
  let cmtSource = madeIn || 'unknown';
  const sewMins = tables.sewMinutes[cat] || 35;
  if (madeIn) {
    const rate = tables.cmtRatePerMinute[madeIn.toLowerCase()];
    cmtCost = rate ? rate * sewMins : 0.10 * sewMins; // fallback rate
  } else {
    // No origin — use global median (~$0.10/min)
    cmtCost = 0.10 * sewMins;
    cmtSource = 'estimated (no origin listed)';
  }

  // 4. Freight & duty
  const freightAndDuty = 0.10 * (fabricCost + trimsCost + cmtCost);

  // Totals
  const estCost = Math.round(fabricCost + trimsCost + cmtCost + freightAndDuty);

  // Confidence
  let confidence;
  if (fibers && weight && madeIn) {
    confidence = 'high';
  } else if (fibers && (weight || madeIn)) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Widen band based on confidence
  const bandMultiplier = confidence === 'high' ? 1.0 : confidence === 'medium' ? 1.2 : 1.35;
  const lowMultiple = 2.0 / bandMultiplier;
  const highMultiple = 2.5 * bandMultiplier;

  const fairLow = Math.round(estCost * lowMultiple);
  const fairHigh = Math.round(estCost * highMultiple);
  const fairBand = [fairLow, fairHigh];

  const multiple = price ? Math.round((price / estCost) * 10) / 10 : null;
  const theName = price ? Math.max(0, Math.round(price - fairHigh)) : null;
  const fairMargin = price ? Math.max(0, Math.round(Math.min(price, fairHigh) - estCost)) : null;

  return {
    estimable: true,
    confidence,
    estCost,
    fairBand,
    multiple,
    theName,
    fairMargin,
    breakdown: {
      fabricCost: Math.round(fabricCost),
      trimsCost: Math.round(trimsCost),
      cmtCost: Math.round(cmtCost),
      freightAndDuty: Math.round(freightAndDuty),
      matchedFeatures,
      weightGsm: Math.round(weightGsm),
      weightSource,
      cmtSource,
      yieldMeters,
    },
  };
}
