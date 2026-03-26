#!/usr/bin/env node
/* Normalizer service

Usage:
  node scripts/normalizer.js <type> <input.json>

where <type> is one of: order, fill, market, polyglobe

Reads input JSON (raw polymarket CLOB event or polyglobe intel) and prints normalized ontology object to stdout as JSON.
*/

import { readFileSync } from 'fs';
import path from 'path';

const ONTOLOGY_PATH = path.resolve(new URL(import.meta.url).pathname.replace(/\/scripts\/normalizer.js$/, '/ontology/ontology.json'));
let ONTOLOGY = {};
try {
  ONTOLOGY = JSON.parse(readFileSync(ONTOLOGY_PATH, 'utf8'));
} catch (e) {
  // best-effort; not fatal
}

export function normalizeOrder(raw) {
  // raw: user/order event from Polymarket CLOB WS or REST
  const instrumentId = raw.tokenId ? `polymarket:${raw.tokenId}` : raw.instrumentId || raw.marketId || null;
  const side = (raw.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const size = Number(raw.originalSize ?? raw.size ?? raw.quantity ?? 0);
  const filledSize = Number(raw.filledSize ?? raw.filled ?? raw.cumulativeFilled ?? 0);
  const remainingSize = Math.max(0, size - filledSize);
  const order = {
    orderId: String(raw.orderId ?? raw.id ?? raw.clientOrderId ?? ''),
    clientOrderId: raw.clientOrderId || null,
    instrumentId,
    tokenId: raw.tokenId || null,
    side,
    price: Number(raw.price ?? raw.limitPrice ?? 0),
    size,
    filledSize,
    remainingSize,
    status: mapOrderStatus(raw.status),
    orderType: (raw.type || raw.orderType || 'LIMIT').toUpperCase(),
    timeInForce: raw.timeInForce || null,
    createdAt: iso(raw.createdAt ?? raw.timestamp ?? raw.created_at),
    updatedAt: iso(raw.updatedAt ?? raw.timestamp ?? raw.updated_at),
    meta: raw
  };
  return order;
}

export function normalizeFill(raw) {
  // raw: trade/fill event
  const instrumentId = raw.tokenId ? `polymarket:${raw.tokenId}` : raw.instrumentId || raw.marketId || null;
  const side = (raw.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const fill = {
    fillId: String(raw.fillId ?? raw.tradeId ?? raw.id ?? ''),
    orderId: String(raw.orderId ?? raw.clientOrderId ?? raw.makerOrderId ?? ''),
    tradeId: String(raw.tradeId ?? raw.id ?? ''),
    instrumentId,
    tokenId: raw.tokenId || null,
    side,
    price: Number(raw.price ?? raw.executionPrice ?? 0),
    size: Number(raw.size ?? raw.quantity ?? raw.executedSize ?? 0),
    fee: Number(raw.fee ?? 0),
    filledAt: iso(raw.filledAt ?? raw.timestamp ?? raw.time),
    counterpartyOrderId: raw.counterpartyOrderId || raw.takerOrderId || null,
    meta: raw
  };
  return fill;
}

export function normalizeMarket(raw) {
  // raw: market description from REST get_markets or ws market snapshot
  const tokenId = raw.tokenId || raw.id || raw.token_id || raw.marketId || raw.market_id || null;
  const instrument = {
    id: `polymarket:${tokenId}`,
    tokenId: String(tokenId),
    symbol: raw.symbol ?? raw.ticker ?? String(tokenId),
    name: raw.name ?? raw.title ?? `Polymarket ${tokenId}`,
    marketType: mapMarketType(raw.type ?? raw.marketType ?? raw.market_type),
    tickSize: Number(raw.tickSize ?? raw.tick_size ?? raw.tick ?? 0.01),
    minSize: Number(raw.minSize ?? raw.min_size ?? 1),
    status: mapMarketStatus(raw.status ?? raw.state ?? 'ACTIVE'),
    expiresAt: iso(raw.expiresAt ?? raw.expiry ?? raw.endsAt),
    extra: raw
  };
  return instrument;
}

export function normalizePolyglobeMarket(intel) {
  // Partial mapping for trading signals from Polyglobe intel market object
  // intel may contain: id, token_id, signal, strength, timeframe, price_target
  const tokenId = intel.token_id || intel.tokenId || intel.id;
  const signal = {
    signalId: String(intel.id ?? `${tokenId}:${intel.signal ?? 'signal'}`),
    instrumentId: tokenId ? `polymarket:${tokenId}` : null,
    tokenId: tokenId ? String(tokenId) : null,
    type: intel.signal ?? intel.type ?? 'UNKNOWN',
    strength: Number(intel.strength ?? intel.confidence ?? 0),
    timeframe: intel.timeframe ?? intel.horizon ?? null,
    priceTarget: intel.price_target ?? intel.target ?? null,
    meta: intel
  };
  return signal;
}

function mapOrderStatus(s) {
  if (!s) return 'OPEN';
  const v = String(s).toLowerCase();
  if (['open','open_live','new','accepted'].includes(v)) return 'OPEN';
  if (['partially_filled','partial','partial_fill'].includes(v)) return 'PARTIALLY_FILLED';
  if (['filled','closed','done'].includes(v)) return 'FILLED';
  if (['cancelled','canceled'].includes(v)) return 'CANCELLED';
  if (['rejected','failed'].includes(v)) return 'REJECTED';
  return v.toUpperCase();
}

function mapMarketType(t) {
  if (!t) return 'BINARY';
  const v = String(t).toLowerCase();
  if (v.includes('binary')) return 'BINARY';
  if (v.includes('scalar')) return 'SCALAR';
  if (v.includes('multi')) return 'MULTI';
  return 'BINARY';
}

function mapMarketStatus(s) {
  if (!s) return 'ACTIVE';
  const v = String(s).toLowerCase();
  if (['active','open','trading'].includes(v)) return 'ACTIVE';
  if (['closed','settled','expired'].includes(v)) return 'CLOSED';
  if (['suspended','halted'].includes(v)) return 'SUSPENDED';
  return v.toUpperCase();
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString();
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('normalizer.js')) {
  const [,, type, inputPath] = process.argv;
  if (!type || !inputPath) {
    console.error('Usage: node scripts/normalizer.js <order|fill|market|polyglobe> <input.json>');
    process.exit(2);
  }
  try {
    const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
    let out;
    switch (type) {
      case 'order': out = normalizeOrder(raw); break;
      case 'fill': out = normalizeFill(raw); break;
      case 'market': out = normalizeMarket(raw); break;
      case 'polyglobe': out = normalizePolyglobeMarket(raw); break;
      default:
        console.error('Unknown type:', type);
        process.exit(2);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
