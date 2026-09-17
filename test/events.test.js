'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDecoder, normalizeUsage, isKnownWarning } = require('../codex/app/adapter/events.js');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'exec', `${name}.jsonl`), 'utf8').split('\n');
}

function decode(lines, exitCode = 0, opts) {
  const d = createDecoder(opts);
  const events = lines.flatMap((l) => d.line(typeof l === 'string' ? l : JSON.stringify(l)));
  return { events, outcome: d.end(exitCode) };
}

const START = [{ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' }];
const DONE = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 2 } };
const FINAL = { type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: '{"text":"ok","proposal":null}' } };
const mcp = (phase, id, server, tool, extra = {}) => ({
  type: `item.${phase}`,
  item: { id, type: 'mcp_tool_call', server, tool, arguments: {}, result: null, error: null, status: phase === 'started' ? 'in_progress' : 'completed', ...extra },
});

test('a write run that called its allowed tool succeeds with the schema answer (recorded run)', () => {
  const { events, outcome } = decode(fixture('write-ha-call'));
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.final, { text: 'Could not call: ha_write. Called ha_read with note "r".', markers: [] });
  assert.deepEqual(outcome.toolsUsed, ['ha_read']);
  assert.deepEqual(outcome.toolCalls, [{ server: 'ha', tool: 'ha_read', status: 'completed', error: null }]);
  assert.equal(outcome.mcpFailed, false);
  assert.deepEqual(outcome.usage, { input: 19044 - 9216, cacheRead: 9216, cacheWrite: 0, output: 170, reasoning: 0 });
  assert.equal(outcome.costUsd, null);
  assert.equal(outcome.reportedModel, null);
  assert.equal(outcome.numTurns, null);
  assert.equal(outcome.threadId, '01a0adf2-de09-7610-a994-1046425ea1c7');
  assert.deepEqual(events.map((e) => e.kind), ['message', 'tool-start', 'tool-result', 'message', 'usage']);
});

test('a plain read run succeeds (recorded run)', () => {
  const { outcome } = decode(fixture('read-plain'));
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.final, { text: 'Hello!', markers: [] });
  assert.deepEqual(outcome.toolsUsed, []);
  assert.equal(outcome.mcpFailed, false);
});

test('a failed turn is a failure even though the process may exit 0 (recorded run)', () => {
  const { outcome } = decode(fixture('turn-failed-schema'), 0);
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.reason, 'cli_error');
  assert.match(outcome.message, /invalid_json_schema/);
  const onlyTurnFailed = fixture('turn-failed-schema').filter((l) => !l.startsWith('{"type":"error"'));
  assert.equal(decode(onlyTurnFailed, 1).outcome.reason, 'turn_failed');
});

for (const [name, what] of [['command-execution', 'command_execution'], ['file-change', 'file_change'], ['web-search', 'web_search']]) {
  test(`a ${what} item is a policy violation (recorded run)`, () => {
    const { outcome } = decode(fixture(name));
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.reason, 'policy');
    assert.match(outcome.message, new RegExp(what));
  });
}

test('a refused tool call is reported as failed, not as used (recorded run)', () => {
  const { outcome } = decode(fixture('mcp-call-refused'));
  assert.deepEqual(outcome.toolsUsed, ['ha_other', 'ha_read']);
  assert.equal(outcome.mcpFailed, true);
  assert.deepEqual(outcome.toolCalls[0], {
    server: 'ha', tool: 'ha_write', status: 'failed', error: 'MCP tool call requires approval, but approval policy is never',
  });
  // That run's answer was prose, not the schema answer.
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.reason, 'no_result');
});

test('the hook-trust warning is a warning; every other error item is a failure', () => {
  const warnings = fixture('hook-bypass-warning')
    .filter((l) => l.includes('"type":"error"'))
    .map((l) => JSON.parse(l).item.message);
  assert.equal(warnings.length, 2);
  for (const w of warnings) assert.ok(isKnownWarning(w));
  const { events, outcome } = decode([...START, ...warnings.map((message, i) => ({ type: 'item.completed', item: { id: `item_${i}`, type: 'error', message } })), FINAL, DONE]);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.warnings.length, 2);
  assert.equal(events.filter((e) => e.kind === 'warning').length, 2);

  const deprecated = '`[features].web_search_request` is deprecated because web search is enabled by default. (Set `web_search` to `"live"`.)';
  assert.ok(isKnownWarning(deprecated));
  for (const message of [
    'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
    'stream disconnected before completion',
    `${warnings[0]} And something else.`,
    `x ${deprecated}`,
  ]) {
    const r = decode([...START, { type: 'item.completed', item: { id: 'e', type: 'error', message } }, FINAL, DONE]).outcome;
    assert.equal(r.status, 'error', message);
    assert.equal(r.reason, 'cli_error');
  }
});

test('success needs a completed turn, exit status 0 and a JSON object answer', () => {
  assert.equal(decode([...START, FINAL, DONE]).outcome.status, 'ok');
  assert.equal(decode([...START, FINAL]).outcome.reason, 'incomplete');
  assert.equal(decode([...START, FINAL, DONE], 1).outcome.reason, 'exit');
  assert.equal(decode([...START, FINAL, DONE], null).outcome.reason, 'exit');
  assert.equal(decode([...START, DONE]).outcome.reason, 'no_result');
  for (const text of ['plain words', '[1,2]', 'null', '"s"', '{"text":']) {
    const item = { type: 'item.completed', item: { id: 'x', type: 'agent_message', text } };
    assert.equal(decode([...START, item, DONE]).outcome.reason, 'no_result', text);
  }
});

test('the last agent message is the answer', () => {
  const early = { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Let me check.' } };
  const { outcome } = decode([...START, early, FINAL, DONE]);
  assert.deepEqual(outcome.final, { text: 'ok', proposal: null });
});

test('only the Home Assistant server counts as ours', () => {
  const decoy = decode([...START, mcp('started', 'i1', 'decoy', 'ha_read'), mcp('completed', 'i1', 'decoy', 'ha_read'), FINAL, DONE]).outcome;
  assert.equal(decoy.status, 'error');
  assert.equal(decoy.reason, 'policy');
  assert.deepEqual(decoy.toolsUsed, []);
  const renamed = decode([...START, mcp('completed', 'i1', 'home', 'x'), FINAL, DONE], 0, { haServer: 'home' }).outcome;
  assert.equal(renamed.status, 'ok');
  assert.deepEqual(renamed.toolsUsed, ['x']);
  assert.equal(decode([...START, mcp('completed', 'i1', 'ha', ''), FINAL, DONE]).outcome.reason, 'policy');
});

test('the CLI resource-listing tools are neither a violation nor a Home Assistant call', () => {
  const { events, outcome } = decode([...START,
    mcp('started', 'i1', 'codex', 'list_mcp_resources'), mcp('completed', 'i1', 'codex', 'list_mcp_resources'),
    FINAL, DONE]);
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.toolCalls, []);
  assert.ok(events.every((e) => e.kind !== 'tool-result' || e.builtin === true));
  const other = decode([...START, mcp('completed', 'i1', 'codex', 'shell'), FINAL, DONE]).outcome;
  assert.equal(other.reason, 'policy');
});

test('an unknown item type is a violation; an unknown event type proves nothing', () => {
  const unknownItem = { type: 'item.completed', item: { id: 'z', type: 'code_interpreter', code: 'x' } };
  assert.equal(decode([...START, unknownItem, FINAL, DONE]).outcome.reason, 'policy');
  const updated = { type: 'item.updated', item: { id: 'z', type: 'command_execution', command: 'ls' } };
  assert.equal(decode([...START, updated, FINAL, DONE]).outcome.reason, 'policy');
  const reasoning = { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: '...' } };
  const newEvent = { type: 'thread.renamed', name: 'x' };
  assert.equal(decode([...START, reasoning, newEvent, FINAL, DONE]).outcome.status, 'ok');
  assert.equal(decode([...START, newEvent, FINAL]).outcome.reason, 'incomplete');
  assert.equal(decode([...START, { type: 'item.completed', item: { id: 'q' } }, FINAL, DONE]).outcome.reason, 'protocol');
});

test('output that is not JSON events fails the run', () => {
  assert.equal(decode([...START, 'not json', FINAL, DONE]).outcome.reason, 'protocol');
  assert.equal(decode([...START, '42', FINAL, DONE]).outcome.reason, 'protocol');
  assert.equal(decode([...START, '', '   ', FINAL, DONE]).outcome.status, 'ok');
});

test('the first failure is the one reported', () => {
  const { outcome } = decode([...START, { type: 'error', message: 'first' }, { type: 'turn.failed', error: { message: 'second' } }]);
  assert.equal(outcome.reason, 'cli_error');
  assert.equal(outcome.message, 'first');
});

test('usage separates cached input and tolerates missing or odd counts', () => {
  assert.deepEqual(normalizeUsage(DONE.usage), { input: 60, cacheRead: 40, cacheWrite: 0, output: 7, reasoning: 2 });
  assert.deepEqual(normalizeUsage({ input_tokens: 5, cached_input_tokens: 9 }), { input: 0, cacheRead: 5, cacheWrite: 0, output: 0, reasoning: 0 });
  assert.deepEqual(normalizeUsage({ input_tokens: -1, output_tokens: 1.5 }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  assert.equal(normalizeUsage(null), null);
  const sparse = decode([...START, FINAL, { type: 'turn.completed' }]).outcome;
  assert.equal(sparse.status, 'ok');
  assert.equal(sparse.usage, null);
});

test('a call keeps its identity and ends once', () => {
  const swapped = decode([...START, mcp('started', 'x', 'ha', 'HassTurnOn'), mcp('completed', 'x', 'ha', 'GetLiveContext'), FINAL, DONE]).outcome;
  assert.equal(swapped.status, 'error');
  assert.equal(swapped.reason, 'protocol');
  assert.deepEqual(swapped.toolsUsed, []);
  const otherServer = decode([...START, mcp('started', 'x', 'codex', 'list_mcp_resources'), mcp('completed', 'x', 'ha', 'HassTurnOn'), FINAL, DONE]).outcome;
  assert.equal(otherServer.reason, 'protocol');
  const failedThenOk = decode([...START, mcp('started', 'x', 'ha', 'HassTurnOn'),
    mcp('completed', 'x', 'ha', 'HassTurnOn', { status: 'failed', error: { message: 'denied' } }),
    mcp('completed', 'x', 'ha', 'HassTurnOn'), FINAL, DONE]).outcome;
  assert.equal(failedThenOk.status, 'error');
  assert.equal(failedThenOk.reason, 'protocol');
  assert.equal(failedThenOk.mcpFailed, true);
  assert.deepEqual(failedThenOk.toolsUsed, []);
  const twice = decode([...START, mcp('completed', 'x', 'ha', 'HassTurnOn'), mcp('completed', 'x', 'ha', 'HassTurnOn'), FINAL, DONE]).outcome;
  assert.equal(twice.reason, 'protocol');
  const restarted = decode([...START, mcp('completed', 'x', 'ha', 'HassTurnOn'), mcp('started', 'x', 'ha', 'HassTurnOn'), FINAL, DONE]).outcome;
  assert.equal(restarted.reason, 'protocol');
  for (const id of ['', undefined, 7]) {
    const r = decode([...START, mcp('completed', /** @type {any} */ (id), 'ha', 'HassTurnOn'), FINAL, DONE]).outcome;
    assert.equal(r.reason, 'protocol', String(id));
    assert.deepEqual(r.toolsUsed, []);
  }
  const progress = decode([...START, mcp('started', 'x', 'ha', 'HassTurnOn'), mcp('started', 'x', 'ha', 'HassTurnOn'),
    { type: 'item.updated', item: mcp('started', 'x', 'ha', 'HassTurnOn').item }, mcp('completed', 'x', 'ha', 'HassTurnOn'), FINAL, DONE]).outcome;
  assert.equal(progress.status, 'ok');
  assert.deepEqual(progress.toolsUsed, ['HassTurnOn']);
});
