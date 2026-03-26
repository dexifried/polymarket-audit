#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

const argv = yargs
  .option('wal', { type: 'string', default: 'wal/log.jsonl', describe: 'Path to WAL jsonl' })
  .option('from', { type: 'string', describe: 'ISO date start (inclusive)' })
  .option('to', { type: 'string', describe: 'ISO date end (inclusive)' })
  .option('start', { type: 'number', describe: 'seq start (inclusive)' })
  .option('end', { type: 'number', describe: 'seq end (inclusive)' })
  .option('capital', { type: 'number', default: 1000, describe: 'Starting capital (USDC) for return calc' })
  .option('out', { type: 'string', default: 'backtest-out', describe: 'Output prefix (CSV/JSON written)' })
  .help().argv;

function inRange(evt) {
  if (argv.start != null && (evt.seq == null || evt.seq < argv.start)) return false;
  if (argv.end != null && (evt.seq == null || evt.seq > argv.end)) return false;
  if (argv.from) {
    const f = new Date(argv.from).getTime();
    if (evt.timestamp == null || evt.timestamp < f) return false;
  }
  if (argv.to) {
    const t = new Date(argv.to).getTime();
    if (evt.timestamp == null || evt.timestamp > t) return false;
  }
  return true;
}

function readJsonl(p) {
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); } catch(e) { return null; }
  }).filter(Boolean);
}

function approxSharpe(returns) {
  if (!returns.length) return 0;
  const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
  const std = Math.sqrt(returns.map(r=>Math.pow(r-mean,2)).reduce((a,b)=>a+b,0)/(returns.length- (returns.length>1?0:1)));
  if (std === 0) return 0;
  // annualize assuming returns are per-trade; use sqrt(N_trades) as rough annualization
  return mean / std * Math.sqrt(returns.length);
}

function maxDrawdown(equitySeries) {
  let peak = -Infinity, maxdd = 0;
  for (const v of equitySeries) {
    if (v > peak) peak = v;
    const dd = (peak - v);
    if (dd > maxdd) maxdd = dd;
  }
  return maxdd;
}

// Main
const walPath = path.resolve(argv.wal);
if (!fs.existsSync(walPath)) {
  console.error('WAL not found:', walPath);
  process.exit(2);
}

const events = readJsonl(walPath).filter(inRange);
console.error('Loaded', events.length, 'events from', walPath);

// Ontology: look for events with type 'fill' or normalized.type === 'fill' or source==='market-ws' with trade/fill

function isFill(evt) {
  if (evt.type === 'fill' || (evt.normalized && evt.normalized.type === 'fill')) return true;
  if (evt.source === 'market-ws' && evt.normalized && evt.normalized.trade) return true;
  if (evt.event === 'fill') return true;
  return false;
}

// We'll treat fills as objects with: tokenId, outcome, side (BUY/SELL), price (0-1), size (USDC or quantity?), qty, fee, timestamp

const trades = [];
let cash = argv.capital;
const positions = {}; // key -> {qty, avgPrice}
let equity = cash;
const equitySeries = [equity];

for (const evt of events) {
  if (!isFill(evt)) continue;
  // best-effort extraction
  const f = (evt.normalized && evt.normalized.fill) || evt.normalized || evt.raw || evt;
  const ts = evt.timestamp || evt.time || Date.now();

  // Try several field names
  const tokenId = f.tokenId || f.token_id || f.market || f.tokenId || (f.meta && f.meta.tokenId) || 'unknown';
  const outcome = f.outcome || f.side || f.outcomeLabel || 'YES';
  const side = (f.side || (f.takerSide) || outcome).toString().toUpperCase();
  const price = Number(f.price ?? f.fillPrice ?? (f.priceUsd??f.midpoint) ?? 0);
  const qty = Number(f.size ?? f.qty ?? f.quantity ?? f.amount ?? 0);
  const fee = Number(f.fee ?? 0);

  const key = `${tokenId}::${outcome}`;

  // Interpret: if price in 0..1 and qty in market units? We'll assume qty is USDC not contracts; if qty <=10 it's likely contracts. We will treat trade value = price * qty when qty looks like contract amount (<=1000)
  let notional = 0;
  if (qty > 1000) {
    // assume qty already USDC
    notional = qty;
  } else {
    notional = price * qty;
  }

  // Side detection: BUY increases position (long YES), SELL decreases
  const isBuy = side.includes('BUY');

  // Maintain positions: store qtyContracts and avgPrice
  const pos = positions[key] || {qty:0, avgPrice:0};
  let realized = 0;

  if (isBuy) {
    // increase position
    const newQty = pos.qty + qty;
    const newAvg = (pos.qty * pos.avgPrice + qty * price) / (newQty || 1);
    positions[key] = {qty:newQty, avgPrice:newAvg};
    // spend cash
    cash -= notional + fee;
  } else {
    // sell: reduce position, realize P&L relative to avgPrice
    const sellQty = Math.min(qty, pos.qty);
    realized = sellQty * (price - pos.avgPrice);
    pos.qty = pos.qty - sellQty;
    if (pos.qty <= 0) { pos.avgPrice = 0; }
    positions[key] = pos;
    cash += notional - fee;
  }

  equity = cash + Object.values(positions).reduce((a,b)=>a + b.qty * b.avgPrice, 0);
  equitySeries.push(equity);

  trades.push({
    timestamp: ts,
    seq: evt.seq || null,
    tokenId, outcome, side: isBuy ? 'BUY' : 'SELL', price, qty, notional, fee, realized, cash, equity
  });
}

// Compute stats per-trade using realized values
const totalTrades = trades.length;
const netPnl = trades.reduce((a,b)=>a + (b.realized||0),0);
const wins = trades.filter(t=>t.realized>0);
const losses = trades.filter(t=>t.realized<0);
const winRate = trades.length? (wins.length / trades.length):0;
const avgWin = wins.length ? wins.reduce((a,b)=>a+b.realized,0)/wins.length : 0;
const avgLoss = losses.length ? losses.reduce((a,b)=>a+b.realized,0)/losses.length : 0;
const dd = maxDrawdown(equitySeries);
const returns = trades.map(t=> t.realized / argv.capital);
const sharpe = approxSharpe(returns);

const summary = {
  totalTrades, netPnl, winRate, avgWin, avgLoss, maxDrawdown: dd, sharpe
};

console.log('Backtest summary:');
console.log(JSON.stringify(summary,null,2));

// write outputs
const outPrefix = argv.out;
fs.writeFileSync(outPrefix + '.trades.json', JSON.stringify(trades,null,2));
// CSV
const csv = ['timestamp,seq,tokenId,outcome,side,price,qty,notional,fee,realized,cash,equity']
  .concat(trades.map(t=>`${t.timestamp},${t.seq||''},${t.tokenId},${t.outcome},${t.side},${t.price},${t.qty},${t.notional},${t.fee},${t.realized},${t.cash},${t.equity}`))
  .join('\n');
fs.writeFileSync(outPrefix + '.trades.csv', csv);
console.error('Wrote', outPrefix + '.trades.json', outPrefix + '.trades.csv');

// Append Backtesting doc to SKILL.md if not present

console.error('Done.');
