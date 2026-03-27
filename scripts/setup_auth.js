#!/usr/bin/env node

/**
 * Polymarket Authentication Setup
 *
 * Derives or creates API credentials using L1 (private key) auth.
 * Saves credentials to .polymarket-credentials.json (0600) for reuse.
 */

import { ClobClient } from "@polymarket/clob-client";
import { writeFileSync } from 'fs';
import { getHost, getChainId, buildSigner, loadEnvFallback, normalizeMarketsResponse, getCredentialsPath } from '../lib/runtime.js';

loadEnvFallback();

try {
  const signer = buildSigner();
  const HOST = getHost();
  const CHAIN_ID = getChainId();
  console.log(`✅ Wallet loaded! Address: ${signer.address}`);

  console.log("🔄 Deriving API credentials...");
  const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
  const apiCreds = await tempClient.createOrDeriveApiKey();
  console.log("✅ Credentials derived!");

  // Save to file (0600)
  writeFileSync(getCredentialsPath(), JSON.stringify(apiCreds, null, 2), { mode: 0o600 });
  console.log("💾 Saved to .polymarket-credentials.json (0600)");

  // Verify by initializing trading client and fetching markets
  console.log("🔄 Verifying connection...");
  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    apiCreds,
    0, // EOA
    signer.address
  );
  const markets = normalizeMarketsResponse(await client.getMarkets());
  console.log(`📊 Connected! Fetched ${markets.length} markets.`);

  console.log("\n🔐 Credentials ready for trading.");
} catch (err) {
  console.error("❌ Setup failed:", err.message);
  process.exit(1);
}
