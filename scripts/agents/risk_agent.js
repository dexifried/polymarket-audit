#!/usr/bin/env node
/* Risk Agent for polymarket-trading.skill

Monitors a WAL (write-ahead log) JSONL file for entries and enforces risk limits:
- Subscribes to entries with source === 'signal' or 'execution' or (emergency) source === 'risk'
- Enforces: max open orders per token, max total notional exposure
- Tracks consecutive losses from execution fills and trips a global STOP after threshold
- Appends risk events back to the WAL when rejecting signals
- Persists state to memory/risk_state.json (lock-safe atomic writes)

Usage: node risk_agent.js

Config (at top of file) can be adjusted. WAL file is expected at the skill root as "wal.jsonl" by default.
*/

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Configuration ---
const SKILL_DIR = path.resolve(__dirname, '..', '..');
const WAL_PATH = path.join(SKILL_DIR, 'wal.jsonl'); // JSONL file, one JSON object per line
const STATE_DIR = path.join(SKILL_DIR, 'memory');
const STATE_PATH = path.join(STATE_DIR, 'risk_state.json');
const CHECKPOINT_KEY = 'last_seq';

const CONFIG = {
  maxOpenPerToken: 5,
  maxTotalNotional: 100.0, // USDC
  consecutiveLossLimit: 3,
  pollIntervalMs: 1000,
};

// --- Helpers ---
async function ensureStateDir() {
  await fs.promises.mkdir(STATE_DIR, { recursive: true });
}

async function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp-' + process.pid;
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  await fs.promises.rename(tmp, filePath);
}

async function readState() {
  try {
    const raw = await fs.promises.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {
      last_seq: 0,
      openOrders: [], // {orderId, token, size, price, seq}
      consecutiveLosses: 0,
      stopped: false,
    };
  }
}

// Append a JSON entry to WAL (risk events) safely by appending a newline
async function appendWAL(entry) {
  const line = JSON.stringify(entry) + '\n';
  await fs.promises.appendFile(WAL_PATH, line, 'utf8');
}

function calcNotional(openOrders) {
  return openOrders.reduce((s, o) => s + Math.abs(o.size) * (o.price || 0), 0);
}

async function saveState(state) {
  await ensureStateDir();
  await atomicWriteJson(STATE_PATH, state);
}

// Simple WAL reader that reads from a byte offset stored in state and yields new lines
async function readNewLinesFrom(offsetBytes) {
  try {
    const stats = await fs.promises.stat(WAL_PATH);
    const size = stats.size;
    if (offsetBytes >= size) return { lines: [], newOffset: offsetBytes };
    const stream = fs.createReadStream(WAL_PATH, { start: offsetBytes, end: size - 1, encoding: 'utf8' });
    let data = '';
    for await (const chunk of stream) data += chunk;
    const lines = data.split(/\r?\n/).filter(Boolean);
    return { lines, newOffset: size };
  } catch (e) {
    if (e.code === 'ENOENT') return { lines: [], newOffset: 0 };
    throw e;
  }
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch (e) {
    console.warn('Failed to parse WAL line:', line);
    return null;
  }
}

// --- Business logic ---
async function handleSignal(entry, state) {
  if (state.stopped) {
    // global stop
    const evt = {
      seq: entry.seq || null,
      source: 'risk',
      type: 'REJECT',
      decision: 'REJECT',
      reason: 'GLOBAL_STOP',
      reference: { signal: entry },
      ts: new Date().toISOString(),
    };
    await appendWAL(evt);
    return state;
  }

  const token = entry.token;
  const size = entry.size || 0;
  const price = entry.price || 0;

  // Count open orders per token
  const openForToken = state.openOrders.filter((o) => o.token === token).length;
  if (openForToken >= CONFIG.maxOpenPerToken) {
    const evt = {
      seq: entry.seq || null,
      source: 'risk',
      type: 'REJECT',
      decision: 'REJECT',
      reason: 'MAX_OPEN_PER_TOKEN',
      details: { token, max: CONFIG.maxOpenPerToken },
      reference: { signal: entry },
      ts: new Date().toISOString(),
    };
    await appendWAL(evt);
    return state;
  }

  // Check total notional
  const currentNotional = calcNotional(state.openOrders);
  const newNotional = currentNotional + Math.abs(size) * price;
  if (newNotional > CONFIG.maxTotalNotional) {
    const evt = {
      seq: entry.seq || null,
      source: 'risk',
      type: 'REJECT',
      decision: 'REJECT',
      reason: 'MAX_TOTAL_NOTIONAL',
      details: { maxTotalNotional: CONFIG.maxTotalNotional, currentNotional, wouldBe: newNotional },
      reference: { signal: entry },
      ts: new Date().toISOString(),
    };
    await appendWAL(evt);

    // Optional: cancel oldest orders until under threshold
    // We'll log a cancel intended action into WAL as CANCEL_OLDEST events; execution agent can act on them
    const sorted = state.openOrders.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    let cancelledNotional = 0;
    const toCancel = [];
    for (const o of sorted) {
      if (currentNotional - cancelledNotional - Math.abs(o.size) * (o.price || 0) + Math.abs(size) * price <= CONFIG.maxTotalNotional) break;
      cancelledNotional += Math.abs(o.size) * (o.price || 0);
      toCancel.push(o);
    }
    for (const o of toCancel) {
      const cancelEvt = {
        seq: null,
        source: 'risk',
        type: 'CANCEL_OLDEST',
        decision: 'CANCEL',
        reason: 'REDUCE_NOTIONAL',
        orderId: o.orderId || null,
        details: { token: o.token, size: o.size, price: o.price },
        ts: new Date().toISOString(),
      };
      await appendWAL(cancelEvt);
      // also remove it locally
      state.openOrders = state.openOrders.filter((x) => x !== o);
    }

    await saveState(state);
    return state;
  }

  // If passed checks, register as an open order placeholder (actual execution will confirm)
  const orderId = entry.orderId || `risk-temp-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  state.openOrders.push({ orderId, token, size, price, seq: entry.seq });
  await saveState(state);
  return state;
}

async function handleExecution(entry, state) {
  // execution entries may include fills with pnl info
  // Expect entry: { seq, source: 'execution', type: 'FILL', orderId, token, size, price, pnl }
  if (entry.type === 'FILL') {
    // remove from openOrders if present
    state.openOrders = state.openOrders.filter((o) => o.orderId !== entry.orderId);

    // process PnL if present
    if (typeof entry.pnl === 'number') {
      if (entry.pnl < 0) {
        state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
      } else {
        state.consecutiveLosses = 0;
      }

      if (state.consecutiveLosses >= CONFIG.consecutiveLossLimit) {
        state.stopped = true;
        const stopEvt = {
          seq: null,
          source: 'risk',
          type: 'STOP',
          decision: 'STOP',
          reason: 'CONSECUTIVE_LOSSES',
          details: { consecutiveLosses: state.consecutiveLosses },
          ts: new Date().toISOString(),
        };
        await appendWAL(stopEvt);
      }
    }

    await saveState(state);
  }

  // Other execution-related types may be ORDER_OPENED, CANCELLED — keep openOrders consistent
  if (entry.type === 'ORDER_OPENED') {
    // Add to openOrders if not already
    const exists = state.openOrders.find((o) => o.orderId === entry.orderId);
    if (!exists) {
      state.openOrders.push({ orderId: entry.orderId, token: entry.token, size: entry.size, price: entry.price, seq: entry.seq });
      await saveState(state);
    }
  }
  if (entry.type === 'ORDER_CANCELLED') {
    state.openOrders = state.openOrders.filter((o) => o.orderId !== entry.orderId);
    await saveState(state);
  }

  return state;
}

async function handleRisk(entry, state) {
  // Emergency stop channel
  if (entry.type === 'STOP') {
    state.stopped = true;
    state.consecutiveLosses = 0;
    await saveState(state);
  }
  if (entry.type === 'RESET') {
    state.stopped = false;
    state.consecutiveLosses = 0;
    await saveState(state);
  }
  return state;
}

async function mainLoop() {
  console.log('Risk agent starting. Skill dir:', SKILL_DIR);
  await ensureStateDir();
  let state = await readState();

  // For reading WAL we'll track byte offset rather than seq; store offset in state for robustness
  if (!('wal_offset' in state)) state.wal_offset = 0;

  while (true) {
    try {
      const { lines, newOffset } = await readNewLinesFrom(state.wal_offset);
      if (lines.length > 0) {
        for (const line of lines) {
          const entry = safeParse(line);
          if (!entry) continue;
          // assign seq if present
          if (entry.seq && entry.seq > (state.last_seq || 0)) state.last_seq = entry.seq;

          if (entry.source === 'signal') {
            state = await handleSignal(entry, state);
          } else if (entry.source === 'execution') {
            state = await handleExecution(entry, state);
          } else if (entry.source === 'risk') {
            state = await handleRisk(entry, state);
          }
        }
        state.wal_offset = newOffset;
        await saveState(state);
      }
    } catch (e) {
      console.error('Error in main loop:', e);
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

if (require.main === module) {
  mainLoop().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
