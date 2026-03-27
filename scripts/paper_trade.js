#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { normalizeFill, normalizePolyglobeMarket } from './normalizer.js';

function usage() {
  console.error('Usage: node scripts/paper_trade.js --signals signals.json --market market.wal|market.csv [--dry-run]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { dryRun: true };
for (let i=0;i<argv.length;i++){
  const a = argv[i];
  if (a === '--signals') opts.signals = argv[++i];
  else if (a === '--market') opts.market = argv[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--no-dry-run') opts.dryRun = false;
  else { usage(); }
}
if (!opts.signals || !opts.market) usage();

function readSignals(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // expect array of polyglobe market objects or normalized signals
  return raw.map(r => {
    // try to detect already-normalized
    if (r.signalId || r.tokenId) return r;
    return normalizePolyglobeMarket(r);
  });
}

function readMarketFeed(p) {
  // support WAL (JSON lines) or CSV (simple trades CSV with tokenId,price,size,timestamp,side)
  const ext = path.extname(p).toLowerCase();
  const contents = fs.readFileSync(p, 'utf8');
  const entries = [];
  if (ext === '.csv') {
    const lines = contents.split('\n').filter(Boolean);
    const hdr = lines.shift().split(',').map(h=>h.trim());
    for (const line of lines) {
      const cols = line.split(',');
      const obj = {};
      for (let i=0;i<hdr.length;i++) obj[hdr[i]] = cols[i];
      // map to fill-like shape
      const raw = {
        tradeId: obj.tradeId ?? obj.id ?? '',
        tokenId: obj.tokenId,
        price: Number(obj.price),
        size: Number(obj.size),
        timestamp: obj.timestamp || null,
        side: (obj.side||'BUY').toUpperCase()
      };
      entries.push(normalizeFill(raw));
    }
  } else {
    // assume WAL: json lines where each line is an event with source 'market' or similar
    const lines = contents.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        // if it's a trade/fill style event, normalize
        if (e.normalized && (e.normalized.price || e.normalized.size)) {
          entries.push(normalizeFill(e.normalized));
        } else if (e.type === 'trade' || e.event === 'trade' || e.normalized?.type === 'trade') {
          entries.push(normalizeFill(e.normalized || e.raw || e));
        } else if (e.raw && (e.raw.price || e.raw.size)) {
          entries.push(normalizeFill(e.raw));
        }
      } catch (err) { /* skip */ }
    }
  }
  // sort by time if available
  entries.sort((a,b)=> (a.filledAt||'') < (b.filledAt||'') ? -1 : 1);
  return entries;
}

function simulate(signals, marketFills) {
  const fills = [];
  const orders = [];
  let cash = 0; // USDC cash flow (negative = spent)
  const positions = {}; // tokenId -> size
  const availableMarketFills = marketFills.map((fill, index) => ({
    ...fill,
    remainingSize: Number(fill.size) > 0 ? Number(fill.size) : 0,
    sourceIndex: index,
  }));

  for (const sig of signals) {
    const tokenId = sig.tokenId || sig.instrumentId || (sig.meta && sig.meta.token_id);
    const outcome = sig.type || sig.outcome || 'YES';
    const targetPrice = sig.priceTarget ?? sig.triggerPrice ?? (sig.price ?? null);
    const size = Number(sig.size ?? sig.notional ?? 2); // default 2 USDC notional
    const side = (sig.side || (sig.type && sig.type.toUpperCase().startsWith('BUY') ? 'BUY' : 'BUY')).toUpperCase();
    const order = {
      orderId: `paper-${Date.now()}-${Math.floor(Math.random()*10000)}`,
      tokenId,
      side,
      price: targetPrice ?? 0.5, // if no price, assume midpoint 0.5
      size,
      remaining: size,
      placedAt: new Date().toISOString(),
      signal: sig
    };
    orders.push(order);

    // match market fills for this tokenId
    for (const m of availableMarketFills) {
      if (order.remaining <= 0) break;
      if (m.tokenId != order.tokenId) continue;
      if (!(m.remainingSize > 0)) continue;
      // price match logic: for BUY, accept fills with price <= order.price
      if (order.side === 'BUY' && m.price <= order.price) {
        const take = Math.min(order.remaining, m.remainingSize);
        const f = {
          fillId: `paperfill-${fills.length+1}`,
          orderId: order.orderId,
          tokenId: order.tokenId,
          side: order.side,
          price: m.price,
          size: take,
          filledAt: m.filledAt || new Date().toISOString(),
          meta: { sourceMarketEvent: m }
        };
        fills.push(f);
        order.remaining -= take;
        m.remainingSize -= take;
        cash -= f.price * f.size; // spent
        positions[order.tokenId] = (positions[order.tokenId] || 0) + (order.side === 'BUY' ? f.size : -f.size);
      } else if (order.side === 'SELL' && m.price >= order.price) {
        const take = Math.min(order.remaining, m.remainingSize);
        const f = {
          fillId: `paperfill-${fills.length+1}`,
          orderId: order.orderId,
          tokenId: order.tokenId,
          side: order.side,
          price: m.price,
          size: take,
          filledAt: m.filledAt || new Date().toISOString(),
          meta: { sourceMarketEvent: m }
        };
        fills.push(f);
        order.remaining -= take;
        m.remainingSize -= take;
        cash += f.price * f.size; // received
        positions[order.tokenId] = (positions[order.tokenId] || 0) - (order.side === 'SELL' ? f.size : -f.size);
      }
    }
  }

  // compute mark-to-market using last known price per token
  const lastPrice = {};
  for (const m of marketFills) lastPrice[m.tokenId] = m.price;
  let mtm = 0;
  for (const [token, pos] of Object.entries(positions)) {
    const p = lastPrice[token] ?? 0.5;
    mtm += pos * p;
  }

  const pnl = cash + mtm; // cash + value of positions
  return { orders, fills, positions, lastPrice, cash, mtm, pnl };
}

// Main
try {
  const signals = readSignals(opts.signals);
  const market = readMarketFeed(opts.market);
  const report = simulate(signals, market);
  const out = { dryRun: !!opts.dryRun, signalsCount: signals.length, marketEvents: market.length, report };
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
