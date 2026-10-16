// Pure logic for endpoint-watch: response classifiers, the Edge speech
// version and token parsers, strike counters, pool ordering, the vendor host
// check and the manifest splices. No network, no
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

// ── Edge speech recognition ─────────────────────────────────────────────────
//
// The probe streams a committed clip through the websocket and reports
// `{opened, code, ended, timedOut, phrases: [{status, text}], ms}`. Node's
// WebSocket surfaces a refused handshake (a bad token, a 403) as an error and
// close 1006 with no HTTP status, so `opened` is the discriminator.
// hard: the handshake failed, the socket dropped (1006), the turn ended with
//   no Success phrase or with text that is not the clip's.
// soft: the 10 s timeout, or a server-side close (1011-1014).

/** Lowercase words, punctuation stripped. */
const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Matched words over the longer of the two, so extra garbage cannot pass. */
export function wordOverlap(expected, got) {
  const want = words(expected);
  const have = words(got);
  if (!want.length || !have.length) return 0;
  const left = new Map();
  for (const w of want) left.set(w, (left.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of have) {
    if (left.get(w) > 0) {
      left.set(w, left.get(w) - 1);
      hit++;
    }
  }
  return hit / Math.max(want.length, have.length);
}

export const EDGE_STT_MIN_OVERLAP = 0.8;

export function classifyEdgeStt(r, expected) {
  if (r.timedOut) return verdict('soft', r.opened ? 'timeout' : 'handshake timeout', r.ms);
  if (!r.opened) return verdict('hard', `handshake failed (close ${r.code ?? '?'})`, r.ms);
  if (!r.ended) {
    const serverSide = r.code >= 1011 && r.code <= 1014;
    return verdict(serverSide ? 'soft' : 'hard', `closed ${r.code ?? '?'} before turn.end`, r.ms);
  }
  const text = (r.phrases || []).filter((p) => p.status === 'Success').map((p) => p.text).join(' ').trim();
  if (!text) return verdict('hard', 'no Success phrase', r.ms);
  const overlap = wordOverlap(expected, text);
  if (overlap < EDGE_STT_MIN_OVERLAP) return verdict('hard', `wrong text (${overlap.toFixed(2)}): ${text}`, r.ms);
  return verdict('ok', `recognized (${overlap.toFixed(2)})`, r.ms);
}

const versionParts = (v) => String(v).split('.').map((n) => Number(n) || 0);
const newer = (a, b) => {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
};

/** Newest Stable Windows x64 ProductVersion out of edgeupdates.microsoft.com/api/products, or null. */
export function edgeStableVersion(products) {
  const stable = Array.isArray(products) ? products.find((p) => p?.Product === 'Stable') : null;
  let best = null;
  for (const r of stable?.Releases || []) {
    if (r?.Platform !== 'Windows' || r?.Architecture !== 'x64') continue;
    if (!/^\d+(\.\d+){3}$/.test(r.ProductVersion ?? '')) continue;
    if (best === null || newer(r.ProductVersion, best)) best = r.ProductVersion;
  }
  return best;
}

/** TRUSTED_CLIENT_TOKEN out of rany2/edge-tts src/edge_tts/constants.py, or null. */
export function edgeTtsToken(src) {
  return String(src).match(/^TRUSTED_CLIENT_TOKEN\s*=\s*"([0-9A-F]{32})"/m)?.[1] ?? null;
}

/**
 * The (version, token) pairs worth re-probing after a failed handshake, new
 * version first, then new token, then both. Pairs equal to what is in effect
 * are skipped.
 */
export function edgeSttCandidates(current, found) {
  const v = found.version && found.version !== current.version ? found.version : null;
  const t = found.token && found.token !== current.token ? found.token : null;
  const out = [];
  if (v) out.push({ version: v, token: current.token });
  if (t) out.push({ version: current.version, token: t });
  if (v && t) out.push({ version: v, token: t });
  return out;
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
// Only the `endpoints` value and the two writable `edge_stt` fields change.
// Every other byte of the file stays as the owner wrote it, so a hand edit to the moderation lists never gets
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

const parse = (t) => JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** Throws unless every top-level key other than `key` is unchanged. */
function checkOthers(before, after, key) {
  const keysBefore = Object.keys(before).filter((k) => k !== key);
  const keysAfter = Object.keys(after).filter((k) => k !== key);
  if (canon(keysBefore) !== canon(keysAfter)) throw new Error('splice changed the key set');
  for (const k of keysBefore) {
    if (canon(before[k]) !== canon(after[k])) throw new Error(`splice changed ${k}`);
  }
}

/**
 * `text` with the top-level `key` value replaced by the already rendered
 * `value`, or the member inserted after the first present `anchors` key (last
 * when none is) when absent. Returns the new text unchecked.
 */
function spliceMember(text, key, value, anchors) {
  const { members, close } = topLevelMembers(text);
  const named = members.filter((m) => m.key === key);
  if (named.length > 1) throw new Error(`manifest has more than one ${key} key`);
  if (named.length === 1) {
    const m = named[0];
    return text.slice(0, m.valueStart) + value + text.slice(m.valueEnd);
  }
  const st = style(text);
  const anchor = anchors.map((a) => members.find((m) => m.key === a)).find(Boolean) ?? members.at(-1);
  const member = `${JSON.stringify(key)}: ${value}`;
  if (anchor) return `${text.slice(0, anchor.valueEnd)},${st.eol}${st.indent}${member}${text.slice(anchor.valueEnd)}`;
  return `${text.slice(0, close)}${st.eol}${st.indent}${member}${st.eol}${text.slice(close)}`;
}

/**
 * Returns `text` with the top-level `endpoints` value replaced by `endpoints`
 * (inserted after `urls`, or last, when absent). Throws instead of returning
 * anything that changes another key or fails to parse.
 */
export function spliceEndpoints(text, endpoints) {
  const before = parse(text);
  const next = spliceMember(text, 'endpoints', render(endpoints, style(text)), ['urls']);
  const after = parse(next);
  checkOthers(before, after, 'endpoints');
  if (canon(after.endpoints) !== canon(endpoints)) throw new Error('splice did not write endpoints');
  return next;
}

/** The two `edge_stt` fields the watch may write. Host, path and auth stay the owner's. */
export const EDGE_STT_WRITABLE = ['version', 'token'];

/**
 * Returns `text` with `fields` (only `version` and `token`) set inside the
 * top-level `edge_stt` object. Present members get their value replaced in
 * place, missing ones are appended in the object's own indentation, and a
 * missing object is inserted after `endpoints` (or `urls`, or last). Every
 * other byte, inside the object too, stays. Throws instead of returning
 * anything that changes another key or fails to parse.
 */
export function spliceEdgeStt(text, fields) {
  const set = Object.entries(fields).filter(([, v]) => v !== undefined);
  for (const [k, v] of set) {
    if (!EDGE_STT_WRITABLE.includes(k)) throw new Error(`edge_stt.${k} is not writable`);
    if (typeof v !== 'string' || !v) throw new Error(`edge_stt.${k} must be a non-empty string`);
  }
  const before = parse(text);
  const prev = before.edge_stt;
  if (prev !== undefined && (prev === null || typeof prev !== 'object' || Array.isArray(prev))) {
    throw new Error('edge_stt is not an object');
  }
  const st = style(text);
  const top = topLevelMembers(text).members.filter((m) => m.key === 'edge_stt');
  if (top.length > 1) throw new Error('manifest has more than one edge_stt key');
  let next;
  if (!top.length) {
    next = spliceMember(text, 'edge_stt', render(Object.fromEntries(set), st), ['endpoints', 'urls']);
  } else {
    const { valueStart, valueEnd } = top[0];
    let obj = text.slice(valueStart, valueEnd);
    const inner = topLevelMembers(obj).members;
    for (const k of EDGE_STT_WRITABLE) {
      if (inner.filter((m) => m.key === k).length > 1) throw new Error(`edge_stt has more than one ${k} key`);
    }
    // Replace from the end so earlier offsets stay valid.
    const present = set.map(([k, v]) => [inner.find((m) => m.key === k), v]).filter(([m]) => m);
    present.sort(([a], [b]) => b.valueStart - a.valueStart);
    for (const [m, v] of present) obj = obj.slice(0, m.valueStart) + JSON.stringify(v) + obj.slice(m.valueEnd);
    const missing = set.filter(([k]) => !inner.some((m) => m.key === k));
    if (missing.length) {
      const now = topLevelMembers(obj);
      if (!now.members.length) {
        obj = render({ ...prev, ...Object.fromEntries(missing) }, st);
      } else {
        const last = now.members.at(-1);
        const first = now.members[0];
        // The first member's line prefix is the object's indentation; a
        // single-line object gets single-line members.
        const lead = obj.slice(obj.lastIndexOf('\n', first.keyStart) + 1, first.keyStart);
        const multiline = obj.lastIndexOf('\n', first.keyStart) >= 0;
        const sep = multiline ? `,${st.eol}${lead}` : ', ';
        const add = missing.map(([k, v]) => `${sep}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join('');
        obj = obj.slice(0, last.valueEnd) + add + obj.slice(last.valueEnd);
      }
    }
    next = text.slice(0, valueStart) + obj + text.slice(valueEnd);
  }
  const after = parse(next);
  checkOthers(before, after, 'edge_stt');
  const want = { ...(prev || {}), ...Object.fromEntries(set) };
  if (canon(Object.keys(after.edge_stt).sort()) !== canon(Object.keys(want).sort())) {
    throw new Error('splice changed the edge_stt key set');
  }
  for (const [k, v] of Object.entries(want)) {
    if (canon(after.edge_stt[k]) !== canon(v)) throw new Error(`splice did not keep edge_stt.${k}`);
  }
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
