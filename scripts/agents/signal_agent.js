#!/usr/bin/env node
import { spawn } from 'child_process';
import minimist from 'minimist';
import path from 'path';
import { fileURLToPath } from 'url';
import wal from '../../lib/wal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = minimist(process.argv.slice(2), { alias: { i: 'interval' } });
const intervalSec = parseInt(args.interval || 60, 10) || 60;
const intervalMs = intervalSec * 1000;
const fetchScript = path.join(__dirname, '..', 'fetch_polyglobe.js');

let running = true;
process.on('SIGINT', () => { running = false; console.log('signal_agent: stopping...'); });
process.on('SIGTERM', () => { running = false; console.log('signal_agent: stopping...'); });

// Simple dedupe cache to avoid emitting the same signal repeatedly in the same interval window
const recentSignals = new Set();
function makeSignalKey(tokenId, outcome, ts) {
  const window = Math.floor(ts / intervalMs);
  return `${tokenId}::${outcome}::${window}`;
}

async function runOnce() {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [fetchScript], { cwd: path.join(__dirname, '..'), env: process.env });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => out += c.toString());
    proc.stderr.on('data', (c) => err += c.toString());
    proc.on('close', async (code) => {
      const now = Date.now();
      if (!out) {
        console.error('fetch_polyglobe produced no output. stderr:', err);
        return resolve();
      }
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        console.error('Failed to parse fetch_polyglobe output:', e.message);
        return resolve();
      }
      const markets = parsed.markets || [];
      for (const m of markets) {
        try {
          const tokenId = m.tokenId;
          const probs = (m.probabilities || []).slice();
          if (!tokenId || !probs.length) continue;
          // assume first probability is YES probability in percent
          const yesPct = probs[0];
          if (typeof yesPct !== 'number') continue;
          if (yesPct >= 90) {
            const outcome = 'YES';
            const confidence = Math.min(1, Math.max(0, yesPct / 100));
            const key = makeSignalKey(tokenId, outcome, now);
            if (recentSignals.has(key)) continue;
            // estimate triggerPrice as null; try to fetch midpoint via script if available
            let triggerPrice = null;
            try {
              // call get_midpoint.js
              const midpointScript = path.join(__dirname, '..', 'get_midpoint.js');
              const p = spawn(process.execPath, [midpointScript, tokenId], { cwd: path.join(__dirname, '..'), env: process.env });
              let mout = '';
              let merr = '';
              p.stdout.on('data', c => mout += c.toString());
              p.stderr.on('data', c => merr += c.toString());
              const code = await new Promise(r => p.on('close', r));
              if (mout) {
                const mres = JSON.parse(mout);
                if (mres && typeof mres.midpoint === 'number') {
                  triggerPrice = Math.max(0, mres.midpoint - 0.01);
                }
              }
            } catch (e) {
              // ignore midpoint failures
            }

            const signal = {
              timestamp: now,
              source: 'signal',
              raw: m,
              normalized: {
                tokenId,
                outcome,
                confidence,
                triggerPrice,
                reason: `Polyglobe detected YES=${yesPct}% (>=90%)`,
              }
            };

            await wal.append(signal);
            recentSignals.add(key);
            // keep recentSignals bounded
            if (recentSignals.size > 1000) {
              // drop oldest by clearing half
              let i = 0;
              for (const k of recentSignals) {
                recentSignals.delete(k);
                if (++i > 500) break;
              }
            }
            console.log('Appended signal for', tokenId, 'confidence', confidence);
          }
        } catch (e) {
          console.error('Error processing market', e.message);
        }
      }
      resolve();
    });
  });
}

async function mainLoop() {
  console.log(`signal_agent: starting (interval=${intervalSec}s)`);
  while (running) {
    const start = Date.now();
    try {
      await runOnce();
    } catch (e) {
      console.error('signal_agent runOnce error:', e.message);
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, intervalMs - elapsed);
    if (!running) break;
    await new Promise(r => setTimeout(r, wait));
  }
  console.log('signal_agent: stopped');
}

mainLoop().catch(err => { console.error('fatal', err); process.exit(1); });
