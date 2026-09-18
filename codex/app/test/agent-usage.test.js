'use strict';

// agent-usage against the core's parser protocol, with the line shapes the CLI
// really writes (measured on 0.154.0): a turn_context naming the model,
// token_usage_record lines carrying ONE response's usage, and a token_count
// line carrying running totals, which must not be counted again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'bin', 'agent-usage');

const TURN_CONTEXT = {
  timestamp: '2026-09-16T14:55:39.813Z',
  type: 'turn_context',
  payload: { turn_id: 't1', model: 'gpt-6-astra' },
};
const RECORD = {
  timestamp: '2026-09-16T14:55:41.463Z',
  type: 'token_usage_record',
  payload: {
    turn_id: 't1',
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      cache_write_input_tokens: 5,
      output_tokens: 20,
      reasoning_output_tokens: 3,
      total_tokens: 1023,
    },
  },
};
const RUNNING_TOTALS = {
  timestamp: '2026-09-16T14:55:41.467Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 20 } } },
};

function run(args, { input = '', env = {} } = {}) {
  const out = spawnSync(SCRIPT, args, { input, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function parse(messages) {
  const text = run(['--parse'], { input: `${messages.map((m) => JSON.stringify(m)).join('\n')}\n` });
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

test('one response is one record, and the running totals are ignored', () => {
  const answers = parse([
    ['S', 'f1', null],
    ['L', JSON.stringify(TURN_CONTEXT)],
    ['L', JSON.stringify(RECORD)],
    ['L', JSON.stringify(RUNNING_TOTALS)],
    ['E', 'f1'],
  ]);
  assert.equal(answers[0], null);
  assert.deepEqual(answers[1], []);
  assert.deepEqual(answers[2], [{
    day: '2026-09-16',
    model: 'gpt-6-astra',
    // The cached tokens are part of input_tokens upstream; the core counts
    // fresh input only. Reasoning tokens are billed as output.
    input: 600,
    output: 23,
    cache_read: 400,
    cache_write: 5,
  }]);
  assert.deepEqual(answers[3], []);
  assert.deepEqual(answers[4], { state: { turns: { t1: 'gpt-6-astra' } } });
});

test('the state carries the model of a turn whose context was read last time', () => {
  const later = {
    timestamp: '2026-09-17T09:00:00.000Z',
    type: 'token_usage_record',
    payload: { turn_id: 't1', usage: { input_tokens: 10, output_tokens: 1 } },
  };
  const answers = parse([
    ['S', 'f1', { turns: { t1: 'gpt-6-astra' } }],
    ['L', JSON.stringify(later)],
    ['E', 'f1'],
  ]);
  assert.deepEqual(answers[1], [{
    day: '2026-09-17', model: 'gpt-6-astra', input: 10, output: 1, cache_read: 0, cache_write: 0,
  }]);
});

test('a record whose model was never declared is counted under an unknown model', () => {
  const answers = parse([
    ['S', 'f1', null],
    ['L', JSON.stringify({ ...RECORD, payload: { ...RECORD.payload, turn_id: 'other' } })],
    ['E', 'f1'],
  ]);
  assert.equal(answers[1][0].model, 'unknown');
});

test('a line that is not JSON, and one of another type, yield no record', () => {
  const answers = parse([
    ['S', 'f1', null],
    ['L', '{"type":"token_usage_record" not json'],
    ['L', JSON.stringify({ type: 'thread.started', payload: { thread_id: 'x' } })],
    ['E', 'f1'],
  ]);
  assert.deepEqual(answers[1], []);
  assert.deepEqual(answers[2], []);
});

test('--files lists the session files and --source names their directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  try {
    const day = path.join(home, 'sessions', '2026', '09', '16');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), '');
    fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), '');
    fs.writeFileSync(path.join(day, 'notes.txt'), '');
    const files = run(['--files'], { env: { CODEX_HOME: home } }).split('\0').filter(Boolean);
    assert.deepEqual(files, [path.join(day, 'rollout-a.jsonl'), path.join(day, 'rollout-b.jsonl')]);
    assert.equal(run(['--source'], { env: { CODEX_HOME: home } }).trim(), path.join(home, 'sessions'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
