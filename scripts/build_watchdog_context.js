#!/usr/bin/env node

import { retrieveAndRankContext } from '../lib/context_retrieval.js';

(async () => {
  try {
    const cache = await retrieveAndRankContext();
    console.log(JSON.stringify({
      ok: true,
      generatedAt: cache.generatedAt,
      methodUsed: cache.methodUsed,
      fallbackReason: cache.fallbackReason,
      queryCount: cache.queryCount,
      snippetCount: cache.snippetCount,
      topContexts: cache.topContexts?.length || 0,
    }, null, 2));
  } catch (error) {
    console.error(`Error refreshing context cache: ${error.message}`);
    process.exit(1);
  }
})();
