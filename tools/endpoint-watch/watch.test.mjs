// node --test tools/endpoint-watch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyBing,
  classifyBingSession,
  classifyEdgeStt,
  classifyGoogle,
  classifyKeyed,
  classifyMyMemory,
  classifyTransmart,
  edgeStableVersion,
  edgeSttCandidates,
  edgeTtsToken,
  orderPools,
  parseRustVendorTable,
  spliceEdgeStt,
  spliceEndpoints,
  strike,
  topLevelMembers,
  transportClass,
  urlAllowed,
  wordOverlap,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(HERE, 'catalog.json'), 'utf8'));
const P = 'hello friend';
const ok200 = (body, extra = {}) => ({ status: 200, headers: {}, body, ms: 1, ...extra });
const status = (s, body = '', headers = {}) => ({ status: s, headers, body, ms: 1 });

// ── Classifier ──────────────────────────────────────────────────────────────

test('google: each failure kind', () => {
  const single = '/translate_a/single';
  const t = '/translate_a/t';
  assert.equal(classifyGoogle(single, ok200('[[["こんにちは友達","hello friend"]]]'), P).cls, 'ok');
  assert.equal(classifyGoogle(t, ok200('["こんにちは"]'), P).cls, 'ok');
  assert.equal(classifyGoogle(t, ok200('[["こんにちは","en"]]'), P).cls, 'ok');
  assert.equal(classifyGoogle(single, { error: transportClass('ENOTFOUND'), detail: 'ENOTFOUND' }, P).cls, 'hard');
  assert.equal(classifyGoogle(single, { error: transportClass('TimeoutError'), detail: 'TimeoutError' }, P).cls, 'soft');
  assert.equal(classifyGoogle(single, { error: transportClass('ECONNRESET'), detail: 'ECONNRESET' }, P).cls, 'soft');
  assert.equal(classifyGoogle(single, status(404), P).cls, 'hard');
  assert.equal(classifyGoogle(single, status(410), P).cls, 'hard');
  assert.equal(classifyGoogle(single, status(500), P).cls, 'soft');
  assert.equal(classifyGoogle(single, status(503), P).cls, 'soft');
  assert.equal(classifyGoogle(single, ok200('not json'), P).cls, 'hard');
  assert.equal(classifyGoogle(single, ok200('{"x":1}'), P).cls, 'hard');
  assert.equal(classifyGoogle(single, ok200('[[["Hello friend","hello friend"]]]'), P).cls, 'hard');
  assert.equal(classifyGoogle(t, ok200('["hello friend"]'), P).cls, 'hard');
});

test('google: 429, 403, /sorry and challenge pages are throttled, never hard', () => {
  const single = '/translate_a/single';
  assert.equal(classifyGoogle(single, status(429), P).cls, 'throttled');
  assert.equal(classifyGoogle(single, status(403), P).cls, 'throttled');
  assert.equal(
    classifyGoogle(single, status(302, '', { location: 'https://www.google.com/sorry/index?continue=x' }), P).cls,
    'throttled',
  );
  assert.equal(classifyGoogle(single, ok200('<html><body>unusual traffic</body></html>'), P).cls, 'throttled');
  assert.equal(classifyGoogle(single, status(302, '', { location: 'https://example.com/' }), P).cls, 'soft');
});

test('bing: session and translate classes', () => {
  const page = 'IG:"ABC" data-iid="translator.5023" params_AbusePreventionHelper = [1700000000,"tok",3600000]';
  const s = classifyBingSession(ok200(page));
  assert.deepEqual([s.ig, s.iid, s.key, s.token], ['ABC', 'translator.5023', '1700000000', 'tok']);
  assert.equal(classifyBingSession(status(404)).verdict.cls, 'hard');
  assert.equal(classifyBingSession(status(429)).verdict.cls, 'throttled');
  assert.equal(classifyBingSession(ok200('<html>captcha</html>')).verdict.cls, 'throttled');
  assert.equal(classifyBingSession(ok200('<html>redesigned</html>')).verdict.cls, 'hard');
  assert.equal(classifyBing(ok200('[{"translations":[{"text":"こんにちは"}],"usedLLM":true}]'), P).cls, 'ok');
  assert.equal(classifyBing(ok200('{"statusCode":400}'), P).cls, 'hard');
  assert.equal(classifyBing(ok200('{"statusCode":429}'), P).cls, 'throttled');
  assert.equal(classifyBing(ok200('[{"translations":[{"text":"hello friend"}]}]'), P).cls, 'hard');
  assert.equal(classifyBing(status(502), P).cls, 'soft');
});

test('mymemory and transmart classes', () => {
  assert.equal(classifyMyMemory(ok200('{"responseStatus":200,"responseData":{"translatedText":"やあ"}}'), P).cls, 'ok');
  assert.equal(classifyMyMemory(ok200('{"responseStatus":200,"quotaFinished":true}'), P).cls, 'throttled');
  assert.equal(classifyMyMemory(ok200('{"responseStatus":"429"}'), P).cls, 'throttled');
  assert.equal(classifyMyMemory(ok200('{"responseStatus":403}'), P).cls, 'hard');
  assert.equal(classifyMyMemory(ok200('{"responseStatus":200,"responseData":{"translatedText":"Hello friend"}}'), P).cls, 'hard');
  assert.equal(classifyTransmart(ok200('{"header":{"ret_code":"succ"},"auto_translation":["やあ"]}'), P).cls, 'ok');
  assert.equal(classifyTransmart(ok200('{"header":{"ret_code":"error"}}'), P).cls, 'hard');
  assert.equal(classifyTransmart(status(429), P).cls, 'throttled');
});

test('keyed: an auth error is alive, 404 is hard unless alive404', () => {
  assert.equal(classifyKeyed(status(401)).cls, 'ok');
  assert.equal(classifyKeyed(status(403)).cls, 'ok');
  assert.equal(classifyKeyed(status(400)).cls, 'ok');
  assert.equal(classifyKeyed(status(404)).cls, 'hard');
  assert.equal(classifyKeyed(status(404), { alive404: true }).cls, 'ok');
  assert.equal(classifyKeyed(status(410), { alive404: true }).cls, 'hard');
  assert.equal(classifyKeyed(status(503)).cls, 'soft');
  assert.equal(classifyKeyed(status(429)).cls, 'throttled');
  assert.equal(classifyKeyed({ error: 'hard', detail: 'ENOTFOUND' }).cls, 'hard');
});

// ── Strike counters ─────────────────────────────────────────────────────────

const run = (seq) => {
  const s = {};
  return seq.map((c) => strike(s, c));
};

test('down after three hard results, recovered on one ok', () => {
  assert.deepEqual(run(['hard', 'hard', 'hard']), [null, null, 'down']);
  assert.deepEqual(run(['hard', 'hard', 'ok', 'hard', 'hard']), [null, null, null, null, null]);
  assert.deepEqual(run(['hard', 'hard', 'hard', 'hard', 'ok']), [null, null, 'down', null, 'recovered']);
});

test('down after six failures of any kind', () => {
  assert.deepEqual(run(['soft', 'soft', 'soft', 'soft', 'soft']).at(-1), null);
  assert.deepEqual(run(['soft', 'soft', 'soft', 'soft', 'soft', 'soft']).at(-1), 'down');
  assert.deepEqual(run(['hard', 'soft', 'hard', 'soft', 'soft', 'soft']).at(-1), 'down');
});

test('429 rule: throttled never demotes and never resets', () => {
  assert.ok(run(Array(50).fill('throttled')).every((t) => t === null));
  assert.deepEqual(run(['hard', 'throttled', 'hard', 'throttled', 'hard']).at(-1), 'down');
  const s = {};
  for (const c of ['hard', 'hard', 'hard']) strike(s, c);
  assert.equal(strike(s, 'throttled'), null);
  assert.equal(s.down, true, 'a throttled answer is not proof the endpoint is back');
});

// ── Pool ordering and the vendor table ──────────────────────────────────────

const VH = catalog.vendor_hosts;
const G = catalog.pool.google_free;

test('order: healthy first in catalog order, down last', () => {
  const down = new Set([G[0], G[2]]);
  const { endpoints } = orderPools({ google_free: G }, VH, (_, u) => down.has(u));
  assert.deepEqual(endpoints.google_free, [G[1], G[3], G[4], G[0], G[2]]);
  assert.deepEqual(orderPools({ google_free: G }, VH, () => false).endpoints.google_free, G);
});

test('never-empty: every endpoint down keeps the full list, a list of rejects is omitted', () => {
  const { endpoints } = orderPools({ google_free: G }, VH, () => true);
  assert.deepEqual(endpoints.google_free, G);
  const r = orderPools({ google_free: ['https://evil.example/translate_a/single'] }, VH, () => false);
  assert.equal('google_free' in r.endpoints, false);
  assert.equal(r.rejected.length, 1);
});

test('vendor table: hosts, paths, and the tricks the app rejects', () => {
  assert.ok(urlAllowed(VH, 'google_free', 'https://clients5.google.com/translate_a/t?client=x'));
  assert.ok(!urlAllowed(VH, 'google_free', 'https://translate.google.com/m'));
  assert.ok(!urlAllowed(VH, 'google_free', 'https://script.google.com/translate_a/single'));
  assert.ok(!urlAllowed(VH, 'google_free', 'http://translate.googleapis.com/translate_a/single'));
  assert.ok(!urlAllowed(VH, 'google_free', 'https://translate.googleapis.com.evil.example/translate_a/single'));
  assert.ok(!urlAllowed(VH, 'google_free', 'https://evil.example\\.translate.google.com/translate_a/single'));
  assert.ok(urlAllowed(VH, 'deepl_free', 'https://user@api-free.deepl.com/v2/translate'));
  assert.ok(!urlAllowed(VH, 'deepl_free', 'https://api.deepl.com@evil.example/v2/translate'));
  assert.ok(urlAllowed(VH, 'deepl_free', 'https://deepl.com/'));
  assert.ok(!urlAllowed(VH, 'deepl_free', 'https://notdeepl.com/'));
  assert.ok(urlAllowed(VH, 'google_tllm', 'https://translate-pa.googleapis.com/v1/x'));
  assert.ok(!urlAllowed(VH, 'google_tllm', 'https://a.translate-pa.googleapis.com/v1/x'));
  assert.ok(!urlAllowed(VH, 'no_such_key', 'https://api.openai.com/'));
  assert.ok(!urlAllowed(VH, '_source', 'https://api.openai.com/'));
});

test('every catalog pool URL is on its vendor row', () => {
  for (const [key, urls] of Object.entries(catalog.pool)) {
    for (const u of urls) assert.ok(urlAllowed(VH, key, u), `${key} ${u}`);
    assert.ok(urls.length <= 8, `${key} is longer than MAX_ENDPOINTS_PER_KEY`);
  }
});

test('catalog vendor_hosts agrees with TRANSLATION_VENDOR_HOSTS in url_overrides.rs', (t) => {
  const file = process.env.POLYVOX_VRC_URL_OVERRIDES;
  if (!file || !existsSync(file)) {
    t.skip('set POLYVOX_VRC_URL_OVERRIDES to polyvox-vrc src-tauri/src/config/url_overrides.rs');
    return;
  }
  const rust = parseRustVendorTable(readFileSync(file, 'utf8'));
  assert.ok(rust, 'no TRANSLATION_VENDOR_HOSTS in that file');
  const { _source, ...mine } = VH;
  assert.ok(_source);
  assert.deepEqual(mine, rust);
});

// ── Manifest splice ─────────────────────────────────────────────────────────

const EP = { google_free: [G[1], G[0]] };

function assertOnlyEndpointsChanged(before, after) {
  const b = JSON.parse(before);
  const a = JSON.parse(after);
  assert.deepEqual(a.endpoints, EP);
  for (const k of Object.keys(b)) if (k !== 'endpoints') assert.deepEqual(a[k], b[k]);
}

test('splice: replaces endpoints only, every other byte identical', () => {
  const before = `{\n  "version": 2,\n  "urls": {},\n  "endpoints": {\n    "google_free": ["${G[0]}"]\n  },\n  "denied": ["a","b"],\n  "x": 1\n}\n`;
  const after = spliceEndpoints(before, EP);
  assertOnlyEndpointsChanged(before, after);
  const head = before.slice(0, before.indexOf('"endpoints": ') + 13);
  const tail = before.slice(before.indexOf(',\n  "denied"'));
  assert.ok(after.startsWith(head));
  assert.ok(after.endsWith(tail));
  assert.equal(spliceEndpoints(after, EP), after, 'idempotent');
});

test('splice: inserts after urls when absent', () => {
  const before = '{\n  "version": 2,\n  "urls": {},\n  "denied_accounts": [\n    "aa"\n  ]\n}\n';
  const after = spliceEndpoints(before, EP);
  assertOnlyEndpointsChanged(before, after);
  assert.deepEqual(Object.keys(JSON.parse(after)), ['version', 'urls', 'endpoints', 'denied_accounts']);
  assert.ok(after.startsWith('{\n  "version": 2,\n  "urls": {},\n  "endpoints": {\n    "google_free": [\n      "'));
  assert.ok(after.endsWith('\n  "denied_accounts": [\n    "aa"\n  ]\n}\n'));
});

test('splice: 4-space indent, CRLF, compact arrays, no trailing newline, other position', () => {
  const before = '{\r\n    "endpoints": {},\r\n    "urls": {"a":"b"},\r\n    "list": [1,2,3]\r\n}';
  const after = spliceEndpoints(before, EP);
  assertOnlyEndpointsChanged(before, after);
  assert.ok(after.endsWith(',\r\n    "urls": {"a":"b"},\r\n    "list": [1,2,3]\r\n}'));
  assert.ok(!after.replace(/\r\n/g, '').includes('\n'), 'no bare LF in a CRLF file');
  assert.ok(after.includes('\r\n        "google_free": [\r\n            "'));
});

test('splice: no urls key appends last; empty object; brackets inside strings', () => {
  const a = '{"version":1,"note":"has } and ] and \\" inside"}';
  assertOnlyEndpointsChanged(a, spliceEndpoints(a, EP));
  const e = '{}';
  assert.deepEqual(JSON.parse(spliceEndpoints(e, EP)), { endpoints: EP });
});

test('splice: refuses a duplicate endpoints key and a non-object', () => {
  assert.throws(() => spliceEndpoints('{"endpoints":{},"endpoints":{}}', EP), /more than one/);
  assert.throws(() => spliceEndpoints('[1]', EP));
});

test('splice: the live manifest keeps every byte outside endpoints', () => {
  const live = readFileSync(path.join(HERE, '..', '..', 'url-overrides.json'), 'utf8');
  const after = spliceEndpoints(live, EP);
  assertOnlyEndpointsChanged(live, after);
  // Bytes before and after the endpoints value are the live file's own.
  const m = topLevelMembers(after).members.find((x) => x.key === 'endpoints');
  const prev = topLevelMembers(live).members.find((x) => x.key === 'endpoints');
  if (prev) {
    assert.equal(after.slice(0, m.valueStart), live.slice(0, prev.valueStart));
    assert.equal(after.slice(m.valueEnd), live.slice(prev.valueEnd));
  } else {
    // Inserted as `,<eol><indent>"endpoints": <value>` right after a value.
    const cut = after.lastIndexOf(',', m.keyStart);
    assert.equal(after.slice(0, cut) + after.slice(m.valueEnd), live);
  }
});

// ── Edge speech recognition ─────────────────────────────────────────────────

const EXPECT = catalog.single.edge_stt.expect;
const session = (extra) => ({ opened: true, ended: true, timedOut: false, code: 1000, phrases: [], ms: 1, ...extra });
const said = (...texts) => session({ phrases: texts.map((text) => ({ status: 'Success', text })) });

test('edge_stt: each class', () => {
  assert.equal(classifyEdgeStt(said(EXPECT), EXPECT).cls, 'ok');
  // Recognizer punctuation and casing drift is not a failure.
  assert.equal(classifyEdgeStt(said('hello everyone this is a quick speech recognition test for the chatbox'), EXPECT).cls, 'ok');
  assert.equal(classifyEdgeStt(said('Hello everyone, this is a quick', 'speech recognition test for the chat box.'), EXPECT).cls, 'ok');
  // Handshake refused (bad token, 403): Node reports close 1006 without ever opening.
  assert.equal(classifyEdgeStt(session({ opened: false, ended: false, code: 1006 }), EXPECT).cls, 'hard');
  assert.equal(classifyEdgeStt(session({ ended: false, code: 1006 }), EXPECT).cls, 'hard');
  assert.equal(classifyEdgeStt(session({ phrases: [] }), EXPECT).cls, 'hard');
  assert.equal(classifyEdgeStt(session({ phrases: [{ status: 'NoMatch', text: '' }] }), EXPECT).cls, 'hard');
  assert.equal(classifyEdgeStt(said('こんにちは皆さん'), EXPECT).cls, 'hard');
  assert.equal(classifyEdgeStt(said('hello everyone'), EXPECT).cls, 'hard');
  assert.equal(classifyEdgeStt(session({ timedOut: true, ended: false }), EXPECT).cls, 'soft');
  assert.equal(classifyEdgeStt(session({ opened: false, timedOut: true, ended: false }), EXPECT).cls, 'soft');
  assert.equal(classifyEdgeStt(session({ ended: false, code: 1011 }), EXPECT).cls, 'soft');
  assert.equal(classifyEdgeStt(session({ ended: false, code: 1013 }), EXPECT).cls, 'soft');
});

test('edge_stt: word overlap counts against the longer side', () => {
  assert.equal(wordOverlap('a b c d', 'a b c d'), 1);
  assert.equal(wordOverlap('a b c d', 'a b c d e f g h'), 0.5);
  assert.equal(wordOverlap('a a b', 'a b b'), 2 / 3);
  assert.equal(wordOverlap('a', ''), 0);
});

// Trimmed from edgeupdates.microsoft.com/api/products on 2026-10-16 (CVEs and
// Artifacts dropped). A second, older Windows x64 row is listed first to
// prove the pick is by version, not position.
const EDGE_PRODUCTS = [
  {
    Product: 'Stable',
    Releases: [
      { ReleaseId: 128293, Platform: 'MacOS', Architecture: 'universal', ProductVersion: '156.0.1.1' },
      { ReleaseId: 131000, Platform: 'Windows', Architecture: 'x64', ProductVersion: '155.0.4283.9' },
      { ReleaseId: 131500, Platform: 'Windows', Architecture: 'arm64', ProductVersion: '156.0.0.0' },
      {
        ReleaseId: 132222,
        Platform: 'Windows',
        Architecture: 'x64',
        SeverityLevel: 'None',
        ProductVersion: '155.0.4283.60',
        PublishedTime: '2026-10-15T20:49:00',
        ExpectedExpiryDate: '2027-10-15T20:22:00',
      },
    ],
  },
  { Product: 'Beta', Releases: [{ Platform: 'Windows', Architecture: 'x64', ProductVersion: '156.0.4300.1' }] },
];

test('edge_stt: newest Stable Windows x64 version', () => {
  assert.equal(edgeStableVersion(EDGE_PRODUCTS), '155.0.4283.60');
  assert.equal(edgeStableVersion([{ Product: 'Beta', Releases: [] }]), null);
  assert.equal(edgeStableVersion({ message: 'error' }), null);
});

// The top of rany2/edge-tts src/edge_tts/constants.py on 2026-10-16. Its
// `2-` version is the speech synthesis one and must not be taken.
const EDGE_TTS_CONSTANTS = `"""Constants for the edge_tts package."""

BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"

WSS_URL = f"wss://{BASE_URL}/edge/v1?TrustedClientToken={TRUSTED_CLIENT_TOKEN}"

CHROMIUM_FULL_VERSION = "143.0.3650.75"
SEC_MS_GEC_VERSION = f"2-{CHROMIUM_FULL_VERSION}"
`;

test('edge_stt: edge-tts token, and the candidates worth re-probing', () => {
  assert.equal(edgeTtsToken(EDGE_TTS_CONSTANTS), '6A5AA1D4EAFF4E9FB37E23D68491D6F4');
  assert.equal(edgeTtsToken(EDGE_TTS_CONSTANTS.replace(/\n/g, '\r\n')), '6A5AA1D4EAFF4E9FB37E23D68491D6F4');
  assert.equal(edgeTtsToken('TRUSTED_CLIENT_TOKEN = f"{x}"'), null);
  const cur = { version: '1-155.0.4283.60', token: 'A'.repeat(32) };
  assert.deepEqual(edgeSttCandidates(cur, { version: '1-156.0.1.2', token: 'B'.repeat(32) }), [
    { version: '1-156.0.1.2', token: 'A'.repeat(32) },
    { version: '1-155.0.4283.60', token: 'B'.repeat(32) },
    { version: '1-156.0.1.2', token: 'B'.repeat(32) },
  ]);
  assert.deepEqual(edgeSttCandidates(cur, { version: cur.version, token: null }), []);
  assert.deepEqual(edgeSttCandidates(cur, { version: null, token: 'B'.repeat(32) }), [
    { version: cur.version, token: 'B'.repeat(32) },
  ]);
});

test('edge_stt splice: replaces in place, every other byte identical', () => {
  const before =
    '{\n  "version": 2,\n  "edge_stt": {\n    "host": "speech.platform.bing.com",\n    "token": "OLD",\n    "version": "1-1.0.0.0",\n    "auth": "gec-query"\n  },\n  "x": [1,2]\n}\n';
  const after = spliceEdgeStt(before, { version: '1-155.0.4283.60' });
  assert.equal(after, before.replace('"1-1.0.0.0"', '"1-155.0.4283.60"'));
  const both = spliceEdgeStt(before, { version: '1-2.0.0.0', token: 'NEW' });
  assert.equal(both, before.replace('"1-1.0.0.0"', '"1-2.0.0.0"').replace('"OLD"', '"NEW"'));
  assert.equal(spliceEdgeStt(both, { version: '1-2.0.0.0', token: 'NEW' }), both, 'idempotent');
});

test('edge_stt splice: appends a missing field in the object style, CRLF and single line', () => {
  const crlf = '{\r\n    "edge_stt": {\r\n        "host": "h"\r\n    },\r\n    "z": 1\r\n}';
  assert.equal(
    spliceEdgeStt(crlf, { token: 'T' }),
    '{\r\n    "edge_stt": {\r\n        "host": "h",\r\n        "token": "T"\r\n    },\r\n    "z": 1\r\n}',
  );
  assert.equal(spliceEdgeStt('{"edge_stt": {"host": "h"}}', { version: 'V' }), '{"edge_stt": {"host": "h", "version": "V"}}');
  assert.deepEqual(JSON.parse(spliceEdgeStt('{"edge_stt": {}}', { token: 'T' })), { edge_stt: { token: 'T' } });
});

test('edge_stt splice: creates the object after endpoints, other keys untouched', () => {
  const before = '{\n  "version": 2,\n  "urls": {},\n  "endpoints": {\n    "a": ["b"]\n  },\n  "disabled_engines": []\n}\n';
  const after = spliceEdgeStt(before, { token: 'T' });
  assert.equal(
    after,
    '{\n  "version": 2,\n  "urls": {},\n  "endpoints": {\n    "a": ["b"]\n  },\n  "edge_stt": {\n    "token": "T"\n  },\n  "disabled_engines": []\n}\n',
  );
  assert.deepEqual(Object.keys(JSON.parse(spliceEdgeStt('{"urls":{},"y":1}', { version: 'V' }))), ['urls', 'edge_stt', 'y']);
});

test('edge_stt splice: writes only version and token, refuses a broken shape', () => {
  assert.throws(() => spliceEdgeStt('{}', { host: 'evil.example' }), /not writable/);
  assert.throws(() => spliceEdgeStt('{}', { token: '' }), /non-empty/);
  assert.throws(() => spliceEdgeStt('{"edge_stt": []}', { token: 'T' }), /not an object/);
  assert.throws(() => spliceEdgeStt('{"edge_stt": {}, "edge_stt": {}}', { token: 'T' }), /more than one/);
});

test('edge_stt splice: the live manifest keeps every byte outside the written fields', () => {
  const live = readFileSync(path.join(HERE, '..', '..', 'url-overrides.json'), 'utf8');
  const fields = { version: '1-155.0.4283.60', token: '6A5AA1D4EAFF4E9FB37E23D68491D6F4' };
  const after = spliceEdgeStt(live, fields);
  const b = JSON.parse(live);
  const a = JSON.parse(after);
  for (const k of Object.keys(b)) if (k !== 'edge_stt') assert.deepEqual(a[k], b[k]);
  assert.deepEqual(a.edge_stt, { ...(b.edge_stt || {}), ...fields });
  if (!b.edge_stt) {
    // Inserted as `,<eol><indent>"edge_stt": <value>` right after a value.
    const m = topLevelMembers(after).members.find((x) => x.key === 'edge_stt');
    const cut = after.lastIndexOf(',', m.keyStart);
    assert.equal(after.slice(0, cut) + after.slice(m.valueEnd), live);
  }
});

test('edge_stt: the committed clip is canonical 16 kHz mono s16 under 200 KB', () => {
  const wav = readFileSync(path.join(HERE, catalog.single.edge_stt.clip));
  assert.ok(wav.length < 200_000);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.toString('latin1', 36, 40), 'data');
  assert.deepEqual([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)], [1, 1, 16000, 16]);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
});
