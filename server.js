import 'dotenv/config';
import express from 'express';
import { readLabel } from './src/pipeline.js';
import { getCachedVerdict } from './src/db.js';

const app = express();
app.use(express.json());
app.use(express.static('.'));

// Rate limiting (in-memory, per IP)
const rateLimits = new Map();
const UNAUTH_LIMIT = 3;   // per month
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function checkRate(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= UNAUTH_LIMIT;
}

// POST /api/read — main endpoint
app.post('/api/read', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'URL is required.' });
  }

  const ip = req.ip || req.socket.remoteAddress;
  if (!checkRate(ip)) {
    return res.status(429).json({
      ok: false,
      error: `${UNAUTH_LIMIT} free reads per month. The good stuff costs money to compute.`,
    });
  }

  try {
    const result = await readLabel(url.trim());
    if (!result.ok) {
      const status = result.stage === 'normalize' ? 400 : 502;
      return res.status(status).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Pipeline error:', err);
    return res.status(500).json({ ok: false, error: 'Something broke. Try again.' });
  }
});

// GET /api/read/:productKey — cached lookup
app.get('/api/read/:productKey', (req, res) => {
  const cached = getCachedVerdict(decodeURIComponent(req.params.productKey));
  if (!cached) {
    return res.status(404).json({ ok: false, error: 'No verdict cached for that item.' });
  }
  return res.json({ ok: true, result: cached, cached: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`The Label running on http://localhost:${PORT}`);
});
