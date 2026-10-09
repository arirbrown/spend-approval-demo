import { CONFIG, PEOPLE } from './config.js';
import { listBuckets, presentRequest } from './service.js';

function weekStartMs(atMs) {
  // Local-time Monday 00:00 of the week containing atMs.
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function buildDigest(db, atMs) {
  const q0 = Date.parse(CONFIG.QUARTER_START);
  const q1 = Date.parse(CONFIG.QUARTER_END);
  const elapsed = Math.min(Math.max((atMs - q0) / (q1 - q0), 0), 1);

  const buckets = listBuckets(db).map(b => {
    const expected = b.budget * elapsed;
    const pace = expected > 0 ? b.actual / expected : (b.actual > 0 ? Infinity : 1);
    let flag = 'on_pace';
    if (b.is_reserve) flag = 'reserve';
    else if (pace > 1 + CONFIG.PACE_TOLERANCE) flag = 'ahead';
    else if (pace < 1 - CONFIG.PACE_TOLERANCE) flag = 'behind';
    return { ...b, expected, pace, flag };
  });

  const requests = db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all()
    .map(r => presentRequest(db, r, atMs));
  const pending = requests.filter(r => r.status === 'pending');
  const escalations = pending.filter(r => r.escalated);
  const splitFlags = requests.filter(r => r.split_flag && r.status !== 'rejected');

  // Big commitments whose spend date lands in the upcoming window.
  const upcoming = db.prepare(
    `SELECT l.*, b.name bucket_name, r.vendor FROM ledger l
     JOIN buckets b ON b.id = l.bucket_id JOIN requests r ON r.id = l.request_id
     WHERE l.committed > ? AND l.date >= ? AND l.date <= ?
     ORDER BY l.date`
  ).all(
    CONFIG.BIG_COMMITMENT_MIN,
    new Date(atMs).toISOString(),
    new Date(atMs + CONFIG.UPCOMING_WINDOW_DAYS * 86400e3).toISOString()
  );

  const headDecisions = db.prepare(
    "SELECT COUNT(*) c FROM approvals WHERE role = 'head_of_marketing' AND created_at >= ?"
  ).get(new Date(weekStartMs(atMs)).toISOString()).c;

  const totals = buckets.reduce((t, b) => ({
    budget: t.budget + b.budget, committed: t.committed + b.committed,
    actual: t.actual + b.actual, remaining: t.remaining + b.remaining,
  }), { budget: 0, committed: 0, actual: 0, remaining: 0 });

  return {
    quarterElapsed: elapsed,
    buckets,
    totals,
    pending,
    escalations,
    splitFlags,
    upcoming,
    headDecisions,
    headName: PEOPLE.HEAD,
  };
}
