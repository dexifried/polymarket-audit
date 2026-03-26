#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const WAL = require('../../lib/wal') || require('wal')
const Memory = require('../../lib/memory') || require('memory')
const { createAndPostOrder } = require('../../lib/place_order') || require('./place_order')
const { CLOBClient } = require('@polymarket/clob-client')

const cwd = path.resolve(__dirname, '..', '..')
const checkpointPath = path.join(cwd, 'memory', 'checkpoint.json')
const credentialsPath = path.join(process.cwd(), '.polymarket-credentials.json')

const DRY_RUN_DEFAULT = true

function loadCredentials() {
  if (!fs.existsSync(credentialsPath)) return null
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
  } catch (e) {
    console.error('Failed to parse credentials:', e.message)
    return null
  }
}

function loadCheckpoint() {
  try {
    if (!fs.existsSync(checkpointPath)) return { seq: 0 }
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
  } catch (e) {
    console.error('Failed to read checkpoint:', e.message)
    return { seq: 0 }
  }
}

function saveCheckpoint(obj) {
  try {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true })
    fs.writeFileSync(checkpointPath, JSON.stringify(obj, null, 2))
  } catch (e) {
    console.error('Failed to write checkpoint:', e.message)
  }
}

async function main() {
  const argv = require('minimist')(process.argv.slice(2))
  // Support global --dry-run, --no-dry-run and DRY_RUN env
  const cliDry = argv['dry-run'] !== undefined ? argv['dry-run'] : (argv['no-dry-run'] ? false : undefined)
  const envDry = process.env.DRY_RUN !== undefined ? (String(process.env.DRY_RUN).toLowerCase() === 'true') : undefined
  const dryRun = cliDry !== undefined ? !!cliDry : (envDry !== undefined ? !!envDry : DRY_RUN_DEFAULT)

  const creds = loadCredentials()
  if (!creds && !dryRun) {
    console.error('.polymarket-credentials.json missing and not running in dry-run mode')
    process.exit(1)
  }

  const wal = WAL({ path: path.join(cwd, 'wal') })
  const memory = Memory({ path: path.join(cwd, 'memory') })

  const clob = creds ? new CLOBClient({ apiKey: creds.apiKey, secret: creds.secret }) : null

  let checkpoint = loadCheckpoint()
  let lastSeq = checkpoint.seq || 0

  console.log(`Starting execution agent. dryRun=${dryRun}. lastSeq=${lastSeq}`)

  // helper: determine price
  function determinePrice(signal) {
    if (signal.triggerPrice) return signal.triggerPrice
    // if confidence provided as [0..1], approximate midpoint price
    if (signal.confidence) {
      const c = Number(signal.confidence)
      if (!isNaN(c)) return Math.max(0.01, Math.min(0.99, c))
    }
    return 0.5
  }

  // helper: determine size in USDC
  function determineSize(signal) {
    return signal.size || 2 // default 2 USDC
  }

  // process a single signal event
  async function processSignal(evt) {
    try {
      const sig = evt.data || evt
      const tokenId = sig.tokenId || sig.marketId || sig.market_id
      const outcome = sig.outcome
      if (!tokenId || outcome === undefined) {
        console.warn('Skipping signal with missing tokenId/outcome', sig)
        return
      }

      // load open orders
      const openOrders = await memory.getOpenOrders().catch(() => [])
      const exists = (openOrders || []).some(o => String(o.tokenId) === String(tokenId) && String(o.outcome) === String(outcome))
      if (exists) {
        console.log(`Skipping duplicate signal for token ${tokenId} outcome ${outcome}`)
        return
      }

      const price = determinePrice(sig)
      const size = determineSize(sig)

      const order = {
        tokenId,
        outcome,
        price,
        size,
        side: sig.side || 'buy',
        meta: { source: 'signal', signalId: sig.id || sig.seq }
      }

      console.log('Prepared order:', order)

      if (dryRun) {
        console.log('[dry-run] would place order:', order)
        return
      }

      // place order via createAndPostOrder helper
      let placed
      try {
        placed = await createAndPostOrder({ clob, order, credentials: creds })
      } catch (err) {
        console.error('Order placement failed:', err && err.message || err)
        return
      }

      if (!placed || !placed.orderId) {
        console.error('Unexpected response from createAndPostOrder', placed)
        return
      }

      // save to memory
      try {
        await memory.saveOpenOrder({ orderId: placed.orderId, tokenId, outcome, price, size, placedAt: Date.now() })
      } catch (e) {
        console.error('Failed to save open order to memory:', e && e.message)
      }

      // append execution event to WAL
      try {
        await wal.append({ source: 'execution', seq: evt.seq || null, data: { orderId: placed.orderId, tokenId, outcome, price, size, side: order.side } })
      } catch (e) {
        console.error('Failed to append execution event to WAL:', e && e.message)
      }

    } catch (e) {
      console.error('Error processing signal:', e && e.stack || e)
    }
  }

  // replay existing signals from WAL then tail
  try {
    const stream = wal.replay({ gt: lastSeq, filter: r => r.source === 'signal' })
    for await (const rec of stream) {
      await processSignal(rec)
      lastSeq = rec.seq || lastSeq
      saveCheckpoint({ seq: lastSeq })
    }
  } catch (e) {
    console.error('WAL replay failed:', e && e.message)
  }

  // tail for new signals
  try {
    const tail = wal.tail({ after: lastSeq, filter: r => r.source === 'signal' })
    for await (const rec of tail) {
      await processSignal(rec)
      lastSeq = rec.seq || lastSeq
      saveCheckpoint({ seq: lastSeq })
    }
  } catch (e) {
    console.error('WAL tail failed:', e && e.message)
  }
}

main().catch(err => {
  console.error('Fatal error in execution agent:', err && err.stack || err)
  process.exit(1)
})
