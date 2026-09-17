'use strict';

// Account-wide usage limits of the Codex login, for /api/account_limits.
//
// Read from `codex app-server` (`account/read` + `account/rateLimits/read`),
// which answers without starting a model turn. The answer is normalized to the
// core's entries { kind, percent, severity, resets_at, model }:
//
// - a window is named by its duration, never by its position: the CLI's
//   "primary" window is sometimes the weekly one;
// - the account-wide bucket gives `session` (5 h) and `weekly_all` (7 days);
//   any other bucket gets kinds qualified by its own id, so two buckets can
//   never produce the same entity;
// - `model` is the bucket's own label when the CLI gives one, otherwise null;
// - an API-key login has no subscription limits: mode `api_key`, no entries.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ACCOUNT_BUCKET = 'codex';
const SESSION_MINS = 300;
const WEEK_MINS = 10080;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_LINE_BYTES = 1024 * 1024;

function windowBase(mins) {
  if (mins === SESSION_MINS) return 'session';
  if (mins === WEEK_MINS) return 'weekly';
  return `window_${mins}m`;
}

// A bucket id as a kind suffix. Ids that are not already plain get a short
// digest of the raw id, so two ids that differ only in punctuation stay apart.
function bucketSuffix(id) {
  const plain = id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (plain === id && plain !== '') return plain;
  const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 6);
  return plain ? `${plain}_${digest}` : digest;
}

function windowEntry(win, kind, model) {
  if (win === null || win === undefined) return undefined; // absent window
  if (typeof win !== 'object') return null;
  const mins = win.windowDurationMins;
  if (!Number.isInteger(mins) || mins <= 0) return null;
  if (!Number.isFinite(win.usedPercent)) return null;
  const percent = Math.round(win.usedPercent);
  if (percent < 0 || percent > 100) return null;
  let resetsAt = null;
  if (win.resetsAt !== null && win.resetsAt !== undefined) {
    if (!Number.isFinite(win.resetsAt) || win.resetsAt <= 0) return null;
    resetsAt = new Date(win.resetsAt * 1000).toISOString();
  }
  return { kind: kind(mins), percent, severity: null, resets_at: resetsAt, model };
}

function bucketEntries(bucket, key) {
  if (!bucket || typeof bucket !== 'object') return null;
  const id = typeof bucket.limitId === 'string' && bucket.limitId !== '' ? bucket.limitId : key;
  if (typeof id !== 'string' || id === '') return null;
  const account = id === ACCOUNT_BUCKET;
  const model = !account && typeof bucket.limitName === 'string' && bucket.limitName !== '' ? bucket.limitName : null;
  const kind = account
    ? (mins) => (mins === WEEK_MINS ? 'weekly_all' : windowBase(mins))
    : (mins) => `${windowBase(mins)}_${bucketSuffix(id)}`;
  const entries = [];
  for (const win of [bucket.primary, bucket.secondary]) {
    const entry = windowEntry(win, kind, model);
    if (entry === null) return null;
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * `account/rateLimits/read` result → entries, or null when the payload is not
 * what it claims to be (then nothing is reported rather than a guess).
 */
function normalizeRateLimits(result) {
  if (!result || typeof result !== 'object') return null;
  const byId = result.rateLimitsByLimitId;
  let buckets;
  if (byId && typeof byId === 'object' && !Array.isArray(byId) && Object.keys(byId).length > 0) {
    buckets = Object.entries(byId);
  } else if (result.rateLimits && typeof result.rateLimits === 'object') {
    buckets = [[result.rateLimits.limitId, result.rateLimits]];
  } else {
    return null;
  }
  const entries = [];
  for (const [key, bucket] of buckets) {
    const list = bucketEntries(bucket, key);
    if (list === null) return null;
    entries.push(...list);
  }
  const kinds = new Set(entries.map((e) => e.kind));
  if (kinds.size !== entries.length) return null;
  return entries;
}

// `account/read` result → 'subscription' | 'api_key' | null (not logged in or
// an account type this module does not know).
function accountMode(result) {
  const type = result && result.account && result.account.type;
  if (type === 'chatgpt') return 'subscription';
  if (type === 'apiKey') return 'api_key';
  return null;
}

/**
 * Asks a short-lived app-server for the login type and, for a subscription,
 * the limits. Resolves to { mode, limits } or null; never rejects, never keeps
 * the account's identity (the answer to account/read carries an e-mail).
 *
 * @param {object} o
 * @param {string} o.bin         the codex executable
 * @param {string} o.codexHome   CODEX_HOME to read the login from
 * @param {Record<string,string>} [o.env]  base environment (PATH etc.)
 * @param {number} [o.timeoutMs]
 * @param {typeof spawn} [o.spawnFn]  for tests
 */
function readAccountLimits({ bin, codexHome, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(bin, ['app-server'], {
        env: { ...env, CODEX_HOME: codexHome },
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let mode;
    let limits;
    let buf = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        finish(null);
      }
    };
    const settle = () => {
      if (mode === undefined) return;
      if (mode === null) return finish(null);
      if (mode === 'api_key') return finish({ mode, limits: [] });
      if (limits === undefined) return;
      finish(limits === null ? null : { mode, limits });
    };
    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id === 1) {
        if (msg.error) return finish(null);
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/read', params: {} });
        send({ id: 3, method: 'account/rateLimits/read' });
      } else if (msg.id === 2) {
        mode = msg.error ? null : accountMode(msg.result);
        settle();
      } else if (msg.id === 3) {
        limits = msg.error ? null : normalizeRateLimits(msg.result);
        settle();
      }
    };
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES && !buf.includes('\n')) return finish(null);
      let i;
      while (!settled && (i = buf.indexOf('\n')) >= 0) {
        const lineText = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(lineText);
        } catch {
          continue; // not a protocol line
        }
        onMessage(msg);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-ha-addon', version: '1' } } });
  });
}

/**
 * Which login the figures belong to, without the login itself: a short digest
 * of the stored credentials, '' when there are none. A cache keyed on it never
 * serves one account's figures after a re-login to another.
 */
function credentialEpoch(codexHome) {
  let data;
  try {
    data = fs.readFileSync(path.join(codexHome, 'auth.json'));
  } catch {
    return '';
  }
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
}

module.exports = { normalizeRateLimits, accountMode, readAccountLimits, credentialEpoch, bucketSuffix };
