'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../adapter/runner.js');

const spec = (over = {}) => ({
  read: true,
  vision: false,
  haAllowed: ['ha__HassTurnOn'],
  haDisallowed: [],
  schema: '{"type":"object"}',
  systemPrompt: 'be brief',
  model: 'gpt-6-astra',
  ...over,
});

const events = (decode, list) => list.flatMap((ev) => decode(ev));

test('a Home Assistant tool keeps one name in both directions', () => {
  assert.equal(runner.toolName('HassTurnOn'), 'ha__HassTurnOn');
  assert.equal(runner.toolBasename('ha__HassTurnOn'), 'HassTurnOn');
  assert.equal(runner.toolBasename('ha__'), null);
  assert.equal(runner.toolBasename('shell'), null);
  assert.equal(runner.toolBasename(42), null);
});

test('an allowed tool call becomes a use and a result', () => {
  const decode = runner.createDecoder(spec());
  const out = events(decode, [
    { type: 'item.started', item: { id: 'c1', type: 'mcp_tool_call', server: 'ha', tool: 'HassTurnOn' } },
    {
      type: 'item.completed',
      item: { id: 'c1', type: 'mcp_tool_call', server: 'ha', tool: 'HassTurnOn', status: 'completed' },
    },
  ]);
  assert.deepEqual(out, [
    { type: 'tool-use', id: 'c1', name: 'ha__HassTurnOn' },
    { type: 'tool-result', id: 'c1', isError: false },
  ]);
});

test('a completed turn carries the structured answer and the tokens', () => {
  const decode = runner.createDecoder(spec());
  const out = events(decode, [
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '{"text":"hello"}' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 400,
        cache_write_input_tokens: 5,
        output_tokens: 20,
        reasoning_output_tokens: 3,
      },
    },
  ]);
  assert.equal(out.length, 1);
  const result = out[0];
  assert.equal(result.type, 'result');
  assert.equal(result.isError, false);
  assert.deepEqual(result.structured, { text: 'hello' });
  assert.equal(result.text, 'hello');
  // No cost is reported anywhere by this CLI, and it names no turn count.
  assert.equal(result.costUsd, null);
  assert.equal(result.numTurns, null);
  // The cached tokens are part of input_tokens upstream; the core counts them apart.
  assert.deepEqual(result.tokens, [{
    model: 'gpt-6-astra', input: 600, output: 23, cacheRead: 400, cacheWrite: 5,
  }]);
});

test('a turn that ends without a JSON answer is an error result', () => {
  const decode = runner.createDecoder(spec());
  const out = events(decode, [
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'sorry' } },
    { type: 'turn.completed', usage: null },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].isError, true);
  assert.equal(out[0].deterministic, false);
});

test('a tool call outside the allowed list ends the run', () => {
  const decode = runner.createDecoder(spec());
  const out = events(decode, [
    { type: 'item.started', item: { id: 'c1', type: 'mcp_tool_call', server: 'ha', tool: 'HassTurnOff' } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'result');
  assert.equal(out[0].isError, true);
  // Nothing is reported after the run has ended.
  assert.deepEqual(decode({ type: 'turn.completed', usage: null }), []);
});

test('a failed turn is an error result', () => {
  const decode = runner.createDecoder(spec());
  const out = events(decode, [{ type: 'turn.failed', error: { message: 'model error' } }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].isError, true);
  assert.match(out[0].text, /model error/);
});

test('without a model the tokens are reported under an unknown one', () => {
  assert.deepEqual(
    runner.runTokens({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, ''),
    [{ model: 'unknown', input: 1, output: 5, cacheRead: 4, cacheWrite: 5 }],
  );
  assert.deepEqual(runner.runTokens(null, 'gpt-6-astra'), []);
});

test('a policy violation is not offered to the core as a retryable error', () => {
  const decode = runner.createDecoder(spec());
  const [result] = events(decode, [
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
  ]);
  assert.equal(result.type, 'result');
  assert.equal(result.isError, true);
  // The same request would try the same thing again, so it is not re-run.
  assert.equal(result.deterministic, true);
});

test('a turn that fails in the model is offered as a retryable error', () => {
  const decode = runner.createDecoder(spec());
  const [result] = events(decode, [{ type: 'turn.failed', error: { message: 'overloaded' } }]);
  assert.equal(result.deterministic, false);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A stand-in for /proc: a directory per live process, each holding a stat line
// in the real shape — the program name in brackets, then the fields, with the
// start time as field 22. Nothing here reads the machine's real processes.
function fakeProc(processes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proc-'));
  for (const [pid, started] of Object.entries(processes)) {
    const dir = path.join(root, String(pid));
    fs.mkdirSync(dir);
    // The fields after the program name, starting at the state (field 3), so
    // the start time (field 22) is at index 19 — the shape the reader expects.
    const fields = new Array(50).fill('0');
    fields[0] = 'S';
    fields[19] = String(started);
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (codex) ${fields.join(' ')}\n`);
  }
  return root;
}

function runRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
}

test('a live run of this process is never swept, however long it takes', () => {
  const procRoot = fakeProc({ 100: 777 });
  const root = runRoot();
  try {
    const a = runner.newRunDir(root, { self: 100, procRoot });
    const b = runner.newRunDir(root, { self: 100, procRoot });
    assert.notEqual(a, b);
    assert.ok(fs.existsSync(path.join(a, 'work')));
    // Age is not consulted at all: both runs are in flight.
    assert.deepEqual(runner.sweepRunDirs(root, { self: 100, procRoot }), []);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
    // The run ends. The directory is not deleted on the spot — the CLI child
    // may still be closing down in it — but the next sweep takes it.
    runner.endRun(a);
    assert.ok(fs.existsSync(a));
    assert.deepEqual(runner.sweepRunDirs(root, { self: 100, procRoot }), [a]);
    assert.ok(!fs.existsSync(a));
    assert.ok(fs.existsSync(b), 'the run still in flight is untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
});

// The one-shot question is its own process, and the console sweeps at every
// start. A directory must therefore belong to somebody from the instant it
// exists — which is why the owner is in the name, written by the single call
// that creates it, and not in a file written afterwards.
test('a directory another process just created is never swept', () => {
  const procRoot = fakeProc({ 100: 777, 200: 888 });
  const root = runRoot();
  try {
    const theirs = runner.newRunDir(root, { self: 200, procRoot });
    // The console sweeps, knowing nothing of that run: it is not in its live
    // set, and no file inside the directory is read.
    assert.deepEqual(runner.sweepRunDirs(root, { self: 100, procRoot }), []);
    assert.ok(fs.existsSync(theirs));
    assert.ok(fs.existsSync(path.join(theirs, 'work')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
});

test('a directory is swept only when its owner is provably gone', () => {
  const procRoot = fakeProc({ 100: 777, 200: 888 });
  const root = runRoot();
  try {
    const gone = path.join(root, 'run-300-999-aaa');      // pid 300 does not exist
    const reused = path.join(root, 'run-200-111-bbb');    // pid 200 exists, started later
    const alive = path.join(root, 'run-200-888-ccc');     // pid 200, the same process
    const nameless = path.join(root, 'something-else');   // not a run directory at all
    const unreadable = path.join(root, 'run-abc-def-ddd'); // a name this cannot read
    for (const dir of [gone, reused, alive, nameless, unreadable]) fs.mkdirSync(dir);

    const removed = runner.sweepRunDirs(root, { self: 100, procRoot }).sort();
    assert.deepEqual(removed, [gone, reused].sort());
    assert.ok(fs.existsSync(alive), 'the owner is still running');
    assert.ok(fs.existsSync(nameless), 'not a run directory, not ours to remove');
    assert.ok(fs.existsSync(unreadable), 'a name that says nothing is not permission to delete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
});

// After a container restart /data still holds the directories, and pids start
// again from small numbers, so a stale pid can match a live process.
test('the same pid started at another time is a different process', () => {
  const procRoot = fakeProc({ 7: 500 });
  assert.equal(runner.ownerIsGone('run-7-500-x', { self: 1, procRoot }), false);
  assert.equal(runner.ownerIsGone('run-7-499-x', { self: 1, procRoot }), true);
  // Our own directory that is not live is a run of ours that has ended.
  assert.equal(runner.ownerIsGone('run-7-500-x', { self: 7, procRoot }), true);
});

test('what cannot be read is never treated as gone', () => {
  const procRoot = fakeProc({ 7: 500 });
  const missingProc = path.join(procRoot, 'no-such-proc');
  // No /proc to ask: every directory is kept.
  assert.equal(runner.ownerIsGone('run-7-500-x', { self: 1, procRoot: missingProc }), true,
    'a missing process directory means gone');
  assert.equal(runner.processStart(7, procRoot), '500');
  assert.equal(runner.processStart(8, procRoot), 'gone');
  // A stat line in a shape this does not know answers "cannot tell", and a
  // directory whose owner cannot be told about is kept.
  fs.writeFileSync(path.join(procRoot, '7', 'stat'), 'nonsense without a bracket\n');
  assert.equal(runner.processStart(7, procRoot), null);
  assert.equal(runner.ownerIsGone('run-7-500-x', { self: 1, procRoot }), false);
  fs.rmSync(procRoot, { recursive: true, force: true });
});

test('a process whose start time cannot be read names its directories unsweepably', () => {
  const procRoot = fakeProc({});
  const root = runRoot();
  try {
    const dir = runner.newRunDir(root, { self: 100, procRoot });
    assert.match(path.basename(dir), /^run-100-unknown-/);
    runner.endRun(dir);
    // Nothing can prove such an owner gone, so nothing removes it while this
    // process lives; it is cleared when the directory is asked about by a
    // process that can read start times.
    assert.deepEqual(runner.sweepRunDirs(root, { self: 100, procRoot }), []);
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
});

test('the one-shot question removes its own directory once its child has exited', () => {
  const procRoot = fakeProc({ 100: 777 });
  const root = runRoot();
  try {
    const dir = runner.newRunDir(root, { self: 100, procRoot });
    runner.removeRunDir(dir);
    assert.ok(!fs.existsSync(dir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
});
