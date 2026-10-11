#!/usr/bin/env node
// endpoint-watch: probes every translation endpoint Polyvox depends on, keeps
// the manifest's per-engine endpoint lists healthy-first, and reports when an
// endpoint goes down or comes back. Node 20+, no dependencies.
//
//   node tools/endpoint-watch/watch.mjs             probe and print a table
//   node tools/endpoint-watch/watch.mjs --dry-run   also print the manifest diff
//        a --write run would make (streaks from the state file, if any, plus
//        this run), writing nothing
//   node tools/endpoint-watch/watch.mjs --write     also update the streak state,
//        the `endpoints` key of url-overrides.json and endpoint-health.json, and
//        write changed / transition / summary to $GITHUB_OUTPUT
//
// Rules (lib.mjs has the details): throttled (429, challenge page) never
// counts; down after 3 hard results or 6 failures since the last ok; only a
// down endpoint moves to the end of its pool list; no list is ever emptied;
// only URLs on the vendor's row of catalog.json `vendor_hosts` (the app's
// TRANSLATION_VENDOR_HOSTS) are ever written; every other manifest byte is
// left as it was.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyBing,
  classifyBingSession,
  classifyGoogle,
  classifyKeyed,
  classifyMyMemory,
  classifyTransmart,
  lineDiff,
  orderPools,
  spliceEndpoints,
  strike,
  transportClass,
  verdict,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const DRY = args.includes('--dry-run');
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CATALOG = opt('--catalog', path.join(HERE, 'catalog.json'));
const STATE = opt('--state', path.join(ROOT, '.endpoint-watch-state.json'));
const MANIFEST = opt('--manifest', path.join(ROOT, 'url-overrides.json'));
const HEALTH = opt('--health', path.join(ROOT, 'endpoint-health.json'));

const TIMEOUT_MS = 10_000;
const HEARTBEAT_DAYS = 7;
// The headers the app itself sends, so the watch sees what users see.
const GOOGLE_UA = 'Mozilla/5.0';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
const PROBE = catalog.probe_text || 'hello friend';

async function timedFetch(url, init = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const code = e?.cause?.code || e?.name || 'error';
    return { error: transportClass(code), detail: code, ms: Math.round(performance.now() - t0) };
  }
}

async function probeGoogle(endpoint) {
  const u = new URL(endpoint);
  u.searchParams.set('sl', 'en');
  u.searchParams.set('tl', 'ja');
  if (u.pathname.endsWith('/single')) u.searchParams.set('dt', 't');
  u.searchParams.set('q', PROBE);
  const r = await timedFetch(u, { headers: { 'User-Agent': GOOGLE_UA }, redirect: 'manual' });
  return classifyGoogle(u.pathname, r, PROBE);
}

async function probeBing({ session, url }) {
  const page = await timedFetch(session, { headers: { 'User-Agent': EDGE_UA } });
  const s = classifyBingSession(page);
  if (s.verdict) return s.verdict;
  const form = new URLSearchParams({ fromLang: 'en', text: PROBE, to: 'ja', token: s.token, key: s.key });
  const r = await timedFetch(`${url}?isVertical=1&&IG=${s.ig}&IID=${s.iid}.1`, {
    method: 'POST',
    headers: { 'User-Agent': EDGE_UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: session },
    body: form,
  });
  return classifyBing(r, PROBE);
}

async function probeMyMemory({ url }) {
  const u = new URL(url);
  u.searchParams.set('q', PROBE);
  u.searchParams.set('langpair', 'en|ja');
  return classifyMyMemory(await timedFetch(u), PROBE);
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
  return classifyTransmart(r, PROBE);
}

async function probeKeyed(spec) {
  const post = spec.method === 'POST';
  const r = await timedFetch(spec.url, {
    method: spec.method,
    headers: { 'User-Agent': BROWSER_UA, ...(post ? { 'Content-Type': 'application/json' } : {}) },
    body: post ? '{}' : undefined,
  });
  return classifyKeyed(r, spec);
}

const SINGLE = { bing: probeBing, mymemory: probeMyMemory, transmart: probeTransmart };

/** Every probe as [id, engine, label, run]. ids are stable state keys. */
function plan() {
  const jobs = [];
  for (const [key, urls] of Object.entries(catalog.pool || {})) {
    for (const url of urls) jobs.push([`${key} ${url}`, key, url, () => probeGoogle(url)]);
  }
  for (const [key, spec] of Object.entries(catalog.single || {})) {
    const run = SINGLE[spec.probe];
    jobs.push([key, key, spec.url, run ? () => run(spec) : async () => verdict('hard', `no probe ${spec.probe}`)]);
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

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
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
  if (!WRITE && !DRY) return;

  const now = new Date().toISOString();
  const state = await readJson(STATE, { endpoints: {} });
  state.endpoints ||= {};
  const wentDown = [];
  const recovered = [];
  for (const [id, , , r] of results) {
    const s = (state.endpoints[id] ||= {});
    const t = strike(s, r.cls);
    if (t === 'down') wentDown.push(id);
    if (t === 'recovered') recovered.push(id);
    if (r.cls === 'ok') s.last_ok = now;
    Object.assign(s, { cls: r.cls, why: r.why, ms: r.ms, at: now });
  }
  // Ids no longer in the catalog are forgotten, so a removed endpoint cannot
  // hold a stale down flag forever.
  const live = new Set(results.map(([id]) => id));
  for (const id of Object.keys(state.endpoints)) if (!live.has(id)) delete state.endpoints[id];

  const { endpoints, rejected } = orderPools(
    catalog.pool,
    catalog.vendor_hosts,
    (key, u) => state.endpoints[`${key} ${u}`]?.down === true,
  );
  for (const r of rejected) console.error(`refusing to write ${r}: host not on the vendor row`);

  let changed = false;
  const text = await readText(MANIFEST);
  let nextText = text;
  if (text !== null) {
    const current = JSON.parse(text.replace(/^﻿/, ''));
    // Commit only when the lists change; key order inside `endpoints` is
    // catalog order, so a string compare is an order compare.
    if (JSON.stringify(current.endpoints ?? {}) !== JSON.stringify(endpoints)) {
      nextText = spliceEndpoints(text, endpoints);
    }
  }

  if (DRY) {
    console.log(`\ndown: ${Object.entries(state.endpoints).filter(([, s]) => s.down).map(([id]) => id).join(', ') || 'none'}`);
    if (text === null) console.log(`no manifest at ${MANIFEST}`);
    else if (nextText === text) console.log('manifest: no change');
    else console.log(`manifest diff (${path.basename(MANIFEST)}):\n${lineDiff(text, nextText)}`);
    return;
  }

  if (nextText !== text) {
    await writeFile(MANIFEST, nextText);
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
    const msg = `Polyvox endpoint-watch: ${summary}`;
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg, text: msg }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((e) => console.error(`webhook failed: ${e?.name}`));
  }
}

await main();
