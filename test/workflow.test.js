import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { submitRequest, approveRequest, rejectRequest, isEscalated, recordActual } from '../src/service.js';
import { setClockOffsetMs, nowMs, HOUR } from '../src/clock.js';
import { PEOPLE, CONTRACT } from '../src/config.js';

function freshDb(budget = 1_000_000) {
  const db = openDb(':memory:');
  db.prepare(
    'INSERT INTO buckets (name, motion, region, channel, owner, lead, budget, metric, is_reserve) VALUES (?,?,?,?,?,?,?,?,0)'
  ).run('Test Bucket', 'Self-serve', 'US', 'Paid ads', 'Owner One', 'Lead Len', budget, 'Signups');
  return db;
}

const req = (over = {}) => ({
  requester: 'Dana Reyes', bucketId: 1, vendor: 'Acme Ads', amount: 10_000,
  goal: 'Grow signups', successMetric: 'Signups', successTarget: 500,
  contractLength: CONTRACT.ONE_TIME, cancellable: true, ...over,
});

test('Tier 1 submits, auto-approves, and writes a verified ledger entry', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ amount: 12_000 }));
  assert.equal(out.request.status, 'approved');
  assert.equal(out.request.tier, 1);
  assert.equal(out.ledger.verified, true);
  assert.equal(out.ledger.entry.committed, 12_000);
  assert.match(out.ledger.entry.receipt_id, /^RCP-2026-/);
});

test('Tier 2 waits in queue, then approves via the bucket lead', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ amount: 60_000 }));
  assert.equal(out.request.status, 'pending');
  assert.equal(out.request.tier, 2);

  const done = approveRequest(db, out.request.id);
  assert.equal(done.request.status, 'approved');
  assert.equal(done.ledger.entry.approver, 'Lead Len');
  assert.equal(done.ledger.verified, true);
});

test('Tier 2 untouched for 24h escalates to the head of marketing', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ amount: 60_000 }));
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(out.request.id);

  assert.equal(isEscalated(row, nowMs(db)), false);
  setClockOffsetMs(db, 25 * HOUR); // advance demo clock past the SLA
  assert.equal(isEscalated(row, nowMs(db)), true);

  const done = approveRequest(db, out.request.id);
  assert.equal(done.request.status, 'approved');
  assert.equal(done.ledger.entry.approver, PEOPLE.HEAD);
});

test('Tier 3 approves sequentially: head of marketing, then finance', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ amount: 300_000 }));
  assert.equal(out.request.tier, 3);
  assert.equal(out.request.required_role, 'head_of_marketing');

  const step1 = approveRequest(db, out.request.id);
  assert.equal(step1.request.status, 'pending');
  assert.equal(step1.request.required_role, 'finance');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ledger').get().c, 0); // not committed yet

  const step2 = approveRequest(db, out.request.id);
  assert.equal(step2.request.status, 'approved');
  assert.equal(step2.ledger.entry.approver, `${PEOPLE.HEAD} + ${PEOPLE.FINANCE}`);
});

test('splitting rule: a second request from the same vendor in the window is bumped and flagged', () => {
  const db = freshDb();
  submitRequest(db, req({ vendor: 'Meridian Media', amount: 18_000 }));
  const out = submitRequest(db, req({ vendor: 'meridian media', amount: 10_000 })); // case-insensitive match
  assert.equal(out.request.tier, 2);
  assert.ok(out.request.split_flag);
});

test('splitting rule does not trigger on a different vendor and requester', () => {
  const db = freshDb();
  submitRequest(db, req({ vendor: 'Vendor A', amount: 18_000 }));
  const out = submitRequest(db, req({ requester: 'Someone Else', vendor: 'Vendor B', amount: 10_000 }));
  assert.equal(out.request.tier, 1);
  assert.equal(out.request.split_flag, null);
});

test('going over the bucket remaining budget routes to Tier 3', () => {
  const db = freshDb(30_000);
  submitRequest(db, req({ amount: 20_000 })); // commits 20K, leaves 10K
  const out = submitRequest(db, req({ vendor: 'Other Co', amount: 15_000 }));
  assert.equal(out.request.tier, 3);
  assert.equal(out.request.status, 'pending');
  assert.ok(out.request.tier_reasons.some(x => x.includes('remaining budget')));
});

test('missing goal or success metric is rejected before any tier logic', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ goal: '', successTarget: undefined }));
  assert.ok(out.errors.length >= 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM requests').get().c, 0);
});

test('rejected requests leave no ledger entry', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ amount: 60_000 }));
  rejectRequest(db, out.request.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ledger').get().c, 0);
});

test('actual spend can be recorded against a committed entry', () => {
  const db = freshDb();
  const out = submitRequest(db, req({ amount: 12_000 }));
  const updated = recordActual(db, out.ledger.entry.id, 7_500);
  assert.equal(updated.entry.actual, 7_500);
  assert.ok(recordActual(db, out.ledger.entry.id, -5).error);
});
