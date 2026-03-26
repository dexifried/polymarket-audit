function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJsonLike(input) {
  if (isObject(input)) return { raw: input, errors: [] };
  if (typeof input !== 'string') return { raw: {}, errors: ['input_not_json'] };
  try {
    return { raw: JSON.parse(input), errors: [] };
  } catch {
    return { raw: { raw: input }, errors: ['invalid_json'] };
  }
}

function result(valid, errors, cleaned) {
  return { valid, errors, cleaned };
}

function cleanAnalyst(raw = {}, role = 'analyst') {
  return {
    role,
    summary: asString(raw.summary, ''),
    confidence: asNumber(raw.confidence, 0),
    key_claims: asArray(raw.key_claims).map(String).slice(0, 8),
    risks: asArray(raw.risks || raw.red_flags || raw.ambiguities).map(String).slice(0, 8),
    sentiment_bias: asString(raw.sentiment_bias, raw.bias || raw.recommended_bias || 'none'),
    crowd_consensus: asString(raw.crowd_consensus, 'unclear'),
    novel_information: Boolean(raw.novel_information),
    manipulation_risk: asString(raw.manipulation_risk, 'unknown'),
    event_state: asString(raw.event_state, 'unknown'),
    resolution_relevance: asString(raw.resolution_relevance, 'unknown'),
    primary_sources_found: asArray(raw.primary_sources_found || raw.source_of_truth).map(String).slice(0, 8),
    likely_next_catalysts: asArray(raw.likely_next_catalysts).map(String).slice(0, 8),
    resolution_clarity: asString(raw.resolution_clarity, 'unknown'),
    ambiguities: asArray(raw.ambiguities).map(String).slice(0, 8),
    evidence_gap: asArray(raw.evidence_gap).map(String).slice(0, 8),
    tradeability: asString(raw.tradeability, 'watch_only'),
  };
}

function cleanResearch(raw = {}, role = 'research') {
  return {
    role,
    decision: asString(raw.decision, raw.action || 'WATCH'),
    side: asString(raw.side, raw.preferred_side || 'NONE'),
    thesis: asString(raw.thesis || raw.summary || raw.rejection_case, ''),
    evidence_for: asArray(raw.evidence_for).map(String).slice(0, 8),
    why_now: asArray(raw.why_now || raw.why_not_now).map(String).slice(0, 8),
    invalidation_conditions: asArray(raw.invalidation_conditions || raw.invalidation || raw.skip_conditions).map(String).slice(0, 8),
    main_risks: asArray(raw.main_risks || raw.hidden_failure_modes).map(String).slice(0, 8),
    edge_type: asArray(raw.edge_type).map(String).slice(0, 6),
    time_horizon: asString(raw.time_horizon, 'minutes'),
    confidence: asNumber(raw.confidence, 0),
    summary: asString(raw.summary, ''),
    entry_logic: asString(raw.entry_logic, ''),
  };
}

function cleanTrader(raw = {}) {
  const entryBand = isObject(raw.entry_band) ? raw.entry_band : {};
  return {
    action: asString(raw.action, 'SKIP'),
    token_id: asString(raw.token_id, raw.tokenId || ''),
    outcome: asString(raw.outcome, ''),
    entry_band: {
      min: asNumber(entryBand.min, 0),
      max: asNumber(entryBand.max, 0),
    },
    max_size_usd: asNumber(raw.max_size_usd, 0),
    preferred_size_usd: asNumber(raw.preferred_size_usd, 0),
    time_horizon: asString(raw.time_horizon, 'minutes'),
    execution_style: asString(raw.execution_style, 'either'),
    reason: asString(raw.reason, ''),
  };
}

function cleanRisk(raw = {}, role = 'risk') {
  return {
    role,
    decision: asString(raw.decision, 'REJECT'),
    stance: asString(raw.stance, ''),
    final_size_usd: asNumber(raw.final_size_usd, 0),
    final_entry_cap: asNumber(raw.final_entry_cap, 0),
    suggested_size_multiplier: asNumber(raw.suggested_size_multiplier, 0),
    top_edge: asString(raw.top_edge, ''),
    top_risk: asString(raw.top_risk, ''),
    arguments: asArray(raw.arguments).map(String).slice(0, 8),
    must_not_trade_if: asArray(raw.must_not_trade_if || raw.veto_conditions || raw.wait_for).map(String).slice(0, 8),
    confidence: asNumber(raw.confidence, 0),
  };
}

function cleanReflection(raw = {}) {
  return {
    result: asString(raw.result, 'mixed'),
    whatWorked: asArray(raw.whatWorked || raw.what_worked).map(String).slice(0, 8),
    whatFailed: asArray(raw.whatFailed || raw.what_failed).map(String).slice(0, 8),
    futureRule: asString(raw.futureRule, raw.future_rule || ''),
    tags: asArray(raw.tags).map(String).slice(0, 8),
    confidence: asNumber(raw.confidence, 0),
  };
}

export function validateAnalystReport(json, role = 'analyst') {
  const parsed = parseJsonLike(json);
  const cleaned = cleanAnalyst(parsed.raw, role);
  const errors = [...parsed.errors];
  if (!cleaned.summary && !cleaned.key_claims.length && !cleaned.ambiguities.length) errors.push('empty_analyst_output');
  return result(errors.length === 0, errors, cleaned);
}

export function validateSocialAnalyst(json, role = 'social_analyst') {
  return validateAnalystReport(json, role);
}

export function validateNewsAnalyst(json, role = 'news_analyst') {
  return validateAnalystReport(json, role);
}

export function validateResearchOutput(json, role = 'research') {
  const parsed = parseJsonLike(json);
  const cleaned = cleanResearch(parsed.raw, role);
  const errors = [...parsed.errors];
  if (!cleaned.thesis && !cleaned.summary) errors.push('empty_research_output');
  return result(errors.length === 0, errors, cleaned);
}

export function validateTraderProposal(json) {
  const parsed = parseJsonLike(json);
  const cleaned = cleanTrader(parsed.raw);
  const errors = [...parsed.errors];
  if (!cleaned.token_id) errors.push('missing_token_id');
  return result(errors.length === 0, errors, cleaned);
}

export function validateRiskOutput(json, role = 'risk') {
  const parsed = parseJsonLike(json);
  const cleaned = cleanRisk(parsed.raw, role);
  const errors = [...parsed.errors];
  if (!cleaned.decision && !cleaned.stance) errors.push('empty_risk_output');
  return result(errors.length === 0, errors, cleaned);
}

export function validateAggressiveRisk(json, role = 'aggressive_risk') {
  return validateRiskOutput(json, role);
}

export function validateConservativeRisk(json, role = 'conservative_risk') {
  return validateRiskOutput(json, role);
}

export function validateNeutralRisk(json, role = 'neutral_risk') {
  return validateRiskOutput(json, role);
}

export function validateRiskManagerFinal(json, role = 'risk_manager_final') {
  return validateRiskOutput(json, role);
}

export function validateReflection(json) {
  const parsed = parseJsonLike(json);
  const cleaned = cleanReflection(parsed.raw);
  const errors = [...parsed.errors];
  if (!cleaned.futureRule && !cleaned.whatFailed.length && !cleaned.whatWorked.length) errors.push('empty_reflection_output');
  return result(errors.length === 0, errors, cleaned);
}
