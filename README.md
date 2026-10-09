# Marketing Spend Workflow — Q4 2026 Demo

A small prototype of a marketing spend approval and tracking workflow. Demo data
only — no external integrations, no auth, no real money.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`; developed on Node 26). No
npm dependencies — nothing to install.

```bash
npm start          # serves http://localhost:3000 (set PORT to change)
npm test           # runs the test suite (node --test)
npm run seed       # wipes and reseeds data/spend.db standalone
```

The database file `data/spend.db` is created and seeded automatically on first
start. Use the **Reseed data** button in the app (or `POST /api/reset`) to start
over.

## What it does

- **Submit request** — intake form. Missing goal or success metric → rejected.
- **Approval queue** — pending requests, with escalations pinned to the top.
- **Slack intake** — a mock `#mktg-spend-requests` channel showing how requests
  could arrive from Slack. **There is no real Slack connection** — messages are
  seeded rows — but everything downstream is real: the bot parses plain-English
  messages, posts back the exact request it would file, waits for a human
  confirmation, then files it through the *same* validation, tier, splitting,
  and ledger pipeline as the web form. Requests it can't fully parse are
  flagged for a human rather than guessed. Approval decisions on
  Slack-sourced requests are narrated back into the channel.
- **Ledger** — committed spend; every entry is read back and verified after
  writing. Record actual spend inline.
- **Weekly digest** — budget vs. pace per bucket, pending approvals,
  escalations, splitting flags, big upcoming commitments, and how many
  decisions this week needed the head of marketing.
- **Demo clock** (header) — advance time to watch Tier 2 requests escalate
  and pace metrics shift. The offset is persisted in the DB.

## The rules, in plain English

All thresholds live in `src/config.js`.

**Budget buckets.** Each bucket is a motion × region × channel combination
(e.g. "Self-serve · US · Paid ads") with an owner, a quarterly budget, a Tier-2
approver (the motion or regional lead), and the metric it's judged on. A
reserve bucket holds 12% of the total budget and belongs to the head of
marketing. "Remaining budget" = budget − committed (ledger) spend. Pending
requests do not count against it.

**Tiers.**

| Tier | Trigger | What happens |
|------|---------|--------------|
| 1 | Under $25K **and** within the bucket's remaining budget | Auto-approved, logged to the ledger |
| 2 | $25K – $250K | One approver: the bucket's lead. Untouched for 24h → escalates to the head of marketing |
| 3 | Over $250K, **or** over the bucket's remaining budget, **or** a contract longer than one quarter | Sequential approval: head of marketing, then finance |

Boundaries: $24,999 → Tier 1, $25,000 → Tier 2, $250,000 → Tier 2,
$250,001 → Tier 3.

**Splitting check.** When a request comes in, the app sums other requests in
the same bucket from the last 30 days that share the same requester **or** the
same vendor (case-insensitive; pending + approved count, rejected don't). If
the combined total would cross a tier threshold, the request is routed at the
higher tier and carries a flag explaining why.

**Escalation.** A Tier 2 request still pending after 24 hours shows as
ESCALATED; the next approver becomes the head of marketing. This is computed
from timestamps, so the demo clock drives it.

**Ledger + verification.** On final approval, a ledger entry is written
(receipt ID `RCP-2026-NNNN`), then immediately read back and compared to the
source request — committed amount, bucket, approver, receipt, date. Any
mismatch is stored on the entry and shown in the ledger. Actual spend can be
recorded against any entry; actuals above the committed amount are flagged.

**Slack intake (mock).** `src/slack.js` follows the loop a real Slack
integration would use:

1. Parse the message into fields (amount, vendor, bucket by keyword match,
   goal, metric + target, contract length, cancellable).
2. Post back the *exact* request it would file — including which tier it
   routes to and any splitting flag.
3. Wait for a human to confirm in the app ("nothing gets submitted on the
   first read").
4. File through `submitRequest()` — identical rules to the web form.
5. Report the outcome in-channel: receipt ID and read-back verification for
   auto-approvals, or the approver it's waiting on.

If required fields can't be parsed, the message goes to `needs_info` — the
bot posts what's missing instead of inventing it. In a real deployment the
mock seams would be: Slack Events API / slash command as the message source,
Slack's request-signature verification, and a Slack-user → requester identity
map. The parser understands `goal:`, `metric:`, `contract:`, `cancellable:`,
`vendor:` labels plus `$45k`/`$1.2m` amounts — deliberately simple, not NLP.

**Pace.** Expected spend so far = bucket budget × fraction of the quarter
elapsed (assuming even spending). Actual within ±20% is "on pace"; beyond that,
the bucket is flagged ahead or behind. The reserve bucket is exempt — it isn't
meant to spend evenly. "Commitments coming in the next 30 days" are ledger
entries over $100K whose spend date falls in that window.

## Layout

```
src/config.js   all thresholds + people
src/tiers.js    pure validation + tier routing (unit-tested)
src/service.js  submit / approve / reject / ledger / related-spend query
src/slack.js    mock Slack intake: parser, preview/confirm loop, bot replies
src/digest.js   weekly digest computations
src/clock.js    demo clock (offset persisted in settings table)
src/db.js       schema + connection (node:sqlite)
src/seed.js     sample data
src/server.js   http server + JSON API + static files
public/         single-page UI (vanilla JS)
test/           node:test suites — tier boundaries, contract length,
                over-budget, splitting, end-to-end workflow, Slack parser
                and the process→confirm→file loop
```

## Seed data covers

8 real buckets + reserve ($2.4M total), ~20 requests: Tier 1/2/3 approvals, a
fresh Tier 2 in the queue, a Tier 2 submitted 26h ago (already escalated), a
Tier 3 over-budget request, a Tier 3 multi-quarter contract, a Tier 3 awaiting
finance (head already approved), a splitting-flagged request (Meridian Media in
Self-serve · US · Paid ads), a head-of-marketing rejection this week, buckets
ahead of pace (Enterprise · US · Events) and behind pace (Self-serve · APAC ·
Agencies, Enterprise · APAC · Events), and two $100K+ commitments dated inside
the next 30 days.

The mock `#mktg-spend-requests` channel seeds: a welcome message from `devin`
(the bot), one request already filed through the full loop with its receipt
replies, and three live messages — a clean Tier 1 auto-approval (Elena), a
request that trips the splitting check on the way in (Chloe — process it and
watch why), and an incomplete message that gets flagged `needs_info` (Aiko).
