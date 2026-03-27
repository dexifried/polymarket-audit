#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import minimist from 'minimist';
import { fileURLToPath } from 'url';
import wal from '../../lib/wal.js';
import memory from '../../lib/memory.cjs';
import { buildTradingClient, getCredentialsPath, loadEnvFallback, SKILL_ROOT } from '../../lib/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const checkpointPath = path.join(SKILL_ROOT, 'memory', 'checkpoint.json');
const credentialsPath = getCredentialsPath();

const DRY_RUN_DEFAULT = true;

loadEnvFallback();

function loadCheckpoint() {
  try {
    if (!fs.existsSync(checkpointPath)) return { seq: 0 };
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read checkpoint:', error.message);
    return { seq: 0 };
  }
}

function saveCheckpoint(obj) {
  try {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, JSON.stringify(obj, null, 2));
  } catch (error) {
    console.error('Failed to write checkpoint:', error.message);
  }
}

function determinePrice(signal) {
  if (signal.triggerPrice) return signal.triggerPrice;
  if (signal.confidence !== undefined) {
    const confidence = Number(signal.confidence);
    if (!Number.isNaN(confidence)) {
      return Math.max(0.01, Math.min(0.99, confidence));
    }
  }
  return 0.5;
}

function determineSize(signal) {
  return signal.size || 2;
}

function normalizeOrderId(order) {
  return order?.orderID || order?.orderId || order?.id || order?.data?.orderID || order?.data?.orderId || null;
}

async function placeOrder(client, order) {
  const response = await client.createAndPostOrder(
    {
      tokenID: order.tokenId,
      price: Number(order.price).toFixed(2),
      size: Number(order.size).toFixed(2),
      side: String(order.side || 'buy').toUpperCase(),
    },
    { tickSize: '0.01', negRisk: false }
  );

  return {
    orderId: normalizeOrderId(response),
    response,
  };
}

function filterSignals(records, lastSeq) {
  return records.filter((record) => {
    if (record?.source !== 'signal') return false;
    if (record?.seq == null) return true;
    return Number(record.seq) > Number(lastSeq || 0);
  });
}

function getSignalPayload(record) {
  return record?.data || record?.normalized || record;
}

async function processSignal(evt, dryRun, client) {
  try {
    const signal = getSignalPayload(evt);
    const tokenId = signal.tokenId || signal.marketId || signal.market_id;
    const outcome = signal.outcome;

    if (!tokenId || outcome === undefined) {
      console.warn('Skipping signal with missing tokenId/outcome', signal);
      return;
    }

    const openOrders = memory.getOpenOrders();
    const exists = openOrders.some((order) => (
      String(order.tokenId) === String(tokenId)
      && String(order.outcome) === String(outcome)
    ));
    if (exists) {
      console.log(`Skipping duplicate signal for token ${tokenId} outcome ${outcome}`);
      return;
    }

    const price = determinePrice(signal);
    const size = determineSize(signal);
    const order = {
      tokenId,
      outcome,
      price,
      size,
      side: signal.side || 'buy',
      meta: { source: 'signal', signalId: signal.id || evt.seq },
    };

    console.log('Prepared order:', order);

    if (dryRun) {
      console.log('[dry-run] would place order:', order);
      return;
    }

    const placed = await placeOrder(client, order);
    if (!placed.orderId) {
      console.error('Unexpected response from createAndPostOrder', placed.response);
      return;
    }

    try {
      memory.saveOpenOrder({
        orderId: placed.orderId,
        tokenId,
        outcome,
        price,
        size,
        placedAt: Date.now(),
      });
    } catch (error) {
      console.error('Failed to save open order to memory:', error.message);
    }

    try {
      await wal.append({
        source: 'execution',
        data: { orderId: placed.orderId, tokenId, outcome, price, size, side: order.side },
      });
    } catch (error) {
      console.error('Failed to append execution event to WAL:', error.message);
    }
  } catch (error) {
    console.error('Error processing signal:', error.stack || error);
  }
}

async function main() {
  const argv = minimist(process.argv.slice(2));
  const cliDry = argv['dry-run'] !== undefined ? argv['dry-run'] : (argv['no-dry-run'] ? false : undefined);
  const envDry = process.env.DRY_RUN !== undefined ? String(process.env.DRY_RUN).toLowerCase() === 'true' : undefined;
  const dryRun = cliDry !== undefined ? Boolean(cliDry) : (envDry !== undefined ? Boolean(envDry) : DRY_RUN_DEFAULT);

  if (!dryRun && !fs.existsSync(credentialsPath)) {
    console.error(`${credentialsPath} missing and not running in dry-run mode`);
    process.exit(1);
  }

  const client = dryRun ? null : buildTradingClient();
  const checkpoint = loadCheckpoint();
  let lastSeq = checkpoint.seq || 0;

  console.log(`Starting execution agent. dryRun=${dryRun}. lastSeq=${lastSeq}`);

  try {
    const replayRecords = filterSignals(await wal.replay(lastSeq + 1), lastSeq);
    for (const rec of replayRecords) {
      await processSignal(rec, dryRun, client);
      lastSeq = rec.seq || lastSeq;
      saveCheckpoint({ seq: lastSeq });
    }
  } catch (error) {
    console.error('WAL replay failed:', error.message);
  }

  try {
    while (true) {
      const tailRecords = filterSignals(await wal.tail(50), lastSeq);
      for (const rec of tailRecords) {
        await processSignal(rec, dryRun, client);
        lastSeq = rec.seq || lastSeq;
        saveCheckpoint({ seq: lastSeq });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error('WAL tail failed:', error.message);
  }
}

main().catch((error) => {
  console.error('Fatal error in execution agent:', error.stack || error);
  process.exit(1);
});
