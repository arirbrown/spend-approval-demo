// Pure functions for request validation and tier routing. No DB access — the
// caller supplies everything (including related spend from the splitting
// check), which keeps this fully unit-testable.

import { CONFIG, CONTRACT } from './config.js';

const money = n => `$${Math.round(n).toLocaleString('en-US')}`;

export function validateRequest(body) {
  const errors = [];
  if (!body.requester?.trim()) errors.push('Requester is required.');
  if (!body.bucketId) errors.push('Bucket is required.');
  if (!body.vendor?.trim()) errors.push('Vendor is required.');
  if (!(Number.isFinite(Number(body.amount)) && Number(body.amount) > 0))
    errors.push('Amount must be a positive number.');
  if (!body.goal?.trim()) errors.push('Goal is required.');
  if (!body.successMetric?.trim()) errors.push('Success metric is required.');
  if (!(Number.isFinite(Number(body.successTarget)) && Number(body.successTarget) > 0))
    errors.push('A numeric success metric target is required.');
  if (!Object.values(CONTRACT).includes(body.contractLength))
    errors.push('Contract length must be one-time, up to one quarter, or longer than one quarter.');
  return errors;
}

// Which tier does this dollar amount imply on its own?
export function amountTier(amount, cfg = CONFIG) {
  if (amount > cfg.TIER2_MAX) return 3;
  if (amount >= cfg.TIER1_MAX) return 2;
  return 1;
}

// Resolve the final tier for a request.
//   amount          — dollars requested
//   bucketRemaining — budget minus committed spend in that bucket
//   contractLength  — one of CONTRACT.*
//   relatedSpend    — combined $ of requests in the same bucket within the
//                     split window from the same requester OR same vendor
// Returns { tier, reasons, splitFlag }.
export function resolveTier({ amount, bucketRemaining, contractLength, relatedSpend = 0 }, cfg = CONFIG) {
  const reasons = [];
  let tier = amountTier(amount, cfg);
  if (tier === 3) reasons.push(`Amount ${money(amount)} is over ${money(cfg.TIER2_MAX)}.`);
  else if (tier === 2) reasons.push(`Amount ${money(amount)} falls in the ${money(cfg.TIER1_MAX)}–${money(cfg.TIER2_MAX)} range.`);

  if (amount > bucketRemaining) {
    reasons.push(`Amount exceeds the bucket's remaining budget of ${money(bucketRemaining)}.`);
    tier = 3;
  }
  if (contractLength === CONTRACT.MULTI_QUARTER && tier < 3) {
    reasons.push('Contract runs longer than one quarter.');
    tier = 3;
  }

  // Splitting check: would this request plus recent same-requester/same-vendor
  // activity in this bucket cross into a higher tier? If so, apply it.
  let splitFlag = null;
  if (relatedSpend > 0) {
    const combined = amount + relatedSpend;
    const combinedTier = amountTier(combined, cfg);
    if (combinedTier > tier) {
      splitFlag =
        `Possible split request: ${money(relatedSpend)} of other requests from the same ` +
        `requester or vendor hit this bucket in the last ${cfg.SPLIT_WINDOW_DAYS} days. ` +
        `Combined ${money(combined)} crosses into Tier ${combinedTier} territory.`;
      tier = combinedTier;
    }
  }

  return { tier, reasons, splitFlag };
}
