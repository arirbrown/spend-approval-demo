import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier, amountTier, validateRequest } from '../src/tiers.js';
import { CONTRACT } from '../src/config.js';

const base = { bucketRemaining: 1_000_000, contractLength: CONTRACT.ONE_TIME, relatedSpend: 0 };

test('boundary: $24,999 is Tier 1 (auto-approved)', () => {
  assert.equal(resolveTier({ ...base, amount: 24_999 }).tier, 1);
  assert.equal(resolveTier({ ...base, amount: 24_999.99 }).tier, 1);
});

test('boundary: $25,000 is Tier 2', () => {
  assert.equal(resolveTier({ ...base, amount: 25_000 }).tier, 2);
});

test('boundary: $250,000 is Tier 2', () => {
  assert.equal(resolveTier({ ...base, amount: 250_000 }).tier, 2);
});

test('boundary: $250,001 is Tier 3', () => {
  const r = resolveTier({ ...base, amount: 250_001 });
  assert.equal(r.tier, 3);
  assert.ok(r.reasons.some(x => x.includes('250,000')));
});

test('contract length: longer than one quarter forces Tier 3 even for small amounts', () => {
  const r = resolveTier({ ...base, amount: 9_000, contractLength: CONTRACT.MULTI_QUARTER });
  assert.equal(r.tier, 3);
  assert.ok(r.reasons.some(x => x.includes('longer than one quarter')));
});

test('contract length: up to one quarter does not bump the tier', () => {
  assert.equal(resolveTier({ ...base, amount: 9_000, contractLength: CONTRACT.UP_TO_QUARTER }).tier, 1);
});

test('over budget: amount exceeding remaining budget forces Tier 3', () => {
  const r = resolveTier({ ...base, amount: 15_000, bucketRemaining: 10_000 });
  assert.equal(r.tier, 3);
  assert.ok(r.reasons.some(x => x.includes('remaining budget')));
});

test('within remaining budget stays Tier 1', () => {
  assert.equal(resolveTier({ ...base, amount: 10_000, bucketRemaining: 10_000 }).tier, 1);
});

test('splitting: combined total crossing into Tier 2 bumps the request and flags it', () => {
  const r = resolveTier({ ...base, amount: 20_000, relatedSpend: 10_000 });
  assert.equal(r.tier, 2);
  assert.ok(r.splitFlag.includes('30 days'));
  assert.ok(r.splitFlag.includes('30,000'));
});

test('splitting: combined total crossing into Tier 3 applies the higher tier', () => {
  const r = resolveTier({ ...base, amount: 200_000, relatedSpend: 60_000 });
  assert.equal(r.tier, 3);
  assert.ok(r.splitFlag);
});

test('splitting: related spend that does not cross a threshold produces no flag', () => {
  const r = resolveTier({ ...base, amount: 100_000, relatedSpend: 100_000 });
  assert.equal(r.tier, 2);
  assert.equal(r.splitFlag, null);
});

test('amountTier boundaries are consistent with resolveTier', () => {
  assert.equal(amountTier(24_999), 1);
  assert.equal(amountTier(25_000), 2);
  assert.equal(amountTier(250_000), 2);
  assert.equal(amountTier(250_001), 3);
});

const good = {
  requester: 'Dana Reyes', bucketId: 1, vendor: 'Acme', amount: 10_000,
  goal: 'Grow signups', successMetric: 'Signups', successTarget: 500,
  contractLength: CONTRACT.ONE_TIME, cancellable: true,
};

test('validation: missing goal is rejected', () => {
  assert.ok(validateRequest({ ...good, goal: '' }).some(e => e.includes('Goal')));
  assert.ok(validateRequest({ ...good, goal: undefined }).some(e => e.includes('Goal')));
});

test('validation: missing success metric or target is rejected', () => {
  assert.ok(validateRequest({ ...good, successMetric: '' }).some(e => e.includes('Success metric')));
  assert.ok(validateRequest({ ...good, successTarget: undefined }).some(e => e.includes('target')));
});

test('validation: a complete request passes', () => {
  assert.deepEqual(validateRequest(good), []);
});
