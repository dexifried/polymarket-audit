#!/usr/bin/env node

import minimist from 'minimist';
import { readFileSync } from 'fs';
import { runAmbiguityJudge } from '../lib/cloud_judge.js';

const args = minimist(process.argv.slice(2));

function loadInput() {
  if (args.input) {
    return JSON.parse(readFileSync(String(args.input), 'utf8'));
  }
  return null;
}

const summary = loadInput();
const result = await runAmbiguityJudge(summary, {
  model: args.model ? String(args.model) : undefined,
  timeoutMs: args.timeout ? Number(args.timeout) : undefined,
  localOnly: Boolean(args['local-only']),
});

console.log(JSON.stringify(result, null, 2));
