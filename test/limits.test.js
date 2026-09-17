'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  normalizeRateLimits, accountMode, readAccountLimits, credentialEpoch, bucketSuffix,
} = require('../codex/app/adapter/limits.js');

const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rate-limits-0.154.0.json'), 'utf8'));

const win = (usedPercent, windowDurationMins, resetsAt = 1790001602) => ({ usedPercent, windowDurationMins, resetsAt });
const single = (bucket) => ({ rateLimits: { limitId: 'codex', limitName: null, primary: null, secondary: null, ...bucket } });

test('the recorded answer gives one entry per window, named by duration and bucket', () => {
  assert.deepEqual(normalizeRateLimits(RECORDED), [
    { kind: 'weekly_all', percent: 40, severity: null, resets_at: '2026-09-21T14:40:02.000Z', model: null },
    { kind: 'session_codex_bengalfox', percent: 0, severity: null, resets_at: '2026-09-17T11:01:48.000Z', model: 'GPT-5.3-Codex-Spark' },
    { kind: 'weekly_codex_bengalfox', percent: 0, severity: null, resets_at: '2026-09-21T14:13:08.000Z', model: 'GPT-5.3-Codex-Spark' },
  ]);
});

test('the per-bucket view is used alone, never together with the single view', () => {
  const kinds = normalizeRateLimits(RECORDED).map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'weekly_all').length, 1);
  const { rateLimitsByLimitId: _drop, ...onlySingle } = RECORDED;
  assert.deepEqual(normalizeRateLimits(onlySingle).map((e) => e.kind), ['weekly_all']);
  assert.deepEqual(normalizeRateLimits({ ...onlySingle, rateLimitsByLimitId: {} }).map((e) => e.kind), ['weekly_all']);
});

test('the account bucket maps by duration, whichever window carries it', () => {
  assert.deepEqual(normalizeRateLimits(single({ primary: win(12.4, 300), secondary: win(50.5, 10080) }))
    .map((e) => [e.kind, e.percent]), [['session', 12], ['weekly_all', 51]]);
  assert.deepEqual(normalizeRateLimits(single({ primary: win(1, 10080), secondary: win(2, 300) }))
    .map((e) => e.kind), ['weekly_all', 'session']);
  assert.deepEqual(normalizeRateLimits(single({ primary: win(3, 60) })).map((e) => e.kind), ['window_60m']);
  assert.deepEqual(normalizeRateLimits(single({})), []);
});

test('other buckets never collide with the account bucket or with each other', () => {
  const r = normalizeRateLimits({ rateLimitsByLimitId: {
    'a-b': { limitId: 'a-b', primary: win(1, 300) },
    a_b: { limitId: 'a_b', primary: win(2, 300) },
    Codex: { limitId: 'Codex', primary: win(3, 300) },
  } });
  const kinds = r.map((e) => e.kind);
  assert.equal(new Set(kinds).size, 3);
  assert.equal(kinds[1], 'session_a_b');
  assert.match(kinds[0], /^session_a_b_[0-9a-f]{6}$/);
  assert.match(kinds[2], /^session_codex_[0-9a-f]{6}$/);
  assert.ok(!kinds.includes('session'));
  assert.deepEqual(normalizeRateLimits({ rateLimitsByLimitId: { x: { limitId: 'x', primary: win(1, 1440) } } })
    .map((e) => e.kind), ['window_1440m_x']);
  assert.equal(bucketSuffix('codex_x1'), 'codex_x1');
  assert.match(bucketSuffix('---'), /^[0-9a-f]{6}$/);
});

test('the account bucket is never a model, whatever its label says', () => {
  assert.equal(normalizeRateLimits(single({ limitName: 'Codex', primary: win(1, 300) }))[0].model, null);
});

test('a bucket without its own label has no model; a label is never taken from the id', () => {
  const r = normalizeRateLimits({ rateLimitsByLimitId: { gpt_x: { limitId: 'gpt_x', limitName: null, primary: win(1, 10080) } } });
  assert.deepEqual(r, [{ kind: 'weekly_gpt_x', percent: 1, severity: null, resets_at: '2026-09-21T14:40:02.000Z', model: null }]);
});

test('a payload that is not what it claims gives nothing rather than a guess', () => {
  for (const bad of [
    null, {}, { rateLimits: 'x' },
    single({ primary: win(101, 300) }),
    single({ primary: win(-1, 300) }),
    single({ primary: win(Number.NaN, 300) }),
    single({ primary: win(/** @type {any} */ ('5'), 300) }),
    single({ primary: win(5, 0) }),
    single({ primary: win(5, 12.5) }),
    single({ primary: win(5, 300, -3) }),
    single({ primary: win(5, 300, /** @type {any} */ ('soon')) }),
    single({ primary: 'x' }),
    single({ primary: win(1, 300), secondary: win(2, 300) }),
    { rateLimitsByLimitId: { x: null } },
    { rateLimitsByLimitId: { '': { limitId: '', primary: win(1, 300) } } },
  ]) {
    assert.equal(normalizeRateLimits(bad), null, JSON.stringify(bad));
  }
});

test('a window without a reset time keeps its figure', () => {
  assert.deepEqual(normalizeRateLimits(single({ primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: null } })),
    [{ kind: 'session', percent: 9, severity: null, resets_at: null, model: null }]);
});

test('the login type decides the mode', () => {
  assert.equal(accountMode({ account: { type: 'chatgpt', email: 'someone@example.com' } }), 'subscription');
  assert.equal(accountMode({ account: { type: 'apiKey' } }), 'api_key');
  assert.equal(accountMode({ account: null, requiresOpenaiAuth: true }), null);
  assert.equal(accountMode({ account: { type: 'other' } }), null);
  assert.equal(accountMode(undefined), null);
});

// A stand-in for `codex app-server`: answers each request with the scripted
// reply for its method (a function of the request, or undefined for silence).
function fakeServer(replies, { failSpawn = false, emitError = false } = {}) {
  const calls = { spawned: [], requests: [], killed: 0 };
  const spawnFn = (bin, args, opts) => {
    if (failSpawn) throw new Error('spawn failed');
    calls.spawned.push({ bin, args, opts });
    const child = /** @type {any} */ (new EventEmitter());
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.pid = undefined;
    child.kill = () => { calls.killed += 1; };
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        calls.requests.push(msg.method);
        const reply = replies[msg.method];
        const body = typeof reply === 'function' ? reply(msg) : undefined;
        if (body !== undefined) child.stdout.write(`${JSON.stringify({ id: msg.id, ...body })}\n`);
      }
    });
    if (emitError) setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  return { spawnFn, calls };
}

const INIT = { initialize: () => ({ result: { userAgent: 'x' } }) };
const opts = (spawnFn, extra = {}) => ({ bin: '/data/npm/bin/codex', codexHome: '/data/codex-prompt', env: { PATH: '/usr/bin' }, spawnFn, ...extra });

test('a subscription login reports its limits and the child is stopped', async () => {
  const { spawnFn, calls } = fakeServer({
    ...INIT,
    'account/read': () => ({ result: { account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' } } }),
    'account/rateLimits/read': () => ({ result: RECORDED }),
  });
  const r = await readAccountLimits(opts(spawnFn));
  assert.deepEqual(r, { mode: 'subscription', limits: normalizeRateLimits(RECORDED) });
  assert.ok(!JSON.stringify(r).includes('@'), 'no identity in the result');
  assert.deepEqual(calls.requests, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(calls.spawned[0].args, ['app-server']);
  assert.equal(calls.spawned[0].opts.env.CODEX_HOME, '/data/codex-prompt');
  assert.equal(calls.spawned[0].opts.env.PATH, '/usr/bin');
  assert.equal(calls.killed, 1);
});

test('an API-key login has no subscription limits', async () => {
  const { spawnFn } = fakeServer({
    ...INIT,
    'account/read': () => ({ result: { account: { type: 'apiKey' } } }),
    'account/rateLimits/read': () => ({ error: { code: -32600, message: 'not a subscription' } }),
  });
  assert.deepEqual(await readAccountLimits(opts(spawnFn)), { mode: 'api_key', limits: [] });
});

test('no login, a failed read, a bad payload or silence give null', async () => {
  const cases = [
    { ...INIT, 'account/read': () => ({ result: { account: null } }), 'account/rateLimits/read': () => ({ error: { code: -32600, message: 'codex account authentication required to read rate limits' } }) },
    { ...INIT, 'account/read': () => ({ result: { account: { type: 'chatgpt' } } }), 'account/rateLimits/read': () => ({ error: { code: -1, message: 'x' } }) },
    { ...INIT, 'account/read': () => ({ result: { account: { type: 'chatgpt' } } }), 'account/rateLimits/read': () => ({ result: { rateLimits: 'x' } }) },
    { ...INIT, 'account/read': () => ({ error: { code: -1, message: 'x' } }) },
    { initialize: () => ({ error: { code: -1, message: 'x' } }) },
    { ...INIT },
    {},
  ];
  for (const replies of cases) {
    const { spawnFn, calls } = fakeServer(replies);
    assert.equal(await readAccountLimits(opts(spawnFn, { timeoutMs: 50 })), null, Object.keys(replies).join());
    assert.equal(calls.killed, 1);
  }
});

test('a missing executable gives null', async () => {
  assert.equal(await readAccountLimits(opts(fakeServer({}, { failSpawn: true }).spawnFn)), null);
  assert.equal(await readAccountLimits(opts(fakeServer({}, { emitError: true }).spawnFn, { timeoutMs: 1000 })), null);
});

test('lines that are not protocol messages are skipped', async () => {
  const { spawnFn } = fakeServer({
    initialize: () => ({ result: {} }),
    'account/read': () => ({ result: { account: { type: 'apiKey' } } }),
  });
  const wrapped = (...a) => {
    const child = spawnFn(...a);
    child.stdout.write('not json\n{"method":"configWarning","params":{}}\n');
    return child;
  };
  assert.deepEqual(await readAccountLimits(opts(wrapped)), { mode: 'api_key', limits: [] });
});

test('the credential epoch tells logins apart without revealing them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-epoch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(credentialEpoch(dir), '');
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"tokens":{"access_token":"aaa"}}');
  const first = credentialEpoch(dir);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(credentialEpoch(dir), first);
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"tokens":{"access_token":"bbb"}}');
  assert.notEqual(credentialEpoch(dir), first);
});
