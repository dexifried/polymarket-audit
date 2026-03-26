#!/usr/bin/env node
import fs from 'fs';
import { join } from 'path';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2), {
  boolean: ['force-refresh'],
  alias: { 'force-refresh': 'force', 'cache-ttl': 'cacheTtl' },
  default: { 'cache-ttl': 300 },
});

const API_URL = 'https://www.pizzint.watch/api/osint-feed?includeTruth=1&includeMedia=1&limit=80&truthLimit=80';
const CACHE_PATH = join(process.cwd(), 'intel', 'polyglobe_cache.json');
const cacheTtl = Number(args['cache-ttl']) || 300; // seconds
const forceRefresh = Boolean(args['force-refresh'] || args.force);
const sourceUrl = args._[0] || API_URL;

function nowIso() { return new Date().toISOString(); }

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj;
  } catch (e) { return null; }
}

function saveCache(obj) {
  try {
    fs.mkdirSync(join(process.cwd(), 'intel'), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    // ignore cache write failures
  }
}

function extractMarketsFromText(text) {
  const markets = [];
  // market URL patterns: /market/:id or /m/:id or full urls including polymarket
  const urlRegex = /https?:\/\/[^\s"']+|\/(?:market|m)\/[0-9a-zA-Z_-]+/g;
  const pctRegex = /(-?\d+(?:\.\d+)?)%/g;
  const matches = text.match(urlRegex) || [];
  for (const m of matches) {
    // normalize tokenId as last path segment
    try {
      const cleaned = m.startsWith('/') ? ('https://pizzint.watch' + m) : m;
      const u = new URL(cleaned);
      const parts = u.pathname.split('/').filter(Boolean);
      const tokenId = parts[parts.length - 1];
      // find nearby percentages
      const context = text.substring(Math.max(0, text.indexOf(m) - 200), Math.min(text.length, text.indexOf(m) + 200));
      const pcts = [];
      let r;
      while ((r = pctRegex.exec(context)) !== null) {
        const n = parseFloat(r[1]);
        if (!isNaN(n) && n >= 0 && n <= 100) pcts.push(n);
        if (pcts.length >= 2) break;
      }
      markets.push({ tokenId, url: u.href, probabilities: pcts });
    } catch (e) {
      // ignore
    }
  }
  return markets;
}

async function fetchApi() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal, headers: { 'User-Agent': 'polymarket-fetcher/1' } });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`non-200 ${res.status}`);
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err.message || String(err) };
  }
}

async function fallbackPuppeteer(pageUrl) {
  // Only attempt if puppeteer-core is installed. Do not crash if not.
  try {
    // dynamic import so we don't require puppeteer in normal runs
    const puppeteer = await import('puppeteer-core');
    const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
    const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000));
    const content = await page.content();
    await browser.close();
    return { ok: true, html: content };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function buildOutput({ markets, signals, fetchedAt, source, cacheHit }) {
  return { markets, signals, fetchedAt, source, cacheHit };
}

// Main
(async function main() {
  try {
    // Check cache
    if (!forceRefresh) {
      const c = loadCache();
      if (c && c.fetchedAt) {
        const age = (Date.now() - new Date(c.fetchedAt).getTime()) / 1000;
        if (age < cacheTtl) {
          const out = buildOutput({ markets: c.markets || [], signals: c.signals || [], fetchedAt: c.fetchedAt, source: c.source || sourceUrl, cacheHit: true });
          console.log(JSON.stringify(out, null, 2));
          return;
        }
      }
    }

    // Primary: call API
    const apiRes = await fetchApi();
    if (apiRes.ok) {
      const feed = apiRes.data;
      // feed is expected to be an array of items — stringify fields for text parsing
      const rawText = JSON.stringify(feed).slice(0, 200000);
      const markets = [];
      const signals = [];

      // Try to extract markets from feed entries
      if (Array.isArray(feed)) {
        for (const item of feed) {
          try {
            const body = JSON.stringify(item);
            const extracted = extractMarketsFromText(body);
            for (const m of extracted) markets.push(m);
            // also build simple signal candidates from truth entries if present
            if (item.truth && Array.isArray(item.truth)) {
              for (const t of item.truth) {
                if (t.probability) {
                  signals.push({ text: t.text || '', probability: t.probability, sourceItem: item });
                }
              }
            }
          } catch (e) {}
        }
      }

      const result = { markets, signals, fetchedAt: nowIso(), source: sourceUrl, cacheHit: false };
      saveCache(result);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // API failed — attempt lightweight fallback: fetch the polyglobe page html
    const pageUrl = args._[0] || 'https://www.pizzint.watch/polyglobe';
    try {
      const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': 'polymarket-fetcher/1' }, timeout: 15000 });
      if (pageRes && pageRes.ok) {
        const html = await pageRes.text();
        const markets = extractMarketsFromText(html);
        const signals = []; // page-level signals could be parsed similarly if needed
        const result = { markets, signals, fetchedAt: nowIso(), source: pageUrl, cacheHit: false };
        saveCache(result);
        console.log(JSON.stringify(result, null, 2));
        return;
      }
    } catch (e) {
      // continue to puppeteer fallback
    }

    // Puppeteer fallback (only if installed)
    const fb = await fallbackPuppeteer('https://www.pizzint.watch/polyglobe');
    if (fb.ok) {
      const markets = extractMarketsFromText(fb.html || '');
      const result = { markets, signals: [], fetchedAt: nowIso(), source: 'puppeteer-fallback', cacheHit: false };
      saveCache(result);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // All attempts failed
    const errOut = { markets: [], signals: [], fetchedAt: nowIso(), source: 'failed', cacheHit: false, error: apiRes.error || 'unknown' };
    console.log(JSON.stringify(errOut, null, 2));
    process.exitCode = 2;
  } catch (err) {
    console.error(JSON.stringify({ error: err.message || String(err) }));
    process.exit(1);
  }
})();
