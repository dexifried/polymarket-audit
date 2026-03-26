#!/usr/bin/env node
// Any agent can call Dex for help: node scripts/call_dex.js "reason for call"
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const paperDir = resolve(__dirname, '..', 'memory', 'paper');
const callPath = resolve(paperDir, 'dex_call.json');

const reason = process.argv[2] || 'general review requested';
const record = {
  ts: new Date().toISOString(),
  from: process.env.CALLER || 'unknown',
  reason,
  status: 'pending',
};

writeFileSync(callPath, JSON.stringify(record, null, 2));
console.log(`[dex-call] Request sent: ${reason}`);
