import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const EXTRACTION_SYSTEM = `You are a garment data extractor. You read product pages and return structured JSON.

CRITICAL RULES:
1. null means NOT LISTED on the page. Never infer, estimate, or "reasonably assume" fiber content. If the page does not explicitly state the fiber composition, fibers MUST be null.
2. Do NOT guess weight if it's not listed. Return null.
3. Do NOT guess the country of manufacture if it's not listed. Return null.
4. Extract only what is explicitly stated on the page.
5. For fibers, percentages must sum to 100. If the page says "wool blend" without percentages, set fibers to null.
6. Normalize fiber names to lowercase: wool, cotton, polyester, viscose, silk, linen, cashmere, nylon, elastane, acrylic, polyurethane, modal, lyocell, hemp, etc.
7. Normalize country names to lowercase: italy, portugal, china, vietnam, bangladesh, turkey, india, etc.
8. The "features" array should list construction details mentioned: horn buttons, YKK zip, french seams, set-in sleeves, full lining, half lining, rivets, chain-stitched hem, bias cut, pattern matching, etc.`;

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    name:     { type: 'string', description: 'Product name as listed' },
    brand:    { type: 'string', description: 'Brand name' },
    price:    { type: 'number', description: 'Current listed price in numeric form' },
    currency: { type: 'string', description: 'ISO 4217 currency code (USD, EUR, GBP, etc.)' },
    category: {
      type: 'string',
      enum: ['coat','jacket','shirt','knit','dress','trousers','jeans','tee','shoes','bag','other'],
      description: 'Garment category'
    },
    fibers: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          fiber: { type: 'string' },
          pct:   { type: 'number' }
        },
        required: ['fiber', 'pct']
      },
      description: 'Fiber composition. null if NOT LISTED on the page. NEVER GUESS.'
    },
    weight: {
      type: ['object', 'null'],
      properties: {
        value: { type: 'number' },
        unit:  { type: 'string', enum: ['gsm', 'oz'] }
      },
      description: 'Fabric weight. null if not listed.'
    },
    madeIn: {
      type: ['string', 'null'],
      description: 'Country of manufacture, lowercase. null if not listed.'
    },
    lined: {
      type: ['boolean', 'null'],
      description: 'Whether the garment is lined. null if not mentioned.'
    },
    features: {
      type: 'array',
      items: { type: 'string' },
      description: 'Construction features mentioned on the page'
    },
    imageUrls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Product image URLs (first 3)'
    }
  },
  required: ['name', 'brand', 'price', 'currency', 'category', 'fibers', 'weight', 'madeIn', 'lined', 'features', 'imageUrls']
};

const REVIEW_SYSTEM = `You analyze product reviews for garment durability issues. Return structured JSON with counts of reviews mentioning specific problems and 2-3 verbatim quotes for each issue found.

Only count reviews where the issue is a genuine complaint, not a passing mention. Be precise with counts.`;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    totalReviews: { type: 'number', description: 'Total number of reviews visible' },
    issues: {
      type: 'object',
      properties: {
        pilling:     { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] },
        shrinking:   { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] },
        seamFailure: { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] },
        liningTear:  { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] },
        sizing:      { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] },
        color:       { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] },
        quality:     { type: 'object', properties: { count: { type: 'number' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['count', 'quotes'] }
      },
      required: ['pilling', 'shrinking', 'seamFailure', 'liningTear', 'sizing', 'color', 'quality']
    }
  },
  required: ['totalReviews', 'issues']
};

function stripPageChrome(html) {
  // Remove scripts, styles, nav, footer — keep product content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate to ~12k chars to stay within reasonable token limits
  if (text.length > 12000) text = text.slice(0, 12000);
  return text;
}

function extractReviewsSection(html) {
  // Try to find reviews section
  const reviewPatterns = [
    /<div[^>]*(?:id|class)\s*=\s*["'][^"']*reviews?[^"']*["'][\s\S]*?<\/div>/gi,
    /<section[^>]*(?:id|class)\s*=\s*["'][^"']*reviews?[^"']*["'][\s\S]*?<\/section>/gi,
  ];

  let reviewHtml = '';
  for (const pattern of reviewPatterns) {
    const matches = html.match(pattern);
    if (matches) {
      reviewHtml = matches.join(' ');
      break;
    }
  }

  if (!reviewHtml) return null;

  let text = reviewHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 100) return null;
  if (text.length > 15000) text = text.slice(0, 15000);
  return text;
}

export async function extractProduct(html, jsonLd) {
  const pageText = stripPageChrome(html);

  // Build context from JSON-LD if available
  let jsonLdContext = '';
  if (jsonLd && jsonLd.length > 0) {
    jsonLdContext = '\n\nJSON-LD structured data found on page:\n' + JSON.stringify(jsonLd, null, 2);
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM,
    messages: [{
      role: 'user',
      content: `Extract product data from this page. Remember: null for anything not explicitly listed. NEVER guess fiber content.\n\nPage text:\n${pageText}${jsonLdContext}`
    }],
    tools: [{
      name: 'submit_extraction',
      description: 'Submit the extracted product data',
      input_schema: EXTRACTION_SCHEMA
    }],
    tool_choice: { type: 'tool', name: 'submit_extraction' }
  });

  const toolUse = response.content.find(c => c.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Extraction failed: no structured output returned');
  }

  return toolUse.input;
}

export async function extractReviews(html) {
  const reviewText = extractReviewsSection(html);
  if (!reviewText) {
    return { totalReviews: 0, issues: null };
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: REVIEW_SYSTEM,
    messages: [{
      role: 'user',
      content: `Analyze these product reviews for durability and quality issues:\n\n${reviewText}`
    }],
    tools: [{
      name: 'submit_review_analysis',
      description: 'Submit the review analysis',
      input_schema: REVIEW_SCHEMA
    }],
    tool_choice: { type: 'tool', name: 'submit_review_analysis' }
  });

  const toolUse = response.content.find(c => c.type === 'tool_use');
  if (!toolUse) {
    return { totalReviews: 0, issues: null };
  }

  return toolUse.input;
}

export function extractFromJsonLd(jsonLd) {
  if (!jsonLd || jsonLd.length === 0) return null;

  const product = jsonLd[0];

  const result = {
    name: product.name || null,
    brand: product.brand?.name || product.brand || null,
    price: null,
    currency: null,
  };

  // Extract price from offers
  const offers = product.offers;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    result.price = parseFloat(offer.price) || null;
    result.currency = offer.priceCurrency || null;
  }

  if (!result.name || !result.brand || !result.price) return null;
  return result;
}
