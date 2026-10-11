#!/usr/bin/env node
// endpoint-watch: probes every translation endpoint Polyvox depends on, keeps
// the manifest's per-engine endpoint lists healthy-first, and reports when an
// endpoint goes down or comes back. Node 20+, no dependencies.
//
//   node tools/endpoint-watch/watch.mjs            probe and print a table
//   node tools/endpoint-watch/watch.mjs --write    also update the streak state,
//        the `endpoints` key of url-overrides.json and endpoint-health.json, and
//        write changed / transition / summary to $GITHUB_OUTPUT
//
// Classes. ok: a real translation came back (keyed hosts: the API answered).
// throttled: 429, a challenge page, a /sorry/ redirect. This runs on datacenter
// addresses that Google throttles far more than a home connection, so
// throttled never demotes anything. hard: DNS failure, 404/410, a 200 whose
// body does not parse or hands the input back untranslated. soft: 5xx,
// timeouts, resets. An endpoint is down after 3 hard runs in a row or 6 soft
// ones (3 hours at the 30 minute schedule). Only a down endpoint moves to the
// end of its pool list, and no list is ever emptied: the app keeps its
// compiled endpoints behind whatever the manifest says.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CATALOG = opt('--catalog', path.join(HERE, 'catalog.json'));
const STATE = opt('--state', path.join(ROOT, '.endpoint-watch-state.json'));
const MANIFEST = opt('--manifest', path.join(ROOT, 'url-overrides.json'));
const HEALTH = opt('--health', path.join(ROOT, 'endpoint-health.json'));

const TIMEOUT_MS = 10_000;
const HARD_DOWN = 3;
const SOFT_DOWN = 6;
const HEARTBEAT_DAYS = 7;
// The headers the app itself sends, so the watch sees what users see.
const GOOGLE_UA = 'Mozilla/5.0';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
const PROBE = catalog.probe_text || 'hello friend';

const verdict = (cls, why, ms) => ({ cls, why: String(why).slice(0, 120), ms });
const untranslated = (out) => out.trim().toLowerCase() === PROBE.toLowerCase();

async function timedFetch(url, init = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const code = e?.cause?.code || e?.name || 'error';
    // NXDOMAIN is the one transport failure that means the host is gone.
    return { error: code === 'ENOTFOUND' ? 'hard' : 'soft', detail: code, ms: Math.round(performance.now() - t0) };
  }
}

/** Google's two shapes: /single joins [0][i][0]; /t is ["tr"] or [["tr","en"]] (sl=auto). */
export function parseGoogle(pathname, body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (pathname.endsWith('/single')) {
    if (!Array.isArray(j?.[0])) return null;
    const s = j[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
    return s || null;
  }
  const first = Array.isArray(j) ? j[0] : null;
  if (typeof first === 'string') return first || null;
  if (Array.isArray(first) && typeof first[0] === 'string') return first[0] || null;
  return null;
}

async function probeGoogle(endpoint) {
  const u = new URL(endpoint);
  u.searchParams.set('sl', 'en');
  u.searchParams.set('tl', 'ja');
  if (u.pathname.endsWith('/single')) u.searchParams.set('dt', 't');
  u.searchParams.set('q', PROBE);
  const r = await timedFetch(u, { headers: { 'User-Agent': GOOGLE_UA }, redirect: 'manual' });
  if (r.error) return verdict(r.error, r.detail, r.ms);
  if (r.status === 429 || r.status === 403) return verdict('throttled', `HTTP ${r.status}`, r.ms);
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location') || '';
    return verdict(loc.includes('/sorry') ? 'throttled' : 'soft', `HTTP ${r.status} redirect`, r.ms);
  }
  if (r.status === 404 || r.status === 410) return verdict('hard', `HTTP ${r.status}`, r.ms);
  if (r.status !== 200) return verdict('soft', `HTTP ${r.status}`, r.ms);
  if (r.body.trimStart().startsWith('<')) return verdict('throttled', 'HTML instead of JSON', r.ms);
  const out = parseGoogle(u.pathname, r.body);
  if (out === null) return verdict('hard', 'unparseable body', r.ms);
  if (untranslated(out)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', 'translated', r.ms);
}

async function probeBing({ session, url }) {
  const page = await timedFetch(session, { headers: { 'User-Agent': EDGE_UA } });
  if (page.error) return verdict(page.error, `session ${page.detail}`, page.ms);
  if (page.status === 429) return verdict('throttled', 'session HTTP 429', page.ms);
  if (page.status === 404 || page.status === 410) return verdict('hard', `session HTTP ${page.status}`, page.ms);
  if (page.status !== 200) return verdict('soft', `session HTTP ${page.status}`, page.ms);
  const ig = page.body.match(/IG:"([^"]+)"/)?.[1];
  const iid = page.body.match(/data-iid="([^"]+)"/)?.[1];
  const helper = page.body.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)"/);
  if (!ig || !iid || !helper) {
    const challenged = /captcha|challenge/i.test(page.body);
    return verdict(challenged ? 'throttled' : 'hard', 'session markers missing', page.ms);
  }
  const form = new URLSearchParams({ fromLang: 'en', text: PROBE, to: 'ja', token: helper[2], key: helper[1] });
  const r = await timedFetch(`${url}?isVertical=1&&IG=${ig}&IID=${iid}.1`, {
    method: 'POST',
    headers: { 'User-Agent': EDGE_UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: session },
    body: form,
  });
  if (r.error) return verdict(r.error, r.detail, r.ms);
  if (r.status === 429) return verdict('throttled', 'HTTP 429', r.ms);
  if (r.status === 404 || r.status === 410) return verdict('hard', `HTTP ${r.status}`, r.ms);
  if (r.status !== 200) return verdict('soft', `HTTP ${r.status}`, r.ms);
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    return verdict('hard', 'unparseable body', r.ms);
  }
  // Session expiry and bad requests arrive as HTTP 200 carrying a statusCode.
  if (!Array.isArray(j)) {
    const code = j?.statusCode;
    return verdict(code === 429 ? 'throttled' : 'hard', `statusCode ${code}`, r.ms);
  }
  const out = j[0]?.translations?.[0]?.text;
  if (typeof out !== 'string' || !out) return verdict('hard', 'no translation in body', r.ms);
  if (untranslated(out)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', j[0]?.usedLLM ? 'translated (LLM)' : 'translated', r.ms);
}

async function probeMyMemory({ url }) {
  const u = new URL(url);
  u.searchParams.set('q', PROBE);
  u.searchParams.set('langpair', 'en|ja');
  const r = await timedFetch(u);
  if (r.error) return verdict(r.error, r.detail, r.ms);
  if (r.status === 429) return verdict('throttled', 'HTTP 429', r.ms);
  if (r.status === 404 || r.status === 410) return verdict('hard', `HTTP ${r.status}`, r.ms);
  if (r.status !== 200) return verdict('soft', `HTTP ${r.status}`, r.ms);
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    return verdict('hard', 'unparseable body', r.ms);
  }
  if (j?.quotaFinished || Number(j?.responseStatus) === 429) return verdict('throttled', 'quota', r.ms);
  const out = j?.responseData?.translatedText;
  if (Number(j?.responseStatus) !== 200 || typeof out !== 'string') {
    return verdict('hard', `responseStatus ${j?.responseStatus}`, r.ms);
  }
  if (untranslated(out)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', 'translated', r.ms);
}

async function probeTransmart({ url }) {
  const body = {
    header: {
      fn: 'auto_translation',
      client_key: `browser-chrome-141.0.0-Windows_10-${randomBytes(16).toString('hex')}-${Date.now()}`,
    },
    type: 'plain',
    model_category: 'normal',
    text_domain: 'general',
    source: { lang: 'en', text_list: [PROBE] },
    target: { lang: 'ja' },
  };
  const r = await timedFetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/json',
      Origin: 'https://transmart.qq.com',
      Referer: 'https://transmart.qq.com/',
    },
    body: JSON.stringify(body),
  });
  if (r.error) return verdict(r.error, r.detail, r.ms);
  if (r.status === 429) return verdict('throttled', 'HTTP 429', r.ms);
  if (r.status === 404 || r.status === 410) return verdict('hard', `HTTP ${r.status}`, r.ms);
  if (r.status !== 200) return verdict('soft', `HTTP ${r.status}`, r.ms);
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    return verdict('hard', 'unparseable body', r.ms);
  }
  const out = j?.auto_translation?.[0];
  if (j?.header?.ret_code !== 'succ' || typeof out !== 'string') {
    return verdict('hard', `ret_code ${j?.header?.ret_code}`, r.ms);
  }
  if (untranslated(out)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', 'translated', r.ms);
}

async function probeKeyed({ method, url, alive404 }) {
  const post = method === 'POST';
  const r = await timedFetch(url, {
    method,
    headers: { 'User-Agent': BROWSER_UA, ...(post ? { 'Content-Type': 'application/json' } : {}) },
    body: post ? '{}' : undefined,
  });
  if (r.error) return verdict(r.error, r.detail, r.ms);
  if ((r.status === 404 && !alive404) || r.status === 410) return verdict('hard', `HTTP ${r.status}`, r.ms);
  if (r.status >= 500) return verdict('soft', `HTTP ${r.status}`, r.ms);
  if (r.status === 429) return verdict('throttled', 'HTTP 429', r.ms);
  return verdict('ok', `alive (HTTP ${r.status})`, r.ms);
}

const SINGLE = { bing: probeBing, mymemory: probeMyMemory, transmart: probeTransmart };

/** Every probe as [id, engine, label, promise]. ids are stable state keys. */
function plan() {
  const jobs = [];
  for (const [key, urls] of Object.entries(catalog.pool || {})) {
    for (const url of urls) jobs.push([`${key} ${url}`, key, url, () => probeGoogle(url)]);
  }
  for (const [key, spec] of Object.entries(catalog.single || {})) {
    jobs.push([key, key, spec.url, () => SINGLE[spec.probe](spec)]);
  }
  for (const [key, spec] of Object.entries(catalog.keyed || {})) {
    jobs.push([`keyed:${key}`, key, spec.url, () => probeKeyed(spec)]);
  }
  return jobs;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** One line safe to put in a commit message, a log annotation or a webhook. */
const clean = (s) => s.replace(/[^A-Za-z0-9 _.:/,()=+?&-]/g, '').slice(0, 300);

async function main() {
  const jobs = plan();
  const results = await Promise.all(jobs.map(async ([id, engine, label, run]) => [id, engine, label, await run()]));

  const rows = results.map(([, engine, label, r]) => `| ${engine} | ${label} | ${r.cls} | ${r.ms} | ${r.why.replace(/\|/g, '/')} |`);
  const table = ['| engine | endpoint | result | ms | detail |', '|---|---|---|---|---|', ...rows].join('\n');
  console.log(table);
  if (!WRITE) return;

  const now = new Date().toISOString();
  const state = await readJson(STATE, { endpoints: {} });
  state.endpoints ||= {};
  const wentDown = [];
  const recovered = [];
  for (const [id, , , r] of results) {
    const s = (state.endpoints[id] ||= { hard: 0, soft: 0, down: false });
    if (r.cls === 'ok') {
      s.hard = 0;
      s.soft = 0;
      s.last_ok = now;
    } else if (r.cls === 'hard') {
      s.hard += 1;
    } else if (r.cls === 'soft') {
      s.soft += 1;
    }
    const down = s.hard >= HARD_DOWN || s.soft >= SOFT_DOWN;
    if (down !== s.down) (down ? wentDown : recovered).push(id);
    s.down = down;
    Object.assign(s, { cls: r.cls, why: r.why, ms: r.ms, at: now });
  }
  // Ids no longer in the catalog are forgotten, so a removed endpoint cannot
  // hold a stale down flag forever.
  const live = new Set(results.map(([id]) => id));
  for (const id of Object.keys(state.endpoints)) if (!live.has(id)) delete state.endpoints[id];

  // Pool order: endpoints that are not down keep their catalog order, the down
  // ones follow. Never empty, never anything outside the catalog.
  const endpoints = {};
  for (const [key, urls] of Object.entries(catalog.pool || {})) {
    const isDown = (u) => state.endpoints[`${key} ${u}`]?.down === true;
    endpoints[key] = [...urls.filter((u) => !isDown(u)), ...urls.filter(isDown)];
  }

  let changed = false;
  const manifest = await readJson(MANIFEST, null);
  if (manifest && JSON.stringify(manifest.endpoints ?? {}) !== JSON.stringify(endpoints)) {
    // Only `endpoints` changes. It sits right after `urls`, away from the
    // moderation lists at the end of the file that the owner edits by hand,
    // so a rebase against a hand edit does not conflict.
    const next = {};
    for (const [k, val] of Object.entries(manifest)) {
      if (k === 'endpoints') continue;
      next[k] = val;
      if (k === 'urls') next.endpoints = endpoints;
    }
    if (!('endpoints' in next)) next.endpoints = endpoints;
    await writeFile(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
    changed = true;
  }

  const health = await readJson(HEALTH, null);
  const heartbeatDue =
    !health?.heartbeat_at || Date.now() - Date.parse(health.heartbeat_at) > HEARTBEAT_DAYS * 86_400_000;
  if (!health || wentDown.length || recovered.length || heartbeatDue) {
    const down = Object.entries(state.endpoints).filter(([, s]) => s.down).map(([id]) => id).sort();
    await writeFile(
      HEALTH,
      `${JSON.stringify(
        {
          _doc: 'Written by tools/endpoint-watch when an endpoint goes down or recovers, and weekly so the schedule stays enabled.',
          heartbeat_at: now,
          down,
          endpoints: Object.fromEntries(
            Object.entries(state.endpoints)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, s]) => [id, { down: s.down, last: s.cls, ms: s.ms, last_ok: s.last_ok ?? null }]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    changed = true;
  }
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`);

  const transition = wentDown.length > 0 || recovered.length > 0;
  const summary = clean(
    transition
      ? [wentDown.length && `down: ${wentDown.join(', ')}`, recovered.length && `recovered: ${recovered.join(', ')}`]
          .filter(Boolean)
          .join('; ')
      : changed
        ? 'endpoint order or weekly heartbeat'
        : 'no change',
  );
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n${summary}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\ntransition=${transition}\nsummary=${summary}\n`);
  }
  const hook = process.env.ENDPOINT_WATCH_WEBHOOK;
  if (transition && hook) {
    const text = `Polyvox endpoint-watch: ${summary}`;
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((e) => console.error(`webhook failed: ${e?.name}`));
  }
}

await main();
