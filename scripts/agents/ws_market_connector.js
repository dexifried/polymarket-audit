#!/usr/bin/env node
import { WebSocket } from 'ws';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const SKILL_ROOT = process.env.SKILL_ROOT || '/root/.openclaw/workspace/skills/polymarket-trading.skill';
const WAL_PATH = join(SKILL_ROOT, 'wal', 'log.jsonl');
const CONFIG_PATH = join(SKILL_ROOT, 'config', 'markets.json');

function loadTokenIds() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      return Array.isArray(cfg.tokenIds) ? cfg.tokenIds : [];
    } catch (e) {}
  }
  return [];
}

function appendToWal(entry) {
  const line = JSON.stringify(entry) + '\n';
  require('fs').appendFileSync(WAL_PATH, line, { encoding: 'utf8' });
}

const tokenIds = loadTokenIds();
if (tokenIds.length === 0) {
  console.error('No token IDs configured in config/markets.json; exiting.');
  process.exit(1);
}

const WS_URL = 'wss://clob.polymarket.com/ws';
let ws;
let reconnectTimeout = 1000;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    console.log(`Connected to ${WS_URL}`);
    const sub = { type: 'subscribe', token_ids: tokenIds };
    ws.send(JSON.stringify(sub));
    console.log('Sent subscription:', sub);
    reconnectTimeout = 1000; // reset
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const entry = {
        source: 'market-ws',
        raw: msg,
        timestamp: new Date().toISOString(),
      };
      appendToWal(entry);
    } catch (e) {
      console.error('Failed to parse WS message:', e.message);
    }
  });
  ws.on('close', (code, reason) => {
    console.log(`WS closed (${code}): ${reason}`);
    setTimeout(connect, reconnectTimeout);
    reconnectTimeout = Math.min(reconnectTimeout * 2, 60000);
  });
  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
}

console.log('Starting ws_market_connector...');
mkdirSync(join(SKILL_ROOT, 'wal'), { recursive: true });
mkdirSync(join(SKILL_ROOT, 'logs'), { recursive: true });
connect();
