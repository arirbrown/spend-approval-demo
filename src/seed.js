// Seeds a realistic Q4 2026 dataset. Historical timestamps are expressed as
// offsets from "now" (the demo clock), so escalation and pending-age behavior
// always work whenever the seed runs. Run standalone with `npm run seed`, or
// hit POST /api/reset.

import { CONFIG, PEOPLE, CONTRACT } from './config.js';
import { resolveTier } from './tiers.js';
import { relatedSpend, verifyEntry } from './service.js';
import { nowMs, HOUR, DAY } from './clock.js';
import { openDb } from './db.js';

const BUCKETS = [
  { name: 'Self-serve · US · Paid ads',        motion: 'Self-serve', region: 'US',     channel: 'Paid ads',     owner: 'Dana Reyes',    lead: 'Alex Kim',    budget: 420_000, metric: 'New self-serve signups' },
  { name: 'Self-serve · Europe · Paid ads',    motion: 'Self-serve', region: 'Europe', channel: 'Paid ads',     owner: 'Jonas Weber',   lead: 'Ingrid Falk', budget: 260_000, metric: 'Trial activations' },
  { name: 'Self-serve · APAC · Agencies',      motion: 'Self-serve', region: 'APAC',   channel: 'Agencies',     owner: 'Aiko Tanaka',   lead: 'Kenji Sato',  budget: 150_000, metric: 'Agency-sourced signups' },
  { name: 'Enterprise · US · Events',          motion: 'Enterprise', region: 'US',     channel: 'Events',       owner: 'Marcus Lee',    lead: 'Tom Bradley', budget: 380_000, metric: 'Qualified pipeline ($)' },
  { name: 'Enterprise · Europe · Sponsorships',motion: 'Enterprise', region: 'Europe', channel: 'Sponsorships', owner: 'Elena Petrova', lead: 'Priya Nair',  budget: 290_000, metric: 'SQLs from sponsored properties' },
  { name: 'Enterprise · APAC · Events',        motion: 'Enterprise', region: 'APAC',   channel: 'Events',       owner: 'Ravi Sharma',   lead: 'Kenji Sato',  budget: 180_000, metric: 'Pipeline ($) from field events' },
  { name: 'Brand · US · Sponsorships',         motion: 'Brand',      region: 'US',     channel: 'Sponsorships', owner: 'Chloe Dubois',  lead: 'Sofia Marino',budget: 272_000, metric: 'Brand awareness lift (pts)' },
  { name: 'Brand · Europe · Agencies',         motion: 'Brand',      region: 'Europe', channel: 'Agencies',     owner: 'Sam Okafor',    lead: 'Ingrid Falk', budget: 160_000, metric: 'Aided brand recall (%)' },
];

export function reseed(db) {
  db.exec('DELETE FROM approvals; DELETE FROM ledger; DELETE FROM requests; DELETE FROM buckets; DELETE FROM settings; DELETE FROM slack_messages;');
  const t = nowMs(db);
  const iso = ms => new Date(ms).toISOString();

  const insBucket = db.prepare(
    'INSERT INTO buckets (name, motion, region, channel, owner, lead, budget, metric, is_reserve) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insReq = db.prepare(
    `INSERT INTO requests (requester, bucket_id, vendor, amount, description, goal, success_metric,
      success_target, contract_length, cancellable, spend_date, tier, status, split_flag,
      tier_reasons, required_role, decided_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insAppr = db.prepare(
    'INSERT INTO approvals (request_id, actor, role, action, created_at) VALUES (?,?,?,?,?)'
  );
  const insLedger = db.prepare(
    `INSERT INTO ledger (request_id, receipt_id, bucket_id, committed, actual, approver, verified, mismatch, date)
     VALUES (?,?,?,?,?,?,0,NULL,?)`
  );
  const insSlack = db.prepare(
    'INSERT INTO slack_messages (author, is_bot, text, ts, status, parsed, request_id) VALUES (?,?,?,?,?,?,?)'
  );
  let receipt = 0;

  const bucketIds = BUCKETS.map(b => Number(insBucket.run(
    b.name, b.motion, b.region, b.channel, b.owner, b.lead, b.budget, b.metric, 0
  ).lastInsertRowid));
  const reserve = Math.round(CONFIG.TOTAL_BUDGET * CONFIG.RESERVE_PCT);
  insBucket.run('Reserve', 'All', 'All', 'All', PEOPLE.HEAD, PEOPLE.HEAD, reserve,
    'Opportunistic initiatives approved by the head of marketing', 1);

  const remaining = id => {
    const b = db.prepare('SELECT budget FROM buckets WHERE id = ?').get(id);
    const c = db.prepare('SELECT COALESCE(SUM(committed),0) s FROM ledger WHERE bucket_id = ?').get(id).s;
    return b.budget - c;
  };

  // An approved request -> approval rows -> ledger row -> read-back verify.
  function approved(bi, o) {
    const bucketId = bucketIds[bi];
    const { reasons } = resolveTier({
      amount: o.amount, bucketRemaining: 999_999_999,
      contractLength: o.contract ?? CONTRACT.ONE_TIME, relatedSpend: 0,
    });
    const id = Number(insReq.run(
      o.requester, bucketId, o.vendor, o.amount, o.description ?? '', o.goal,
      o.metric, o.target, o.contract ?? CONTRACT.ONE_TIME, o.cancellable ?? 1,
      o.spendDate ? iso(o.spendDate) : null, o.tier, 'approved', null,
      JSON.stringify(o.reasons ?? reasons), null, iso(o.decidedAt), iso(o.createdAt)
    ).lastInsertRowid);
    for (const a of o.approvers) insAppr.run(id, a.actor, a.role, 'approved', iso(a.at));
    const entryId = Number(insLedger.run(
      id, `RCP-2026-${String(++receipt).padStart(4, '0')}`, bucketId, o.amount, o.actual ?? 0,
      o.approvers.map(a => a.actor).join(' + '), iso(o.spendDate ?? o.decidedAt)
    ).lastInsertRowid);
    verifyEntry(db, entryId);
    return id;
  }

  function pending(bi, o) {
    const bucketId = bucketIds[bi];
    const rel = relatedSpend(db, bucketId, o.requester, o.vendor, o.createdAt);
    const { tier, reasons, splitFlag } = resolveTier({
      amount: o.amount, bucketRemaining: remaining(bucketId),
      contractLength: o.contract ?? CONTRACT.ONE_TIME, relatedSpend: rel,
    });
    const id = Number(insReq.run(
      o.requester, bucketId, o.vendor, o.amount, o.description ?? '', o.goal,
      o.metric, o.target, o.contract ?? CONTRACT.ONE_TIME, o.cancellable ?? 1,
      null, o.tier ?? tier, 'pending', o.splitFlag ?? splitFlag,
      JSON.stringify(o.reasons ?? reasons),
      o.requiredRole ?? (tier === 2 ? 'lead' : 'head_of_marketing'), null, iso(o.createdAt)
    ).lastInsertRowid);
    for (const a of o.approvers ?? []) insAppr.run(id, a.actor, a.role, a.action ?? 'approved', iso(a.at));
    return id;
  }

  const auto = at => [{ actor: 'Auto-approval', role: 'auto', at }];
  const lead = (name, at) => [{ actor: name, role: 'lead', at }];
  const headFinance = (h, f) => [
    { actor: PEOPLE.HEAD, role: 'head_of_marketing', at: h },
    { actor: PEOPLE.FINANCE, role: 'finance', at: f },
  ];
  const g = (goal, metric, target) => ({ goal, metric, target });

  // ---- approved history (drives committed / actual / pace) ----
  approved(0, { requester: 'Dana Reyes', vendor: 'BrightWave Ads', amount: 30_000, tier: 1,
    ...g('Scale paid social acquisition for the self-serve funnel', 'New signups', 2400),
    description: 'Q4 paid social burst across Meta and TikTok.',
    approvers: auto(t - 6 * DAY), createdAt: t - 6 * DAY, decidedAt: t - 6 * DAY, actual: 28_000 });
  approved(0, { requester: 'Dana Reyes', vendor: 'Meridian Media', amount: 18_000, tier: 1,
    ...g('Test programmatic display for retargeting', 'Signup CPA under $45', 400),
    description: 'Retargeting pool refresh ahead of holiday push.',
    approvers: auto(t - 5 * DAY), createdAt: t - 5 * DAY, decidedAt: t - 5 * DAY, actual: 10_000 });
  approved(0, { requester: 'Dana Reyes', vendor: 'Searchly', amount: 12_000, tier: 1,
    ...g('Capture branded and competitor search demand', 'Signups', 900),
    description: 'Search ads on competitor keywords.',
    approvers: auto(t - 3 * DAY), createdAt: t - 3 * DAY, decidedAt: t - 3 * DAY, actual: 5_000 });
  approved(1, { requester: 'Jonas Weber', vendor: 'EuroAds Platform', amount: 40_000, tier: 2,
    ...g('Grow EU trial volume through paid search', 'Trial activations', 1500),
    description: 'Google Ads expansion across DE, FR, NL.',
    approvers: lead('Ingrid Falk', t - 4 * DAY), createdAt: t - 5 * DAY, decidedAt: t - 4 * DAY, actual: 25_000 });
  approved(2, { requester: 'Aiko Tanaka', vendor: 'Tokyo Growth Lab', amount: 10_000, tier: 1,
    ...g('Localize onboarding funnel for Japan', 'Localized signups', 350),
    description: 'Agency sprint for JP landing pages and lifecycle emails.',
    approvers: auto(t - 4 * DAY), createdAt: t - 4 * DAY, decidedAt: t - 4 * DAY, actual: 2_000 });
  approved(3, { requester: 'Marcus Lee', vendor: 'National Tech Summit', amount: 300_000, tier: 3,
    ...g('Anchor US enterprise pipeline at flagship conference', 'Qualified pipeline ($)', 2_000_000),
    description: 'Diamond sponsorship + keynote slot + booth. Spend lands when the event runs.',
    approvers: headFinance(t - 6 * DAY, t - 5 * DAY), createdAt: t - 7 * DAY,
    decidedAt: t - 5 * DAY, spendDate: t + 11 * DAY, actual: 0 });
  approved(3, { requester: 'Marcus Lee', vendor: 'Summit Venues', amount: 50_000, tier: 2,
    ...g('Executive dinner series for target accounts', 'Meetings held', 40),
    description: 'Three-city CXO dinner program.',
    approvers: lead('Tom Bradley', t - 4 * DAY), createdAt: t - 5 * DAY, decidedAt: t - 4 * DAY, actual: 45_000 });
  approved(3, { requester: 'Marcus Lee', vendor: 'Field Ops Logistics', amount: 30_000, tier: 2,
    ...g('Booth build-out and shipping for Q4 events', 'Events executed', 4),
    description: 'Freight, booth fabrication, on-site labor.',
    approvers: lead('Tom Bradley', t - 5 * DAY), createdAt: t - 6 * DAY, decidedAt: t - 5 * DAY, actual: 28_000 });
  approved(4, { requester: 'Elena Petrova', vendor: 'Leipzig Media Haus', amount: 45_000, tier: 2,
    ...g('Sponsor two EU industry newsletters', 'SQLs', 90),
    description: 'Newsletter sponsorship package through December.',
    approvers: lead('Priya Nair', t - 4 * DAY), createdAt: t - 5 * DAY, decidedAt: t - 4 * DAY, actual: 30_000 });
  approved(5, { requester: 'Ravi Sharma', vendor: 'Singapore Event Collective', amount: 20_000, tier: 1,
    ...g('Run APAC field meetup series', 'Pipeline ($)', 400_000),
    description: 'Singapore and Sydney customer meetups.',
    approvers: auto(t - 4 * DAY), createdAt: t - 4 * DAY, decidedAt: t - 4 * DAY, actual: 13_000 });
  approved(6, { requester: 'Chloe Dubois', vendor: 'Podcast Network One', amount: 40_000, tier: 2,
    ...g('Brand reach via top business podcasts', 'Awareness lift (pts)', 3),
    description: 'Host-read spots across 6 shows.',
    approvers: lead('Sofia Marino', t - 5 * DAY), createdAt: t - 6 * DAY, decidedAt: t - 5 * DAY, actual: 28_000 });
  approved(6, { requester: 'Chloe Dubois', vendor: 'Championship Series', amount: 120_000, tier: 2,
    ...g('Title sponsorship for championship livestream', 'Brand recall (%)', 8),
    description: 'Broadcast + social package. Spend scheduled when the series starts.',
    approvers: lead('Sofia Marino', t - 1 * DAY), createdAt: t - 2 * DAY,
    decidedAt: t - 1 * DAY, spendDate: t + 19 * DAY, actual: 0 });
  approved(7, { requester: 'Sam Okafor', vendor: 'Nordic Creative Studio', amount: 20_000, tier: 1,
    ...g('Refresh EU brand campaign creative', 'Aided recall (%)', 5),
    description: 'Agency retainer for Q4 creative refresh.',
    approvers: auto(t - 3 * DAY), createdAt: t - 3 * DAY, decidedAt: t - 3 * DAY, actual: 16_000 });

  // ---- rejected (head of marketing decision this week) ----
  {
    const bucketId = bucketIds[5];
    const { reasons } = resolveTier({ amount: 35_000, bucketRemaining: remaining(bucketId),
      contractLength: CONTRACT.MULTI_QUARTER, relatedSpend: 0 });
    const id = Number(insReq.run(
      'Ravi Sharma', bucketId, 'APAC SaaS Collective', 35_000,
      'Annual co-marketing partnership.', 'Co-marketed pipeline in APAC', 'Pipeline ($)', 250_000,
      CONTRACT.MULTI_QUARTER, 0, null, 3, 'rejected', null, JSON.stringify(reasons),
      null, iso(t - 20 * HOUR), iso(t - 22 * HOUR)
    ).lastInsertRowid);
    insAppr.run(id, PEOPLE.HEAD, 'head_of_marketing', 'rejected', iso(t - 20 * HOUR));
  }

  // ---- pending queue ----
  pending(0, { requester: 'Dana Reyes', vendor: 'Meridian Media', amount: 10_000,
    ...g('Extend retargeting test with fresh creative', 'Signup CPA under $45', 220),
    description: 'Incremental budget on the Meridian buy.',
    createdAt: t - 2 * HOUR });
  pending(1, { requester: 'Jonas Weber', vendor: 'AdVerve Networks', amount: 45_000,
    ...g('Add paid social in EU for Q4 push', 'Trial activations', 1700),
    description: 'Meta + LinkedIn campaigns, DE/FR/NL.',
    createdAt: t - 3 * HOUR });
  pending(4, { requester: 'Elena Petrova', vendor: 'Global Expo Group', amount: 80_000,
    ...g('Sponsor enterprise pavilion at EU expo', 'SQLs', 160),
    description: 'Pavilion sponsorship, Berlin expo in November.',
    createdAt: t - 26 * HOUR }); // stale -> escalates to head of marketing
  pending(3, { requester: 'Marcus Lee', vendor: 'Last-Minute Booths', amount: 25_000,
    ...g('Upgrade booth footprint for flagship summit', 'Qualified pipeline ($)', 150_000),
    description: 'Larger footprint opened up next to keynote hall.',
    createdAt: t - 5 * HOUR }); // bucket is fully committed -> Tier 3
  pending(7, { requester: 'Sam Okafor', vendor: 'Creative Partners EU', amount: 9_000,
    ...g('Always-on brand design retainer', 'Aided recall (%)', 4),
    description: 'Rolling design retainer through mid-2027.',
    contract: CONTRACT.MULTI_QUARTER, createdAt: t - 7 * HOUR }); // multi-quarter -> Tier 3
  pending(4, { requester: 'Elena Petrova', vendor: 'Champions League Digital', amount: 260_000,
    ...g('Digital sponsorship package for EU enterprise motion', 'SQLs', 500),
    description: 'Season-long digital + social sponsorship.',
    createdAt: t - 30 * HOUR, requiredRole: 'finance',
    approvers: [{ actor: PEOPLE.HEAD, role: 'head_of_marketing', at: t - 4 * HOUR }] }); // head approved -> awaiting finance

  // ---- mock Slack channel (#mktg-spend-requests) ----
  // One already-filed request (shows the full loop) + three live messages:
  // a clean Tier 1 parse, a Tier 2 parse, and one that can't parse -> needs_info.
  const bot = (text, at) => insSlack.run('devin', 1, text, iso(at), 'posted', null, null);
  const human = (author, text, at, status = 'unprocessed') =>
    Number(insSlack.run(author, 0, text, iso(at), status, null, null).lastInsertRowid);

  bot(`Welcome to #mktg-spend-requests. Post spend requests in plain English — include amount, ` +
      `vendor, bucket, a goal, and a success metric with a target. I'll show you the exact request ` +
      `before filing it, and flag anything I can't parse for a human.`, t - 3 * DAY);

  // Filed history: Dana's request -> preview -> confirmation -> receipt.
  const filedReqId = approved(0, { requester: 'Dana Reyes', vendor: 'Searchly', amount: 8_000, tier: 1,
    ...g('Capture competitor search demand', 'Signups', 600),
    description: 'spend request: $8k to Searchly for US paid ads — goal: capture competitor search demand, metric: signups → 600, one-time, cancellable: yes',
    approvers: auto(t - 2 * DAY), createdAt: t - 2 * DAY, decidedAt: t - 2 * DAY, actual: 0 });
  db.prepare("UPDATE requests SET source = 'slack' WHERE id = ?").run(filedReqId);
  const filedReceipt = db.prepare('SELECT receipt_id FROM ledger WHERE request_id = ?').get(filedReqId).receipt_id;
  insSlack.run('Dana Reyes', 0,
    'spend request: $8k to Searchly for US paid ads — goal: capture competitor search demand, metric: signups → 600, one-time, cancellable: yes',
    iso(t - 2 * DAY), 'filed', null, filedReqId);
  bot(`@Dana Reyes Here's the exact request I'd file:\n• Vendor: Searchly\n• Amount: $8,000\n` +
      `• Bucket: Self-serve · US · Paid ads\n• Goal: capture competitor search demand\n• Metric: signups → 600\n` +
      `• Contract: One-time · cancellable\n\nIt would auto-approve and commit immediately.`,
      t - 2 * DAY + 60e3);
  bot(`@Dana Reyes Filed — request #${filedReqId} auto-approved. Committed $8,000 to Self-serve · US · Paid ads. ` +
      `Receipt ${filedReceipt} (read-back verified ✓).`, t - 2 * DAY + 120e3);

  // Live messages for the demo.
  human('Elena Petrova',
    'spend request: $22k to Nordic Content Co for the EU agency retainer — goal: three extra campaign concepts before November, metric: aided recall → 4, contract: up to one quarter, cancellable: yes',
    t - 4 * HOUR);
  human('Chloe Dubois',
    'spend request: $95k to Stadium Media for US brand sponsorships around the championship — goal: awareness lift during finals season, metric: aided recall → 6, contract: up to one quarter, cancellable: no',
    t - 6 * HOUR);
  human('Aiko Tanaka',
    'can I get like $30k for the tokyo agency thing?',
    t - 8 * HOUR);

  return { buckets: db.prepare('SELECT COUNT(*) c FROM buckets').get().c,
           requests: db.prepare('SELECT COUNT(*) c FROM requests').get().c,
           ledger: db.prepare('SELECT COUNT(*) c FROM ledger').get().c };
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const db = openDb();
  const counts = reseed(db);
  console.log(`Seeded ${counts.buckets} buckets, ${counts.requests} requests, ${counts.ledger} ledger entries.`);
}
