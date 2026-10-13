/* chotu dashboard — dependency-free plain JS.
 * Served as static by the API (app.use(express.static('dashboard'))).
 * Talks only to same-origin /api/* with anon-safe reads (RLS enforced server-side).
 * Basic-auth is at the Caddy layer; no in-app auth, no service_role here.
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const LS_WS = 'chotu.workspace';
const LS_TAB = 'chotu.tab';

const state = {
  workspaceId: localStorage.getItem(LS_WS) || '',
  tab: localStorage.getItem(LS_TAB) || 'queue',
  opportunities: [],
  draftsByOpp: new Map(),
  metrics: null,
  jobs: [],
};

/* ---------- tiny fetch with retry-with-backoff (no retry on 4xx) ---------- */
async function fetchJSON(path, opts = {}, tries = 3) {
  let delay = 400;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...opts,
      });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${path} ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
      if (res.status === 204) return null;
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e && (e.status >= 400 && e.status < 500 && e.status !== 429)) throw e;
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw lastErr;
}

function notice(msg) {
  const el = $('#notice');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function qsWorkspace(path) {
  const w = state.workspaceId;
  if (!w) return path;
  return path + (path.includes('?') ? '&' : '?') + 'workspace_id=' + encodeURIComponent(w);
}

/* ---------- tabs ---------- */
function showTab(name) {
  state.tab = name;
  localStorage.setItem(LS_TAB, name);
  $$('.tabs [role=tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ['queue', 'scorecard', 'ops'].forEach((t) => {
    $('#tab-' + t).hidden = t !== name;
  });
  if (name === 'queue') loadQueue();
  if (name === 'scorecard') loadScorecard();
  if (name === 'ops') loadOps();
}

/* ---------- workspace picker ---------- */
const FALLBACK_WORKSPACES = [
  { id: 'authormity.space', name: 'authormity.space' },
  { id: 'shipsprint.site', name: 'shipsprint.site' },
];

function normalizeWorkspaces(payload) {
  // Accept: [{id,name}], {workspaces:[...]}, [{slug}], or {data:[...]}
  const arr = Array.isArray(payload) ? payload
    : Array.isArray(payload?.workspaces) ? payload.workspaces
    : Array.isArray(payload?.data) ? payload.data : null;
  if (!arr) return null;
  return arr.map((w) => ({
    id: String(w.id ?? w.workspace_id ?? w.slug ?? w.name ?? ''),
    name: String(w.name ?? w.site_url ?? w.slug ?? w.id ?? ''),
  })).filter((w) => w.id);
}

async function loadWorkspaces() {
  const sel = $('#workspace');
  let list = null;
  for (const p of ['/api/workspaces', '/api/metrics']) {
    try {
      const j = await fetchJSON(p);
      // /api/metrics may echo workspaces; otherwise null
      list = normalizeWorkspaces(j);
      if (list && list.length) break;
    } catch { /* try next */ }
  }
  if (!list || !list.length) list = FALLBACK_WORKSPACES;
  sel.innerHTML = '';
  // keep stored value even if unknown (manual id entry still works)
  if (state.workspaceId && !list.some((w) => w.id === state.workspaceId)) {
    list = [{ id: state.workspaceId, name: state.workspaceId }, ...list];
  }
  for (const w of list) {
    const o = document.createElement('option');
    o.value = w.id;
    o.textContent = w.name;
    sel.appendChild(o);
  }
  if (!state.workspaceId) state.workspaceId = list[0].id;
  sel.value = state.workspaceId;
  localStorage.setItem(LS_WS, state.workspaceId);
}

/* ---------- health + doctor ---------- */
async function checkHealth() {
  const dot = $('#health-dot');
  try {
    await fetchJSON('/health');
    dot.className = 'dot ok';
    dot.title = 'API ok';
  } catch {
    dot.className = 'dot bad';
    dot.title = 'API unreachable';
  }
}

async function loadDoctor() {
  const ul = $('#doctor-list');
  let doc = null;
  try { doc = await fetchJSON(qsWorkspace('/api/doctor')); }
  catch {
    try {
      const h = await fetchJSON('/health');
      doc = { api: 'ok', detail: h };
    } catch { doc = null; }
  }
  if (!doc) { ul.innerHTML = '<li class="muted">doctor unavailable (API down?)</li>'; return; }
  const rows = Array.isArray(doc) ? doc : Object.entries(doc).map(([k, v]) => [k, v]);
  ul.innerHTML = rows.map(([k, v]) => {
    const s = typeof v === 'object' ? esc(JSON.stringify(v)) : esc(String(v));
    return `<li><span class="k">${esc(String(k))}</span><span class="v">${s}</span></li>`;
  }).join('') || '<li class="muted">empty doctor response</li>';
}

/* ---------- QUEUE ---------- */
function groupDrafts(drafts) {
  const m = new Map();
  for (const d of drafts ?? []) {
    if (!d || typeof d !== 'object') continue;
    const key = d.opportunity_id ?? d.opportunityId ?? '__unassigned__';
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(d);
  }
  // sort variants: platform alpha, then id
  for (const v of m.values()) v.sort((a, b) => String(a.platform).localeCompare(String(b.platform)));
  return m;
}

function utmPreview(platform) {
  const ws = (String(state.workspaceId || 'workspace').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'workspace');
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const p = `utm_source=${encodeURIComponent(platform || 'social')}&utm_medium=social&utm_campaign=${encodeURIComponent(ws + '_' + d)}`;
  return '?' + p;
}

function slopClass(score) {
  if (score == null) return 'slop na';
  if (score < 0.3) return 'slop good';
  if (score < 0.6) return 'slop warn';
  return 'slop bad';
}

async function loadQueue() {
  const box = $('#queue-list');
  if (!state.workspaceId) { box.innerHTML = '<p class="muted">pick a workspace first</p>'; return; }
  box.innerHTML = '<p class="muted">loading queue…</p>';
  notice('');
  try {
    const [opps, drafts] = await Promise.all([
      fetchJSON(qsWorkspace('/api/opportunities')),
      fetchJSON(qsWorkspace('/api/drafts')).catch(() => []),
    ]);
    const oppList = Array.isArray(opps) ? opps : (opps?.opportunities ?? opps?.data ?? []);
    const draftList = Array.isArray(drafts) ? drafts : (drafts?.drafts ?? drafts?.data ?? []);
    state.opportunities = oppList;
    state.draftsByOpp = groupDrafts(draftList);
    // stash unassigned drafts under a pseudo-card
    renderQueue(box, oppList, state.draftsByOpp);
  } catch (e) {
    box.innerHTML = `<p class="err">queue failed: ${esc(e.message)}</p>`;
  }
}

function renderQueue(box, opps, draftsByOpp) {
  box.innerHTML = '';
  if (!opps.length && ![...draftsByOpp.keys()].length) {
    box.innerHTML = '<p class="muted">nothing queued — run discover first</p>';
    return;
  }
  for (const o of opps) {
    box.appendChild(opportunityCard(o, draftsByOpp.get(o.id) || []));
  }
  const orphans = draftsByOpp.get('__unassigned__') || [];
  if (orphans.length) {
    const pseudo = { id: '__unassigned__', title: 'Unassigned drafts', source: '—', source_url: '', body_excerpt: '', mercury_score: null, status: '' };
    box.appendChild(opportunityCard(pseudo, orphans));
  }
}

function opportunityCard(opp, variants) {
  const card = document.createElement('article');
  card.className = 'card';
  const plats = [...new Set(variants.map((v) => v.platform || 'general'))];
  const active = plats[0] || 'general';
  card.innerHTML = `
    <div class="card-head">
      <h3>${esc(opp.title || '(untitled)')}</h3>
      <span class="pill">${esc(opp.status || 'queued')}</span>
    </div>
    <div class="meta muted small">
      <span>${esc(opp.source || '')}</span>
      ${opp.source_url ? `<a href="${esc(opp.source_url)}" target="_blank" rel="noopener">source</a>` : ''}
      ${opp.mercury_score != null ? `<span>mercury ${esc(Number(opp.mercury_score).toFixed(2))}</span>` : ''}
    </div>
    ${opp.body_excerpt ? `<p class="excerpt">${esc(opp.body_excerpt)}</p>` : ''}
    <div class="ptabs" role="tablist"></div>
    <div class="variant"></div>
  `;
  const tabs = $('.ptabs', card);
  const body = $('.variant', card);
  const showVariant = (plat) => {
    $$('button', tabs).forEach((b) => b.classList.toggle('active', b.dataset.p === plat));
    const v = variants.find((x) => (x.platform || 'general') === plat) || variants[0];
    if (!v) { body.innerHTML = '<p class="muted small">no draft variants yet</p>'; return; }
    renderVariant(body, v);
  };
  plats.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.p = p;
    b.textContent = p;
    b.onclick = () => showVariant(p);
    tabs.appendChild(b);
  });
  showVariant(active);
  return card;
}

function renderVariant(body, v) {
  const slop = v.slop_score ?? v.slopScore;
  body.innerHTML = `
    <div class="vhead">
      <span class="${slopClass(slop)}">slop ${slop == null ? 'n/a' : Number(slop).toFixed(2)}</span>
      ${v.copied_at ? `<span class="muted small">copied ${esc(v.copied_at)}</span>` : '<span class="muted small">not copied yet</span>'}
      ${v.status ? `<span class="muted small">${esc(v.status)}</span>` : ''}
    </div>
    <pre class="content">${esc(v.content || '')}</pre>
    <p class="muted small utm">UTM preview: <code>${esc(utmPreview(v.platform))}</code> (appended by POST /api/publish)</p>
    <div class="row">
      <button type="button" class="copy">copy</button>
      <span class="copied-mark muted small" aria-live="polite"></span>
    </div>
    <form class="pub">
      <input name="live_url" type="url" required placeholder="paste live URL after you post natively…" aria-label="live URL" />
      <button type="submit">register publish</button>
      <span class="pub-ok muted small" aria-live="polite"></span>
    </form>
  `;
  $('.copy', body).onclick = async (ev) => {
    const btn = ev.currentTarget;
    const mark = $('.copied-mark', body);
    try {
      await navigator.clipboard.writeText(v.content || '');
    } catch {
      // clipboard API unavailable (permissions) — select fallback
      const ta = document.createElement('textarea');
      ta.value = v.content || '';
      body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    // Optional best-effort copied_at update; backend may 404 — never block the copy.
    try {
      await fetchJSON('/api/publish?action=copied', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: state.workspaceId, draft_id: v.id, action: 'copied' }),
      });
    } catch { /* optional */ }
    mark.textContent = 'copied ✓ (paste it natively now)';
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 1500);
  };
  $('.pub', body).onsubmit = async (ev) => {
    ev.preventDefault();
    const ok = $('.pub-ok', body);
    const input = $('input[name=live_url]', body);
    ok.textContent = 'registering…';
    try {
      const res = await fetchJSON('/api/publish', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: state.workspaceId,
          draft_id: v.id,
          platform: v.platform,
          live_url: input.value.trim(),
        }),
      });
      ok.textContent = 'registered ✓ tracking started' + (res?.utm ? ` (${res.utm})` : '');
      input.value = '';
    } catch (e) {
      ok.textContent = 'publish failed: ' + e.message;
    }
  };
}

/* ---------- SCORECARD ---------- */
function asArray(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  return [];
}

async function loadScorecard() {
  notice('');
  if (!state.workspaceId) return;
  try {
    const j = await fetchJSON(qsWorkspace('/api/metrics'));
    state.metrics = j;
    renderScorecard(j);
  } catch (e) {
    notice('scorecard failed: ' + e.message);
  }
}

function renderScorecard(j) {
  const site = asArray(j, ['site_metrics', 'metrics', 'traffic', 'data']);
  const lift = asArray(j?.attribution ?? j, ['attribution', 'attribution_scores', 'lift']);
  const matrix = asArray(j?.matrix ?? j, ['matrix', 'channel_matrix']);
  renderTrend(site);
  renderReferrals(site);
  renderLift(lift);
  renderMatrix(matrix, lift);
}

function renderTrend(site) {
  const svg = $('#traffic-chart');
  const legend = $('#traffic-legend');
  const pts = site
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ t: Date.parse(r.pulled_at ?? r.date ?? r.day ?? ''), c: Number(r.clicks ?? 0) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)
    .slice(-30);
  svg.innerHTML = '';
  if (!pts.length) { legend.textContent = 'no site_metrics yet (track-site hourly)'; return; }
  const max = Math.max(...pts.map((p) => p.c), 1);
  const step = 320 / Math.max(pts.length - 1, 1);
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(86 - (p.c / max) * 80).toFixed(1)}`).join(' ');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);
  const last = pts[pts.length - 1];
  legend.textContent = `${pts.length} points · latest ${last.c} clicks · max ${max}`;
}

function renderReferrals(site) {
  const latest = site[site.length - 1] || {};
  let ref = latest.referrals || latest.referrers || {};
  if (typeof ref === 'string') { try { ref = JSON.parse(ref); } catch { ref = {}; } }
  const entries = Object.entries(ref).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10);
  const total = site.reduce((s, r) => s + Number(r?.signups ?? 0), 0);
  $('#signup-total').textContent = site.length ? `${total} signups (sum of pulled site_metrics)` : '—';
  const tb = $('#referral-table tbody');
  tb.innerHTML = entries.length
    ? entries.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')
    : '<tr><td colspan="2" class="muted">no referral data yet</td></tr>';
}

function renderLift(lift) {
  const tb = $('#lift-table tbody');
  if (!lift.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">no attribution rows yet</td></tr>'; return; }
  tb.innerHTML = lift.filter((r) => r && typeof r === 'object').map((r) => `
    <tr>
      <td>${esc(r.live_url ?? r.published_post_id ?? r.post ?? '?')}</td>
      <td class="small">${esc((r.window_start ?? '') + ' → ' + (r.window_end ?? ''))}</td>
      <td>${esc(fmtLift(r.traffic_lift))}</td>
      <td>${esc(fmtLift(r.signup_lift))}</td>
      <td><span class="pill">${esc(r.method ?? 'inferred')}</span></td>
    </tr>`).join('');
}

function fmtLift(x) {
  if (x == null || x === '') return '—';
  const n = Number(x);
  return Number.isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(2) : String(x);
}

function renderMatrix(matrix, lift) {
  const tb = $('#matrix-table tbody');
  const rows = matrix.length ? matrix.filter((r) => r && typeof r === 'object') : deriveMatrix(lift);
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">no matrix rows yet</td></tr>'; return; }
  tb.innerHTML = rows.map((r) => `
    <tr><td>${esc(r.channel ?? '?')}</td><td>${esc(r.angle ?? '—')}</td>
    <td>${esc(r.hook ?? '—')}</td><td>${esc(String(r.n ?? r.count ?? 1))}</td>
    <td>${esc(fmtLift(r.avg_lift ?? r.traffic_lift))}</td></tr>`).join('');
}

function deriveMatrix(lift) {
  // Client-side fallback: group lift rows by channel when learn/ hasn't run yet.
  const m = new Map();
  for (const r of lift) {
    if (!r || typeof r !== 'object') continue;
    const k = [r.channel ?? r.platform ?? '?', r.angle ?? '—', r.hook ?? '—'].join('‖');
    if (!m.has(k)) m.set(k, { channel: r.channel ?? r.platform ?? '?', angle: r.angle ?? '—', hook: r.hook ?? '—', n: 0, sum: 0 });
    const e = m.get(k);
    e.n++; e.sum += Number(r.traffic_lift ?? 0);
  }
  return [...m.values()].map((e) => ({ ...e, avg_lift: e.n ? e.sum / e.n : 0 }));
}

/* ---------- OPS ---------- */
async function loadOps() {
  notice('');
  await Promise.all([loadDoctor(), loadJobs()]);
}

async function loadJobs() {
  const tb = $('#jobs-table tbody');
  try {
    const j = await fetchJSON(qsWorkspace('/api/failed-jobs'));
    const list = Array.isArray(j) ? j : (j?.jobs ?? j?.failed_jobs ?? j?.data ?? []);
    state.jobs = list;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">no failed jobs</td></tr>'; return; }
    tb.innerHTML = '';
    for (const job of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="small">${esc(job.id ?? '')}</td>
        <td>${esc(job.job_type ?? job.type ?? '')}</td>
        <td class="small err">${esc(String(job.error ?? '').slice(0, 160))}</td>
        <td>${esc(String(job.attempts ?? ''))}</td>
        <td></td>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'retry';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await fetchJSON('/api/retry-job', {
            method: 'POST',
            body: JSON.stringify({ job_id: job.id, workspace_id: state.workspaceId }),
          });
          tr.remove();
          if (!$('#jobs-table tbody').children.length) tb.innerHTML = '<tr><td colspan="5" class="muted">no failed jobs</td></tr>';
        } catch (e) {
          btn.disabled = false;
          notice('retry failed: ' + e.message);
        }
      };
      tr.lastChild.appendChild(btn);
      tb.appendChild(tr);
    }
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="5" class="err">failed-jobs failed: ${esc(e.message)}</td></tr>`;
  }
}

/* ---------- boot ---------- */
function bind() {
  $$('.tabs [role=tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#workspace').onchange = (e) => {
    state.workspaceId = e.target.value;
    localStorage.setItem(LS_WS, state.workspaceId);
    showTab(state.tab);
  };
  $('#refresh').onclick = () => showTab(state.tab);
}

(async function init() {
  bind();
  await checkHealth();
  await loadWorkspaces();
  showTab(state.tab || 'queue');
})();
