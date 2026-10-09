let state = null;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '$' + Math.round(n).toLocaleString('en-US');
const dt = iso => iso ? new Date(iso).toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) : '—';
const dOnly = iso => iso ? new Date(iso).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}) : '—';

const TIER = {
  1: '<span class="chip t1">Tier 1 · auto</span>',
  2: '<span class="chip t2">Tier 2 · lead</span>',
  3: '<span class="chip t3">Tier 3 · head + finance</span>',
};

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? {'content-type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error('request failed'), data);
  return data;
}

async function refresh() {
  state = await api('/api/state');
  render();
}

// ---------- header ----------
function renderClock() {
  $('#clock-now').textContent = new Date(state.now).toLocaleString(undefined,
    {weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
}

// ---------- submit tab ----------
function renderForm() {
  const sel = $('#bucket-select');
  sel.innerHTML = state.buckets.map(b =>
    `<option value="${b.id}">${esc(b.name)} — ${money(b.remaining)} remaining of ${money(b.budget)}</option>`
  ).join('');
  $('#contract-select').innerHTML = Object.entries(state.config.contractLabels)
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const c = state.config;
  $('#rules-body').innerHTML = `
    <table class="kv">
      <tr><td>${TIER[1]}</td><td>Under ${money(c.TIER1_MAX)} and within the bucket's remaining budget. Approved instantly and logged to the ledger.</td></tr>
      <tr><td>${TIER[2]}</td><td>${money(c.TIER1_MAX)} – ${money(c.TIER2_MAX)}. Needs one approver — the bucket's motion or regional lead. Untouched for ${c.ESCALATION_HOURS}h, it escalates to the head of marketing.</td></tr>
      <tr><td>${TIER[3]}</td><td>Over ${money(c.TIER2_MAX)}, over the bucket's remaining budget, or a contract longer than one quarter. Head of marketing first, then finance.</td></tr>
    </table>
    <p class="hint">Splitting check: requests in the same bucket within ${c.SPLIT_WINDOW_DAYS} days from the same requester or vendor are combined — if the total crosses a tier line, the higher tier applies and the request is flagged.</p>
    <p class="hint">Requests missing a goal or success metric are rejected outright.</p>`;
}

function renderFormResult(out) {
  const el = $('#form-result');
  if (out.errors) {
    el.innerHTML = `<div class="notice err"><strong>Rejected:</strong><ul>${out.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    return;
  }
  const r = out.request;
  let html = `<div class="notice ok"><strong>Request #${r.id} submitted — ${TIER[r.tier]}</strong>`;
  if (r.status === 'approved' && out.ledger) {
    html += `<p>Auto-approved and committed. Receipt <code>${out.ledger.entry.receipt_id}</code> — read-back ${out.ledger.verified ? 'verified ✓' : 'MISMATCH: ' + esc(out.ledger.mismatches.join('; '))}</p>`;
  } else {
    html += `<p>Queued for approval by ${esc(r.next_approver)}.</p>`;
  }
  if (r.tier_reasons?.length) html += `<ul>${r.tier_reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (r.split_flag) html += `<p class="flag">⚑ ${esc(r.split_flag)}</p>`;
  el.innerHTML = html + '</div>';
}

// ---------- queue tab ----------
function requestCard(r, actions) {
  const reasons = r.tier_reasons.map(x => `<li>${esc(x)}</li>`).join('');
  return `<div class="card req ${r.escalated ? 'esc' : ''}">
    <div class="req-head">
      <div><strong>${esc(r.vendor)}</strong> · ${money(r.amount)} ${TIER[r.tier]}
        ${r.source === 'slack' ? '<span class="chip slack-chip">via Slack</span>' : ''}
        ${r.escalated ? '<span class="chip esc-chip">ESCALATED</span>' : ''}</div>
      <div class="sub">${esc(r.requester)} → ${esc(r.bucket_name)} · ${r.age_hours}h old · ${dt(r.created_at)}</div>
    </div>
    <div class="req-body">
      <div>${esc(r.description)}</div>
      <div class="sub">Goal: ${esc(r.goal)} · Metric: ${esc(r.success_metric)} → ${Number(r.success_target).toLocaleString()} · ${esc(state.config.contractLabels[r.contract_length])}${r.cancellable ? ' · cancellable' : ''}</div>
      ${reasons ? `<ul class="reasons">${reasons}</ul>` : ''}
      ${r.split_flag ? `<div class="flag">⚑ ${esc(r.split_flag)}</div>` : ''}
    </div>
    ${actions ? `<div class="req-actions">
      <div class="sub">Next approver: <strong>${esc(r.next_approver)}</strong></div>
      <div>
        <button class="ok-btn" data-approve="${r.id}">Approve</button>
        <button class="danger" data-reject="${r.id}">Reject</button>
      </div>
    </div>` : `<div class="req-actions"><div class="sub">${r.status === 'approved' ? 'Approved' : 'Rejected'} ${dt(r.decided_at)}</div></div>`}
  </div>`;
}

function renderQueue() {
  const d = state.digest;
  $('#queue-badge').textContent = d.pending.length ? `${d.pending.length}` : '';
  const list = $('#queue-list');
  if (!d.pending.length) {
    list.innerHTML = '<div class="card"><p class="sub">Nothing waiting for approval. Submit a request over the Tier 1 threshold to see it here.</p></div>';
    return;
  }
  const sorted = [...d.pending].sort((a, b) => (b.escalated - a.escalated) || (Date.parse(b.created_at) - Date.parse(a.created_at)));
  list.innerHTML = sorted.map(r => requestCard(r, true)).join('');
}

// ---------- slack tab ----------
function slackMsg(m) {
  const time = dt(m.ts);
  if (m.is_bot) {
    return `<div class="smsg bot">
      <div class="avatar bot-av">d</div>
      <div class="sbody"><div class="smeta"><strong>${esc(m.author)}</strong> <span class="chip bot-chip">BOT</span> <span class="sub">${time}</span></div>
      <div class="stext">${esc(m.text)}</div></div></div>`;
  }
  const initial = m.author.split(' ').map(w => w[0]).join('').slice(0, 2);
  let status = '';
  if (m.status === 'unprocessed')
    status = `<div class="sactions"><button class="primary" data-slack-process="${m.id}">Process</button></div>`;
  else if (m.status === 'awaiting_confirmation') {
    const p = m.parsed || {};
    status = `<div class="sactions parsed-box">
      <div class="sub">Parsed — awaiting confirmation:</div>
      <div class="pgrid">
        ${p.vendor ? `<span>Vendor</span><b>${esc(p.vendor)}</b>` : ''}
        ${p.amount ? `<span>Amount</span><b>${money(p.amount)}</b>` : ''}
        ${p.bucketId ? `<span>Bucket</span><b>${esc((state.buckets.find(b => b.id === p.bucketId) || {}).name || p.bucketId)}</b>` : ''}
        ${p.goal ? `<span>Goal</span><b>${esc(p.goal)}</b>` : ''}
        ${p.successMetric ? `<span>Metric</span><b>${esc(p.successMetric)} → ${Number(p.successTarget).toLocaleString()}</b>` : ''}
        ${p.contractLength ? `<span>Contract</span><b>${esc(state.config.contractLabels[p.contractLength])}${p.cancellable ? ' · cancellable' : ''}</b>` : ''}
      </div>
      <button class="ok-btn" data-slack-confirm="${m.id}">Confirm &amp; file request</button></div>`;
  } else if (m.status === 'needs_info')
    status = `<div class="sactions"><span class="chip behind">needs info — flagged for a human</span></div>`;
  else if (m.status === 'filed')
    status = `<div class="sactions"><span class="chip ok-chip">filed${m.request_id ? ` as request #${m.request_id}` : ''}</span></div>`;
  return `<div class="smsg">
    <div class="avatar">${esc(initial)}</div>
    <div class="sbody"><div class="smeta"><strong>${esc(m.author)}</strong> <span class="sub">${time}</span></div>
    <div class="stext">${esc(m.text)}</div>${status}</div></div>`;
}

function renderSlack() {
  const msgs = state.slackMessages || [];
  $('#slack-badge').textContent = msgs.filter(m => m.status === 'unprocessed').length || '';
  $('#slack-feed').innerHTML = msgs.map(slackMsg).join('');
}

// ---------- ledger tab ----------
function renderLedger() {
  const rows = state.ledger.map(e => `
    <tr>
      <td><code>${esc(e.receipt_id)}</code></td>
      <td>${esc(e.bucket_name)}</td>
      <td><strong>${esc(e.vendor)}</strong><div class="sub">${esc(e.request_description)}</div></td>
      <td class="num">${money(e.committed)}</td>
      <td class="num actual-cell">
        <input type="number" min="0" step="any" value="${e.actual}" data-actual-input="${e.id}">
        <button data-save-actual="${e.id}">Save</button>
        ${e.actual > e.committed ? '<div class="flag">over committed</div>' : ''}
      </td>
      <td>${esc(e.approver)}</td>
      <td>${dOnly(e.date)}</td>
      <td>${e.verified ? '<span class="chip ok-chip">verified ✓</span>' : `<span class="chip esc-chip" title="${esc(e.mismatch)}">mismatch</span>`}</td>
    </tr>`).join('');
  $('#ledger-wrap').innerHTML = `<div class="card">
    <h2>Ledger — committed spend</h2>
    <p class="sub">Every approved request lands here. After each write the entry is read back and verified against the request; a mismatch would show as flagged.</p>
    <table><thead><tr><th>Receipt</th><th>Bucket</th><th>Request</th><th>Committed</th><th>Actual</th><th>Approver</th><th>Spend date</th><th>Read-back</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="sub">No entries yet.</td></tr>'}</tbody></table></div>`;
}

// ---------- digest tab ----------
const FLAG = {
  ahead: '<span class="chip ahead">ahead of pace</span>',
  behind: '<span class="chip behind">behind pace</span>',
  on_pace: '<span class="chip ok-chip">on pace</span>',
  reserve: '<span class="chip">reserve</span>',
};

function renderDigest() {
  const d = state.digest;
  const pct = x => `${Math.round(x * 100)}%`;
  const bucketRows = d.buckets.map(b => `
    <tr>
      <td><strong>${esc(b.name)}</strong><div class="sub">${esc(b.owner)} · ${esc(b.metric)}</div></td>
      <td class="num">${money(b.budget)}</td>
      <td class="num">${money(b.committed)}</td>
      <td class="num">${money(b.actual)}</td>
      <td class="num">${money(b.remaining)}</td>
      <td class="num">${b.is_reserve ? '—' : pct(b.pace)} <div class="sub">of expected ${money(b.expected)}</div></td>
      <td>${FLAG[b.flag]}</td>
    </tr>`).join('');

  const mini = (title, items, empty, render) => `
    <div class="card"><h3>${title} <span class="badge">${items.length || ''}</span></h3>
      ${items.length ? `<ul class="mini">${items.map(render).join('')}</ul>` : `<p class="sub">${empty}</p>`}</div>`;

  $('#digest-wrap').innerHTML = `
    <div class="strip">
      <div class="stat"><div class="num-lg">${d.headDecisions}</div><div class="sub">decisions this week needing ${esc(d.headName)}</div></div>
      <div class="stat"><div class="num-lg">${money(d.totals.committed)}</div><div class="sub">committed of ${money(d.totals.budget)}</div></div>
      <div class="stat"><div class="num-lg">${money(d.totals.actual)}</div><div class="sub">actual spend</div></div>
      <div class="stat"><div class="num-lg">${pct(d.quarterElapsed)}</div><div class="sub">of quarter elapsed</div></div>
    </div>
    <div class="card"><h2>Budget vs. pace</h2>
      <p class="sub">Pace = actual spend vs. even-spend expectation for this point in Q4. Buckets more than ${Math.round(state.config.PACE_TOLERANCE * 100)}% off are flagged.</p>
      <table><thead><tr><th>Bucket</th><th>Budget</th><th>Committed</th><th>Actual</th><th>Remaining</th><th>Pace</th><th></th></tr></thead>
      <tbody>${bucketRows}
      <tr class="totals"><td><strong>Total</strong></td><td class="num">${money(d.totals.budget)}</td><td class="num">${money(d.totals.committed)}</td><td class="num">${money(d.totals.actual)}</td><td class="num">${money(d.totals.remaining)}</td><td></td><td></td></tr>
      </tbody></table></div>
    <div class="cols">
      ${mini('Pending approvals', d.pending, 'Nothing pending.', r =>
        `<li><strong>${esc(r.vendor)}</strong> ${money(r.amount)} · ${esc(r.bucket_name)} · waiting on ${esc(r.next_approver)}</li>`)}
      ${mini('Escalations', d.escalations, 'No escalations.', r =>
        `<li><strong>${esc(r.vendor)}</strong> ${money(r.amount)} · pending ${r.age_hours}h · escalated to ${esc(d.headName)}</li>`)}
      ${mini('Splitting flags', d.splitFlags, 'No splitting flags.', r =>
        `<li><strong>${esc(r.vendor)}</strong> ${money(r.amount)} (${r.status})<div class="sub">${esc(r.split_flag)}</div></li>`)}
      ${mini(`Commitments over ${money(state.config.BIG_COMMITMENT_MIN)} in the next ${state.config.UPCOMING_WINDOW_DAYS} days`, d.upcoming, 'None scheduled.', e =>
        `<li><strong>${esc(e.vendor)}</strong> ${money(e.committed)} · ${esc(e.bucket_name)} · ${dOnly(e.date)}</li>`)}
    </div>`;
}

// ---------- wire-up ----------
function render() {
  renderClock();
  renderForm();
  renderQueue();
  renderSlack();
  renderLedger();
  renderDigest();
}

document.addEventListener('click', async e => {
  const t = e.target;
  try {
    if (t.dataset.tab) {
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === t));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    } else if (t.dataset.addms) {
      await api('/api/clock', 'POST', {addMs: Number(t.dataset.addms)});
      await refresh();
    } else if (t.id === 'clock-reset') {
      await api('/api/clock', 'POST', {reset: true});
      await refresh();
    } else if (t.id === 'reseed') {
      if (confirm('Wipe all data and reseed?')) { await api('/api/reset', 'POST'); await refresh(); }
    } else if (t.dataset.approve) {
      const out = await api(`/api/requests/${t.dataset.approve}/approve`, 'POST');
      if (out.ledger && !out.ledger.verified) alert('Ledger mismatch: ' + out.ledger.mismatches.join('; '));
      await refresh();
    } else if (t.dataset.reject) {
      if (confirm('Reject this request?')) { await api(`/api/requests/${t.dataset.reject}/reject`, 'POST'); await refresh(); }
    } else if (t.dataset.slackProcess) {
      await api(`/api/slack/${t.dataset.slackProcess}/process`, 'POST');
      await refresh();
    } else if (t.dataset.slackConfirm) {
      const out = await api(`/api/slack/${t.dataset.slackConfirm}/confirm`, 'POST');
      if (out.ledger && !out.ledger.verified) alert('Ledger mismatch: ' + out.ledger.mismatches.join('; '));
      await refresh();
    } else if (t.dataset.saveActual) {
      const input = document.querySelector(`[data-actual-input="${t.dataset.saveActual}"]`);
      const out = await api(`/api/ledger/${t.dataset.saveActual}/actual`, 'POST', {actual: Number(input.value)});
      if (out.error) alert(out.error);
      await refresh();
    }
  } catch (err) {
    alert(err.errors ? err.errors.join('\n') : (err.error || err.message));
  }
});

$('#req-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const out = await api('/api/requests', 'POST', {
      requester: f.get('requester'), bucketId: Number(f.get('bucketId')),
      vendor: f.get('vendor'), amount: Number(f.get('amount')),
      description: f.get('description'), goal: f.get('goal'),
      successMetric: f.get('successMetric'), successTarget: Number(f.get('successTarget')),
      contractLength: f.get('contractLength'), cancellable: f.get('cancellable') === 'on',
      spendDate: f.get('spendDate') || null,
    });
    renderFormResult(out);
    e.target.reset();
    await refresh();
  } catch (err) {
    renderFormResult(err.errors ? err : {errors: [err.error || err.message]});
  }
});

refresh();
