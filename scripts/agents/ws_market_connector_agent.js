#!/usr/bin/env node
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import wal from '../lib/wal.js';

const argv = yargs(hideBin(process.argv))
  .option('endpoint', { type: 'string', default: 'wss://clob.polymarket.com/ws', describe: 'Polymarket CLOB websocket endpoint' })
  .option('markets', { type: 'string', default: path.resolve(new URL('../config/markets.json', import.meta.url).pathname), describe: 'Path to JSON file with array of tokenIds to subscribe' })
  .option('tokens', { type: 'array', describe: 'List of tokenIds to subscribe (overrides --markets file)' })
  .option('verbose', { type: 'boolean', default: false })
  .argv;

let tokenIds = [];
try{
  if(argv.tokens && argv.tokens.length) tokenIds = argv.tokens.map(String);
  else if(fs.existsSync(argv.markets)){
    const raw = fs.readFileSync(argv.markets, 'utf8');
    const parsed = JSON.parse(raw);
    // expect either array of tokenIds or object with .tokenIds
    if(Array.isArray(parsed)) tokenIds = parsed.map(String);
    else if(parsed.tokenIds && Array.isArray(parsed.tokenIds)) tokenIds = parsed.tokenIds.map(String);
  }
}catch(e){
  console.error('Failed to load markets file', e.message);
}

if(!tokenIds.length){
  console.warn('No tokenIds specified. Use --tokens or create config/markets.json');
}

const wsEndpoint = argv.endpoint;
let ws = null;
let shouldStop = false;
let reconnectAttempt = 0;
const maxBackoff = 30_000;

// in-memory caches
const cache = {
  orderbooks: {}, // tokenId -> { bids: [], asks: [] }
  lastTrade: {}, // tokenId -> { price, timestamp }
  midpoint: {} // tokenId -> number
};

function log(...args){ if(argv.verbose) console.log(...args); }

function normalizeMessage(msg){
  // Polymarket CLOB messages vary; we're permissive.
  // Return array of normalized events with fields: type, tokenId, payload, timestamp, source
  const now = Date.now();
  try{
    const j = typeof msg === 'string' ? JSON.parse(msg) : msg;
    if(j.type === 'orderbook' || j.channel === 'orderbook' || j.event === 'orderbook'){
      const tokenId = j.tokenId || j.instrument || j.market || j.id;
      return [{
        type: 'orderbook', tokenId: String(tokenId), payload: j, timestamp: j.timestamp || now, source: 'market-ws'
      }];
    }
    if(j.type === 'trade' || j.channel === 'trades' || j.event === 'trade' || j.trades){
      // could be an array of trades
      const trades = j.trades || (j.trade ? [j.trade] : (j.payload && j.payload.trades) || []);
      const out = [];
      for(const t of trades){
        const tokenId = t.tokenId || t.instrument || t.market || j.tokenId;
        out.push({ type: 'trade', tokenId: String(tokenId), payload: t, timestamp: t.timestamp || j.timestamp || now, source: 'market-ws' });
      }
      return out.length ? out : [{ type: 'trade', tokenId: String(j.tokenId||j.instrument||j.market), payload: j, timestamp: j.timestamp||now, source: 'market-ws' }];
    }
    if(j.type === 'price' || j.channel === 'prices' || j.event === 'price' || j.midpoint || j.price){
      const tokenId = j.tokenId || j.market || j.instrument;
      return [{ type: 'price', tokenId: String(tokenId), payload: j, timestamp: j.timestamp || now, source: 'market-ws' }];
    }
    // generic fallback
    if(j.tokenId || j.market || j.instrument){
      return [{ type: 'unknown', tokenId: String(j.tokenId||j.market||j.instrument), payload: j, timestamp: j.timestamp || now, source: 'market-ws' }];
    }
    return [{ type: 'raw', tokenId: 'unknown', payload: j, timestamp: now, source: 'market-ws' }];
  }catch(e){
    return [{ type: 'raw', tokenId: 'unknown', payload: String(msg), timestamp: Date.now(), source: 'market-ws' }];
  }
}

async function handleNormalized(ev){
  try{
    // update caches
    const token = ev.tokenId || 'unknown';
    if(ev.type === 'orderbook'){
      // try to extract bids/asks
      const bids = ev.payload.bids || ev.payload.book && ev.payload.book.bids || [];
      const asks = ev.payload.asks || ev.payload.book && ev.payload.book.asks || [];
      cache.orderbooks[token] = { bids, asks, timestamp: ev.timestamp };
      // compute midpoint if possible
      const bestBid = bids && bids.length ? Number(bids[0][0] ?? bids[0].price ?? bids[0]) : null;
      const bestAsk = asks && asks.length ? Number(asks[0][0] ?? asks[0].price ?? asks[0]) : null;
      if(bestBid != null && bestAsk != null) cache.midpoint[token] = (bestBid + bestAsk) / 2;
    }
    if(ev.type === 'trade'){
      const p = ev.payload.price ?? ev.payload.p ?? ev.payload.tradePrice ?? (ev.payload[0] && ev.payload[0].price);
      const price = p != null ? Number(p) : null;
      if(price != null){
        cache.lastTrade[token] = { price, timestamp: ev.timestamp };
      }
    }
    if(ev.type === 'price'){
      const price = ev.payload.price ?? ev.payload.midpoint ?? ev.payload.mid;
      if(price != null){ cache.lastTrade[token] = { price: Number(price), timestamp: ev.timestamp }; cache.midpoint[token] = Number(price); }
    }

    // append normalized event to WAL
    const entry = {
      timestamp: ev.timestamp || Date.now(),
      source: 'market-ws',
      normalized: {
        type: ev.type,
        tokenId: ev.tokenId,
        payload: ev.payload
      }
    };
    await wal.append(entry);
  }catch(e){
    console.error('handleNormalized error', e && e.stack || e);
  }
}

function subscribeOnceOpened(){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  // send subscriptions in whatever format the server expects — many CLOBs accept JSON { op: 'subscribe', channel: 'orderbook', tokenId }
  for(const ch of ['orderbook','trades','prices']){
    const msg = { op: 'subscribe', channel: ch, tokenIds: tokenIds };
    try{ ws.send(JSON.stringify(msg)); log('sent subscribe', msg); }catch(e){ console.error('subscribe send failed', e.message); }
  }
}

function connect(){
  reconnectAttempt++;
  log('connecting to', wsEndpoint);
  ws = new WebSocket(wsEndpoint);

  ws.on('open', ()=>{
    log('ws open');
    reconnectAttempt = 0;
    subscribeOnceOpened();
  });

  ws.on('message', async (data)=>{
    const msgs = normalizeMessage(data.toString());
    for(const m of msgs) await handleNormalized(m);
  });

  ws.on('close', (code, reason)=>{
    console.error('ws closed', code, reason && reason.toString());
    if(!shouldStop) scheduleReconnect();
  });

  ws.on('error', (err)=>{
    console.error('ws error', err && err.message);
    // let close handler decide reconnection
  });
}

function scheduleReconnect(){
  const attempt = reconnectAttempt || 1;
  const backoff = Math.min(maxBackoff, Math.pow(2, attempt) * 1000 + Math.floor(Math.random()*1000));
  console.log(`scheduling reconnect in ${backoff}ms (attempt ${attempt})`);
  setTimeout(()=>{
    if(shouldStop) return;
    connect();
  }, backoff);
}

process.on('SIGINT', ()=>{ console.log('SIGINT'); shouldStop = true; try{ ws && ws.close(); }catch(e){} process.exit(0); });
process.on('SIGTERM', ()=>{ console.log('SIGTERM'); shouldStop = true; try{ ws && ws.close(); }catch(e){} process.exit(0); });

// start
connect();

// expose a tiny debug HTTP server? Not necessary. But keep process alive
console.log('ws_market_connector started', { endpoint: wsEndpoint, tokenCount: tokenIds.length });

export default { cache };
