#!/usr/bin/env node

import minimist from 'minimist';
import { fetchPolyglobeIntel, getPolyglobeCachePath } from '../lib/polyglobe.js';

const args = minimist(process.argv.slice(2));
const forceRefresh = Boolean(args.force || args['force-refresh']);
const cacheTtlSec = Math.max(30, parseInt(args['cache-ttl'] || '180', 10) || 180);

const intel = await fetchPolyglobeIntel({ cacheTtlSec, forceRefresh });
console.log(JSON.stringify({
  ok: !intel.error,
  cachePath: getPolyglobeCachePath(),
  fetchedAt: intel.fetchedAt,
  cacheHit: intel.cacheHit,
  stale: Boolean(intel.stale),
  error: intel.error || null,
  freshnessMinutes: intel.freshnessMinutes,
  breakingCount: intel.breakingMarkets?.length || 0,
  topBreaking: (intel.breakingMarkets || []).slice(0, 10),
  extendedOsintCount: intel.osintExtended?.length || 0,
  clusterCount: intel.clusters?.length || 0,
  slugCount: intel.slugs?.length || 0,
}, null, 2));
