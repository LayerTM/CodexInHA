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
