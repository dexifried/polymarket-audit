#!/usr/bin/env node
import { Wallet } from "ethers";
import 'dotenv/config';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY required");
  process.exit(1);
}

const signer = new Wallet(PRIVATE_KEY);
const url = `https://data-api.polymarket.com/positions?user=${signer.address}`;

(async () => {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`❌ Data API error ${resp.status}: ${err}`);
      process.exit(1);
    }
    const positions = await resp.json();
    console.log(JSON.stringify({ positions }, null, 2));
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  }
})();
