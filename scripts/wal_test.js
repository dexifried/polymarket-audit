#!/usr/bin/env node
import { append, tail, replay } from '../lib/wal.js';

async function run(){
  console.log('Appending demo entries...');
  await append({ source: 'marketA', raw: { action: 'buy', amount: 5 }, normalized: { type: 'buy', qty: 5 } });
  await append({ source: 'marketB', raw: { action: 'sell', amount: 2 }, normalized: { type: 'sell', qty: 2 } });
  await append({ source: 'marketA', raw: { action: 'buy', amount: 3 }, normalized: { type: 'buy', qty: 3 } });

  console.log('\nLast 5 entries (tail):');
  const last = await tail(5);
  console.log(last);

  console.log('\nReplay all entries:');
  const all = await replay();
  console.log(all);
}

run().catch(err=>{ console.error(err); process.exit(1); });
