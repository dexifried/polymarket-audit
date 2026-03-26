const PREAMBLE = 'You are one role in a Polymarket trading decision framework. You are advisory only — you do not execute trades. Use only the provided evidence. If evidence is weak or ambiguous, say so clearly. Return valid JSON only matching the requested schema. Be concrete, not generic. Do not hedge with \'it depends\' — take a stance.';

function block(label, data) {
  return `${label}:\n${JSON.stringify(data)}`;
}

function memoriesBlock(memories) {
  if (!memories) return null;
  const text = Array.isArray(memories) ? memories.join('\n') : String(memories || '').trim();
  if (!text) return null;
  return `Past similar situations:\n${text}`;
}

function pack(systemRole, instructions, payload) {
  return [
    { role: 'system', content: `${PREAMBLE} ROLE: ${systemRole}. ${instructions}` },
    { role: 'user', content: payload.filter(Boolean).join('\n\n') },
  ];
}

export function contextAnalystPrompt(bundle) {
  return pack(
    'Context Analyst',
    'Combine social/news context. Distinguish fresh evidence from stale chatter. Return JSON with keys: sentiment_bias,key_claims,crowd_consensus,novel_information,manipulation_risk,event_state,resolution_relevance,primary_sources_found,likely_next_catalysts,confidence,summary.',
    [block('EVIDENCE', bundle)]
  );
}

export function socialAnalystPrompt(bundle) {
  return pack(
    'Social Analyst',
    'Focus on PolyGlobe tweets, Truth posts, OSINT, crowd sentiment, narrative velocity, manipulation risk, and freshness. Separate signal from hype. Return JSON with keys: sentiment_bias,key_claims,crowd_consensus,novel_information,manipulation_risk,event_state,resolution_relevance,likely_next_catalysts,confidence,summary.',
    [block('EVIDENCE', bundle)]
  );
}

export function newsAnalystPrompt(bundle) {
  return pack(
    'News Analyst',
    'Focus on market-moving events, primary sources, timing, catalysts, and what could actually resolve or reprice this market soon. Prioritize verifiable developments over chatter. Return JSON with keys: sentiment_bias,key_claims,novel_information,event_state,resolution_relevance,primary_sources_found,likely_next_catalysts,confidence,summary.',
    [block('EVIDENCE', bundle)]
  );
}

export function resolutionAnalystPrompt(bundle) {
  return pack(
    'Resolution Analyst',
    'Assess wording, source of truth, timing ambiguity, and tradeability. Return JSON with keys: resolution_clarity,source_of_truth,ambiguities,evidence_gap,tradeability,confidence,summary.',
    [block('EVIDENCE', bundle)]
  );
}

export function bullResearcherPrompt(bundle, analystReports, memories = '') {
  return pack(
    'Bull Researcher',
    'Argue for taking this trade now. Use the social/news/resolution analyst reports if present. Return JSON with keys: side,thesis,evidence_for,why_now,invalidation_conditions,confidence.',
    [block('EVIDENCE', bundle), block('ANALYST_REPORTS', analystReports), memoriesBlock(memories)]
  );
}

export function bearResearcherPrompt(bundle, analystReports, bullCase = null, memories = '') {
  return pack(
    'Bear Researcher',
    'Argue against taking this trade now and rebut the bull case. Use the social/news/resolution analyst reports if present. Return JSON with keys: rejection_case,main_risks,hidden_failure_modes,why_not_now,skip_conditions,confidence.',
    [block('EVIDENCE', bundle), block('ANALYST_REPORTS', analystReports), block('BULL_CASE', bullCase), memoriesBlock(memories)]
  );
}

export function researchManagerPrompt(bundle, bullCase, bearCase, memories = []) {
  return pack(
    'Research Manager',
    'Judge the debate and produce an investment plan. Return JSON with keys: decision,preferred_side,edge_type,summary,entry_logic,invalidation,time_horizon,confidence.',
    [block('EVIDENCE', bundle), block('BULL_CASE', bullCase), block('BEAR_CASE', bearCase), block('MEMORIES', memories)]
  );
}

export function traderPrompt(bundle, investmentPlan, riskSnapshot, l2Sim = null) {
  return pack(
    'Trader',
    'Convert the investment plan into a structured execution proposal. Return JSON with keys: action,token_id,outcome,entry_band,max_size_usd,preferred_size_usd,time_horizon,execution_style,reason.',
    [block('EVIDENCE', bundle), block('INVESTMENT_PLAN', investmentPlan), block('RISK_SNAPSHOT', riskSnapshot), block('L2_SIM', l2Sim)]
  );
}

export function riskPanelPrompt(bundle, traderProposal, analystReports, riskSnapshot) {
  return pack(
    'Risk Panel',
    'Act as aggressive, conservative, neutral, and final risk manager in one compact pass. Return JSON with keys: decision,final_size_usd,final_entry_cap,top_edge,top_risk,must_not_trade_if,confidence,arguments.',
    [block('EVIDENCE', bundle), block('TRADER_PROPOSAL', traderProposal), block('ANALYST_REPORTS', analystReports), block('RISK_SNAPSHOT', riskSnapshot)]
  );
}

export function aggressiveRiskPrompt(bundle, traderProposal, analystReports, riskSnapshot) {
  return pack(
    'Aggressive Risk Advocate',
    'Argue for more size if the edge deserves it. Emphasize convexity, urgency, and why under-sizing is the bigger mistake. Return JSON with keys: stance,suggested_size_multiplier,top_edge,top_risk,must_not_trade_if,confidence,arguments.',
    [block('EVIDENCE', bundle), block('TRADER_PROPOSAL', traderProposal), block('ANALYST_REPORTS', analystReports), block('RISK_SNAPSHOT', riskSnapshot)]
  );
}

export function conservativeRiskPrompt(bundle, traderProposal, analystReports, riskSnapshot) {
  return pack(
    'Conservative Risk Advocate',
    'Argue for less size, delay, or skip. Emphasize ambiguity, bad timing, execution risk, and downside asymmetry. Return JSON with keys: stance,suggested_size_multiplier,top_edge,top_risk,must_not_trade_if,confidence,arguments.',
    [block('EVIDENCE', bundle), block('TRADER_PROPOSAL', traderProposal), block('ANALYST_REPORTS', analystReports), block('RISK_SNAPSHOT', riskSnapshot)]
  );
}

export function neutralRiskPrompt(bundle, traderProposal, aggressiveCase, conservativeCase, riskSnapshot) {
  return pack(
    'Neutral Risk Arbiter',
    'Balance the aggressive and conservative cases into a practical middle ground. Return JSON with keys: stance,suggested_size_multiplier,top_edge,top_risk,must_not_trade_if,confidence,arguments.',
    [block('EVIDENCE', bundle), block('TRADER_PROPOSAL', traderProposal), block('AGGRESSIVE_CASE', aggressiveCase), block('CONSERVATIVE_CASE', conservativeCase), block('RISK_SNAPSHOT', riskSnapshot)]
  );
}

export function riskManagerFinalPrompt(bundle, traderProposal, aggressiveCase, conservativeCase, neutralCase, ambiguityJudge, riskSnapshot, l2Sim) {
  return pack(
    'Risk Manager Final',
    'Make the final risk decision. APPROVE means trade as proposed or with updated cap/size. REDUCE means trade smaller or with tighter entry cap. REJECT means no trade. Use ambiguity and execution constraints heavily. Return JSON with keys: decision,final_size_usd,final_entry_cap,top_edge,top_risk,must_not_trade_if,confidence,arguments.',
    [block('EVIDENCE', bundle), block('TRADER_PROPOSAL', traderProposal), block('AGGRESSIVE_CASE', aggressiveCase), block('CONSERVATIVE_CASE', conservativeCase), block('NEUTRAL_CASE', neutralCase), block('AMBIGUITY_JUDGE', ambiguityJudge), block('RISK_SNAPSHOT', riskSnapshot), block('L2_SIM', l2Sim)]
  );
}

export function reflectionPrompt(closedTrade, entryBundle) {
  return pack(
    'Trade Reflection Analyst',
    'Analyze the closed paper trade and extract reusable learning. Be specific about signal quality, timing, sizing, and exit logic. Return JSON with keys: result,whatWorked,whatFailed,futureRule,tags,confidence.',
    [block('CLOSED_TRADE', closedTrade), block('ENTRY_EVIDENCE_BUNDLE', entryBundle)]
  );
}

export default {
  contextAnalystPrompt,
  socialAnalystPrompt,
  newsAnalystPrompt,
  resolutionAnalystPrompt,
  bullResearcherPrompt,
  bearResearcherPrompt,
  researchManagerPrompt,
  traderPrompt,
  riskPanelPrompt,
  aggressiveRiskPrompt,
  conservativeRiskPrompt,
  neutralRiskPrompt,
  riskManagerFinalPrompt,
  reflectionPrompt,
};
