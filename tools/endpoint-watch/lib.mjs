// Pure logic for endpoint-watch: response classifiers, strike counters, pool
// ordering, the vendor host check and the manifest splice. No network, no
// disk, so `node --test` can drive every branch. watch.mjs does the I/O.

// ── Classification ─────────────────────────────────────────────────────────
//
// ok: a real translation came back (keyed hosts: the API answered).
// throttled: 429, a challenge page, a /sorry/ redirect. The watch runs on
//   datacenter addresses that Google throttles far more than a home
//   connection, so throttled never counts against an endpoint.
// hard: DNS failure, 404/410, a 200 whose body does not parse or hands the
//   input back untranslated.
// soft: 5xx, timeouts, resets, other transport errors.
//
// A response is `{status, headers, body}` (headers a Headers or a plain
// object) or `{error: 'hard' | 'soft', detail}` for a transport failure.

export const verdict = (cls, why, ms = 0) => ({ cls, why: String(why).slice(0, 120), ms });

/** Transport error code to class. NXDOMAIN is the one that means the host is gone. */
export const transportClass = (code) => (code === 'ENOTFOUND' ? 'hard' : 'soft');

const header = (headers, name) =>
  typeof headers?.get === 'function' ? headers.get(name) : (headers?.[name] ?? headers?.[name.toLowerCase()]);

const untranslated = (out, probe) => out.trim().toLowerCase() === probe.trim().toLowerCase();

/** The status checks every keyless probe shares. Returns a verdict, or null to go on to the body. */
function statusVerdict(r, label = '') {
  const p = label ? `${label} ` : '';
  if (r.error) return verdict(r.error, `${p}${r.detail}`, r.ms);
  if (r.status === 429) return verdict('throttled', `${p}HTTP 429`, r.ms);
  if (r.status === 404 || r.status === 410) return verdict('hard', `${p}HTTP ${r.status}`, r.ms);
  if (r.status !== 200) return verdict('soft', `${p}HTTP ${r.status}`, r.ms);
  return null;
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

export function classifyGoogle(pathname, r, probe) {
  if (r.error) return verdict(r.error, r.detail, r.ms);
  // Google answers a throttled address with 429, sometimes 403, or a 302 to /sorry/.
  if (r.status === 429 || r.status === 403) return verdict('throttled', `HTTP ${r.status}`, r.ms);
  if (r.status >= 300 && r.status < 400) {
    const loc = header(r.headers, 'location') || '';
    return verdict(loc.includes('/sorry') ? 'throttled' : 'soft', `HTTP ${r.status} redirect`, r.ms);
  }
  const s = statusVerdict(r);
  if (s) return s;
  if (r.body.trimStart().startsWith('<')) return verdict('throttled', 'HTML instead of JSON', r.ms);
  const out = parseGoogle(pathname, r.body);
  if (out === null) return verdict('hard', 'unparseable body', r.ms);
  if (untranslated(out, probe)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', 'translated', r.ms);
}

/** Bing's translator page: the session markers, or a verdict when they are missing. */
export function classifyBingSession(page) {
  const s = statusVerdict(page, 'session');
  if (s) return { verdict: s };
  const ig = page.body.match(/IG:"([^"]+)"/)?.[1];
  const iid = page.body.match(/data-iid="([^"]+)"/)?.[1];
  const helper = page.body.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)"/);
  if (!ig || !iid || !helper) {
    const challenged = /captcha|challenge/i.test(page.body);
    return { verdict: verdict(challenged ? 'throttled' : 'hard', 'session markers missing', page.ms) };
  }
  return { ig, iid, key: helper[1], token: helper[2] };
}

export function classifyBing(r, probe) {
  const s = statusVerdict(r);
  if (s) return s;
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
  if (untranslated(out, probe)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', j[0]?.usedLLM ? 'translated (LLM)' : 'translated', r.ms);
}

export function classifyMyMemory(r, probe) {
  const s = statusVerdict(r);
  if (s) return s;
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
  if (untranslated(out, probe)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', 'translated', r.ms);
}

export function classifyTransmart(r, probe) {
  const s = statusVerdict(r);
  if (s) return s;
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
  if (untranslated(out, probe)) return verdict('hard', 'input came back untranslated', r.ms);
  return verdict('ok', 'translated', r.ms);
}

/** Keyed APIs get no credentials: any answer below 500 (an auth error, mostly) means alive. */
export function classifyKeyed(r, { alive404 = false } = {}) {
  if (r.error) return verdict(r.error, r.detail, r.ms);
  if ((r.status === 404 && !alive404) || r.status === 410) return verdict('hard', `HTTP ${r.status}`, r.ms);
  if (r.status >= 500) return verdict('soft', `HTTP ${r.status}`, r.ms);
  if (r.status === 429) return verdict('throttled', 'HTTP 429', r.ms);
  return verdict('ok', `alive (HTTP ${r.status})`, r.ms);
}

// ── Strike counters ────────────────────────────────────────────────────────
//
// `hard` counts hard results since the last ok; `fail` counts every failure
// (hard or soft) since the last ok. Down at 3 hard or 6 failures, which at
// the 30 minute schedule is 90 minutes or 3 hours. One ok clears both and
// brings a down endpoint back. Throttled leaves both untouched: it neither
// demotes nor proves the endpoint works.

export const HARD_DOWN = 3;
export const FAIL_DOWN = 6;

/** Advance one endpoint's counters. Returns 'down', 'recovered' or null. */
export function strike(s, cls) {
  s.hard ??= 0;
  s.fail ??= 0;
  s.down ??= false;
  if (cls === 'ok') {
    s.hard = 0;
    s.fail = 0;
  } else if (cls === 'hard') {
    s.hard += 1;
    s.fail += 1;
  } else if (cls === 'soft') {
    s.fail += 1;
  }
  const down = s.hard >= HARD_DOWN || s.fail >= FAIL_DOWN;
  const was = s.down;
  s.down = down;
  if (down && !was) return 'down';
  if (!down && was) return 'recovered';
  return null;
}

// ── Vendor hosts (mirror of TRANSLATION_VENDOR_HOSTS in url_overrides.rs) ───

function labelMatches(pattern, label) {
  const i = pattern.indexOf('*');
  if (i < 0) return pattern === label;
  const prefix = pattern.slice(0, i);
  const suffix = pattern.slice(i + 1);
  return label.length >= prefix.length + suffix.length && label.startsWith(prefix) && label.endsWith(suffix);
}

export function hostMatches(pattern, host) {
  if (pattern.startsWith('*.')) {
    const domain = pattern.slice(2);
    return host === domain || (host.endsWith(domain) && host.slice(0, -domain.length).endsWith('.'));
  }
  const want = pattern.split('.');
  const have = host.split('.');
  return want.length === have.length && want.every((p, i) => labelMatches(p, have[i]));
}

function httpsHost(url) {
  if (!url.startsWith('https://')) return null;
  const rest = url.slice('https://'.length);
  const authority = rest.split(/[/?#]/)[0];
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (!host || host.includes('[')) return null;
  return host.split(':')[0];
}

function httpsPath(url) {
  const rest = url.startsWith('https://') ? url.slice('https://'.length) : url;
  const i = rest.search(/[/?#]/);
  if (i >= 0 && rest[i] === '/') return rest.slice(i).split(/[?#]/)[0];
  return '/';
}

/** Whether the app would accept `url` for `key`. Same rules as `translation_url_allowed`. */
export function urlAllowed(vendorHosts, key, url) {
  const row = vendorHosts?.[key];
  if (!row || !Array.isArray(row.hosts)) return false;
  const raw = httpsHost(url);
  if (raw === null) return false;
  const host = raw.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (!row.hosts.some((p) => hostMatches(p, host))) return false;
  const paths = row.paths || [];
  return paths.length === 0 || paths.some((p) => httpsPath(url).startsWith(p));
}

/** Longest list the app accepts for one key (MAX_ENDPOINTS_PER_KEY). */
export const MAX_ENDPOINTS_PER_KEY = 8;

/**
 * The manifest `endpoints` value: per pool key, catalog order with down
 * endpoints moved to the end. URLs the app would reject are dropped; a key
 * left with nothing is omitted, never written empty.
 */
export function orderPools(pools, vendorHosts, isDown) {
  const out = {};
  const rejected = [];
  for (const [key, urls] of Object.entries(pools || {})) {
    const allowed = urls.filter((u) => {
      const ok = urlAllowed(vendorHosts, key, u);
      if (!ok) rejected.push(`${key} ${u}`);
      return ok;
    });
    const up = allowed.filter((u) => !isDown(key, u));
    const down = allowed.filter((u) => isDown(key, u));
    const list = [...up, ...down].slice(0, MAX_ENDPOINTS_PER_KEY);
    if (list.length) out[key] = list;
  }
  return { endpoints: out, rejected };
}

// ── Manifest splice ────────────────────────────────────────────────────────
//
// Only the `endpoints` value changes. Every other byte of the file stays as
// the owner wrote it, so a hand edit to the moderation lists never gets
// reformatted and a rebase against one does not conflict.

function skipWs(t, i) {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

function endOfString(t, i) {
  // t[i] is the opening quote.
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') j++;
    else if (t[j] === '"') return j + 1;
  }
  throw new Error('unterminated string');
}

function endOfValue(t, i) {
  const c = t[i];
  if (c === '"') return endOfString(t, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (ch === '"') j = endOfString(t, j) - 1;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    throw new Error('unterminated container');
  }
  let j = i;
  while (j < t.length && !/[\s,}\]]/.test(t[j])) j++;
  if (j === i) throw new Error(`no value at ${i}`);
  return j;
}

/** Top-level members of a JSON object text: [{key, keyStart, valueStart, valueEnd}], plus the root's close brace. */
export function topLevelMembers(t) {
  let i = skipWs(t, t.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (t[i] !== '{') throw new Error('manifest is not a JSON object');
  i = skipWs(t, i + 1);
  const members = [];
  if (t[i] === '}') return { members, close: i };
  for (;;) {
    if (t[i] !== '"') throw new Error(`expected a key at ${i}`);
    const keyStart = i;
    const keyEnd = endOfString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd));
    i = skipWs(t, keyEnd);
    if (t[i] !== ':') throw new Error(`expected ':' at ${i}`);
    const valueStart = skipWs(t, i + 1);
    const valueEnd = endOfValue(t, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipWs(t, valueEnd);
    if (t[i] === ',') {
      i = skipWs(t, i + 1);
      continue;
    }
    if (t[i] === '}') return { members, close: i };
    throw new Error(`expected ',' or '}' at ${i}`);
  }
}

/** The file's line ending and one level of indentation. */
function style(t) {
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  const m = t.match(/\n([ \t]+)"/);
  return { eol, indent: m ? m[1] : '  ' };
}

/** `value` rendered as a member value one level deep, in the file's style. */
function render(value, { eol, indent }) {
  return JSON.stringify(value, null, indent).split('\n').join(`${eol}${indent}`);
}

const canon = (v) => JSON.stringify(v);

/**
 * Returns `text` with the top-level `endpoints` value replaced by `endpoints`
 * (inserted after `urls`, or last, when absent). Throws instead of returning
 * anything that changes another key or fails to parse.
 */
export function spliceEndpoints(text, endpoints) {
  const before = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const { members, close } = topLevelMembers(text);
  const named = members.filter((m) => m.key === 'endpoints');
  if (named.length > 1) throw new Error('manifest has more than one endpoints key');
  const st = style(text);
  const value = render(endpoints, st);
  let next;
  if (named.length === 1) {
    const m = named[0];
    next = text.slice(0, m.valueStart) + value + text.slice(m.valueEnd);
  } else {
    const anchor = members.find((m) => m.key === 'urls') ?? members.at(-1);
    const member = `"endpoints": ${value}`;
    if (anchor) {
      next = `${text.slice(0, anchor.valueEnd)},${st.eol}${st.indent}${member}${text.slice(anchor.valueEnd)}`;
    } else {
      next = `${text.slice(0, close)}${st.eol}${st.indent}${member}${st.eol}${text.slice(close)}`;
    }
  }
  const after = JSON.parse(next.charCodeAt(0) === 0xfeff ? next.slice(1) : next);
  const keysBefore = Object.keys(before).filter((k) => k !== 'endpoints');
  const keysAfter = Object.keys(after).filter((k) => k !== 'endpoints');
  if (canon(keysBefore) !== canon(keysAfter)) throw new Error('splice changed the key set');
  for (const k of keysBefore) {
    if (canon(before[k]) !== canon(after[k])) throw new Error(`splice changed ${k}`);
  }
  if (canon(after.endpoints) !== canon(endpoints)) throw new Error('splice did not write endpoints');
  return next;
}

// ── Diff for --dry-run ─────────────────────────────────────────────────────

/** Line diff, `-`/`+`/` ` prefixed, unchanged runs longer than 6 lines folded. */
export function lineDiff(a, b) {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+ ${y[j++]}`);
    } else {
      out.push(`- ${x[i++]}`);
    }
  }
  const folded = [];
  for (let k = 0; k < out.length; ) {
    let e = k;
    while (e < out.length && out[e].startsWith('  ')) e++;
    if (e - k > 6) {
      folded.push(...out.slice(k, k + 2), `  ... ${e - k - 4} unchanged lines`, ...out.slice(e - 2, e));
      k = e;
    } else if (e > k) {
      folded.push(...out.slice(k, e));
      k = e;
    } else {
      folded.push(out[k++]);
    }
  }
  return folded.join('\n');
}

// ── The Rust table, for the agreement test ─────────────────────────────────

/** `TRANSLATION_VENDOR_HOSTS` out of url_overrides.rs, as `{key: {hosts, paths}}`. */
export function parseRustVendorTable(src) {
  const consts = {};
  for (const m of src.matchAll(/const\s+([A-Z_]+)\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\];/g)) {
    consts[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((s) => s[1]);
  }
  const start = src.indexOf('const TRANSLATION_VENDOR_HOSTS');
  if (start < 0) return null;
  const body = src.slice(src.indexOf('= &[', start) + 4, src.indexOf('\n];', start)).replace(/\/\/[^\n]*/g, '');
  const list = (s) => {
    s = s.trim();
    if (/^[A-Z_]+$/.test(s)) {
      if (!consts[s]) throw new Error(`unknown const ${s}`);
      return consts[s];
    }
    return [...s.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };
  const table = {};
  for (const m of body.matchAll(/\(\s*"([^"]+)"\s*,\s*([A-Z_]+|&\[[^\]]*\])\s*,\s*(&\[[^\]]*\])\s*,?\s*\)/g)) {
    table[m[1]] = { hosts: list(m[2].replace(/^&/, '')), paths: list(m[3].replace(/^&/, '')) };
  }
  return table;
}
