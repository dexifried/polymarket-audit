import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = resolve(__dirname, '..');
export const WORKSPACE_ROOT = resolve(SKILL_ROOT, '..', '..');
export function getHost() {
  return process.env.POLYMARKET_HOST || 'https://clob.polymarket.com';
}

export function getChainId() {
  return parseInt(process.env.POLYMARKET_CHAIN_ID || '137', 10);
}

export function loadEnvFallback() {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(SKILL_ROOT, '.env'),
    resolve(WORKSPACE_ROOT, '.env'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Ignore malformed or already-loaded env files here; scripts will fail later with a clearer error.
      }
    }
  }
}

export function getCredentialsPath() {
  return resolve(SKILL_ROOT, '.polymarket-credentials.json');
}

export function readApiCreds() {
  const credsPath = getCredentialsPath();
  if (!existsSync(credsPath)) {
    throw new Error(`Missing ${credsPath}. Run setup_auth.js first.`);
  }
  return JSON.parse(readFileSync(credsPath, 'utf8'));
}

export function requirePrivateKey() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY not set. Add it to the workspace .env or export it in your shell.');
  }
  return process.env.PRIVATE_KEY;
}

export function buildReadonlyClient() {
  loadEnvFallback();
  return new ClobClient(getHost(), getChainId());
}

export function buildTradingClient() {
  loadEnvFallback();
  const privateKey = requirePrivateKey();
  const signer = new Wallet(privateKey);
  const creds = readApiCreds();
  return new ClobClient(getHost(), getChainId(), signer, creds, 0, signer.address);
}

export function buildSigner() {
  loadEnvFallback();
  return new Wallet(requirePrivateKey());
}

export function normalizeMarketsResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

export function normalizeOpenOrdersResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

export function normalizeMidpointResponse(response) {
  if (response && typeof response === 'object' && 'mid' in response) {
    return response.mid;
  }
  return response;
}
