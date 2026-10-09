// Every configurable threshold lives here. Change these values to retune the
// workflow rules — tiers, escalation timing, splitting window, pace tolerance —
// without touching any logic.

export const CONFIG = {
  TIER1_MAX: 25_000,            // strictly below this (and within remaining budget) auto-approves
  TIER2_MAX: 250_000,           // at/below this needs one approver; strictly above needs head + finance
  ESCALATION_HOURS: 24,         // untouched Tier 2 requests escalate to the head of marketing
  SPLIT_WINDOW_DAYS: 30,        // lookback window for the split-request check
  RESERVE_PCT: 0.12,            // share of total budget held in the reserve bucket
  PACE_TOLERANCE: 0.20,         // digest flags buckets more than 20% ahead/behind pace
  BIG_COMMITMENT_MIN: 100_000,  // "large commitment" threshold in the weekly digest
  UPCOMING_WINDOW_DAYS: 30,     // how far ahead the digest looks for big commitments
  QUARTER_START: '2026-10-01T00:00:00',
  QUARTER_END: '2026-12-31T23:59:59',
  TOTAL_BUDGET: 2_400_000,
};

export const PEOPLE = {
  HEAD: 'Maya Chen',      // head of marketing — owns reserve, approves Tier 3 and escalations
  FINANCE: 'Morgan Ellis' // finance — second approver on Tier 3
};

export const CONTRACT = {
  ONE_TIME: 'one_time',
  UP_TO_QUARTER: 'up_to_quarter',
  MULTI_QUARTER: 'multi_quarter',
};

export const CONTRACT_LABELS = {
  [CONTRACT.ONE_TIME]: 'One-time',
  [CONTRACT.UP_TO_QUARTER]: 'Up to one quarter',
  [CONTRACT.MULTI_QUARTER]: 'Longer than one quarter',
};
