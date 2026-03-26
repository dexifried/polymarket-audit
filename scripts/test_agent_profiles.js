import {
  recordDecision,
  recordOutcome,
  getNetworkSummary,
  loadProfiles,
} from '../lib/agent_profiles.js';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const testPath = resolve('memory/paper/agent_profiles.synthetic.json');

if (existsSync(testPath)) {
  unlinkSync(testPath);
}

recordDecision('judge', 'PROCEED', {
  tokenId: 'btc-1',
  question: 'Will BTC hit $100K this month?',
  outcome: 'Yes',
  entryPrice: 0.42,
}, testPath);

recordDecision('watchman', 'PAUSE', {
  tokenId: 'election-1',
  question: 'Will a new mayor be elected in NYC this year?',
  outcome: 'Yes',
  entryPrice: 0.61,
}, testPath);

recordDecision('dex', 'PROCEED', {
  tokenId: 'sports-1',
  question: 'Will the NBA finals go to 7 games?',
  outcome: 'Yes',
  entryPrice: 0.34,
}, testPath);

recordDecision('collector', 'OBSERVE', {
  tokenId: 'conflict-1',
  question: 'Will there be a ceasefire in Gaza before May?',
  outcome: 'Yes',
  entryPrice: 0.48,
}, testPath);

recordDecision('trader', 'BUY', {
  tokenId: 'eth-1',
  question: 'Will ETH trade above $6K this quarter?',
  outcome: 'Yes',
  entryPrice: 0.39,
}, testPath);

recordOutcome('judge', 'btc-1', 0.52, 0.71, 'take-profit', testPath);
recordOutcome('dex', 'sports-1', 0.18, -0.22, 'stop-loss', testPath);
recordOutcome('trader', 'eth-1', 0.47, 0.19, 'manual-exit', testPath);

const profiles = loadProfiles(testPath);
console.log(getNetworkSummary(profiles));
