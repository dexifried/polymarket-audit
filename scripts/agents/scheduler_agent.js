#!/usr/bin/env node
/* Scheduler Agent
- Emits timed TICK events into the WAL with source='scheduler' and type='TICK'
- Reads schedule from config/schedule.json if present, otherwise uses default every 5 minutes
- Supports --once for single-run testing
- Keeps a small in-memory nextTick store for each task
*/
import fs from 'fs';
import path from 'path';
import { append } from '../../../lib/wal.js';

const cwd = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(cwd, '..', '..');
const CONFIG_PATH = path.join(root, 'config', 'schedule.json');

const DEFAULT_SCHEDULE = [
  // default simple schedule: heartbeat every 5m, reconcile every 5m, snapshot every day at 00:00
  { name: 'heartbeat', everySeconds: 300 },
  { name: 'reconcile', everySeconds: 300 },
  { name: 'eod_snapshot', cron: '0 0 * * *' } // cron parsed only for human-read; not strictly executed here
];

function loadSchedule() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      console.warn('schedule.json must be an array — using default');
    }
  } catch (e) {
    console.warn('failed reading schedule.json:', e.message);
  }
  return DEFAULT_SCHEDULE;
}

// In-memory next tick times (Date.now() ms)
const nextTicks = new Map();

function nowSeconds() { return Math.floor(Date.now() / 1000); }

function scheduleNext(task) {
  const name = task.name;
  let next = nowSeconds();
  if (task.everySeconds) {
    const current = nextTicks.get(name) || nowSeconds();
    next = Math.max(nowSeconds(), current + task.everySeconds);
  } else if (task.everyMs) {
    const current = nextTicks.get(name) || Date.now();
    next = Math.floor(Math.max(Date.now(), current + task.everyMs) / 1000);
  } else if (task.cron) {
    // for now: if cron present and no explicit everySeconds, default to daily at midnight
    const d = new Date();
    d.setUTCHours(0,0,0,0);
    next = Math.floor(d.getTime() / 1000) + 24*3600; // next UTC midnight
  } else {
    // fallback to 5 minutes
    next = nowSeconds() + 300;
  }
  nextTicks.set(name, next);
  return next;
}

async function emitTick(taskName) {
  const ts = new Date().toISOString();
  const entry = {
    source: 'scheduler',
    type: 'TICK',
    timestamp: ts,
    taskName
  };
  await append(entry);
  // call local handlers for tasks (non-blocking)
  try { handleTaskTick(taskName, ts); } catch (e) { console.error('task handler error', e); }
}

// Example handlers for scheduled tasks — these are simple and meant to be extended
function handleTaskTick(taskName, ts) {
  switch (taskName) {
    case 'heartbeat':
      // write heartbeat to WAL as a separate event
      append({ source: 'scheduler', type: 'HEARTBEAT', timestamp: ts, detail: 'heartbeat tick' }).catch(console.error);
      // touch memory/heartbeat via local helper if exists
      try {
        const mem = awaitImportMemory();
        mem && mem.touchHeartbeat && mem.touchHeartbeat().catch(()=>{});
      } catch(e){}
      break;
    case 'reconcile':
      append({ source: 'scheduler', type: 'RECONCILE_REQUEST', timestamp: ts }).catch(console.error);
      break;
    case 'eod_snapshot':
      append({ source: 'scheduler', type: 'EOD_SNAPSHOT', timestamp: ts }).catch(console.error);
      break;
    default:
      // generic handler
      break;
  }
}

function awaitImportMemory() {
  // try to import lib/memory.js lazily; if missing, return null
  try {
    // resolve relative path
    const memPath = path.join(root, 'lib', 'memory.js');
    if (fs.existsSync(memPath)) {
      // dynamic import requires URL
      return import('file://' + memPath);
    }
  } catch (e) {}
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const schedule = loadSchedule();

  // initialize nextTicks
  for (const t of schedule) scheduleNext(t);

  if (once) {
    // run all tasks that are due now or earlier, once
    for (const t of schedule) {
      const next = nextTicks.get(t.name);
      if (next <= nowSeconds()) {
        await emitTick(t.name);
        scheduleNext(t);
      }
    }
    process.exit(0);
  }

  // continuous loop: check every 1s
  console.log('scheduler_agent started; schedule:', schedule.map(s=>s.name));
  setInterval(async () => {
    const sNow = nowSeconds();
    for (const t of schedule) {
      const name = t.name;
      const next = nextTicks.get(name) || scheduleNext(t);
      if (sNow >= next) {
        // emit
        try { await emitTick(name); } catch (e) { console.error('emitTick failed', e); }
        scheduleNext(t);
      }
    }
  }, 1000);
}

main().catch(err => { console.error(err); process.exit(1); });
