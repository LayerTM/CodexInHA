'use strict';

// Decoder for `codex exec --json` output of a prompt-API run.
//
// Every stdout line is one JSON event. The decoder turns them into the core's
// vocabulary (message, tool-start, tool-result, usage, warning, failure) and
// keeps the facts a run outcome is built from. It is deliberately strict:
//
// - success needs a terminal `turn.completed`, no failure, exit status 0 and a
//   final agent message; an agent message alone proves nothing;
// - an `error` item is a failure unless its text is one of the warnings the
//   CLI is known to emit for switches the launcher sets on purpose;
// - any item that executes something other than an MCP tool (a command, a web
//   search, a file change, or a type this decoder does not know) is a policy
//   violation — the prompt profile must never produce one;
// - an MCP call counts only when the CLI names the Home Assistant server AND
//   the tool is one the request allows. Anything else is a violation — that
//   includes the CLI's own resource tools (list_mcp_resources,
//   read_mcp_resource, …), which it reports under the server they read from
//   and which reach the server outside the allowed tool list.
//
// The name the CLI reports is the one the SERVER published, and Home Assistant
// namespaces each published tool by the API it comes from — six prefixes in one
// server, measured 2026-09-18. What the request allows are basenames, so the
// wire name is reduced by `basename` before it is asked about. That function is
// the core's own statement of the rule, passed in by the adapter; this file
// holds no second copy of it, because a rule stated twice is a rule that drifts.
//
// The CLI reports no cost, no model and no turn count here: those stay null.

const HA_SERVER = 'ha';

// Items that carry no action.
const PASSIVE_ITEMS = new Set(['agent_message', 'reasoning']);

// `error` items that are warnings about switches the launcher sets on purpose.
// Exact shapes only: anything else stays an error.
const KNOWN_WARNINGS = [
  /^`--dangerously-bypass-hook-trust` is enabled\. Enabled hooks may run without review for this invocation\.$/,
  /^`\[features\]\.[a-z0-9_]+` is deprecated\b[^\n]*$/,
];

function isKnownWarning(message) {
  return typeof message === 'string' && KNOWN_WARNINGS.some((re) => re.test(message));
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

// OpenAI usage counts cached input inside input_tokens and reasoning inside
// output_tokens; the core counts cache reads separately from fresh input.
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = count(u.input_tokens);
  const cacheRead = Math.min(count(u.cached_input_tokens), input);
  return {
    input: input - cacheRead,
    cacheRead,
    cacheWrite: count(u.cache_write_input_tokens),
    output: count(u.output_tokens),
    reasoning: count(u.reasoning_output_tokens),
  };
}

function errorText(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

/**
 * @param {object} o
 * @param {string[]} o.allowedTools  the basenames this request may call
 * @param {(published: string) => string} o.basename  how Home Assistant names a
 *   published tool, as the core states it — never a rule of this file's own
 * @param {string} [o.haServer]
 */
function createDecoder({ allowedTools, basename, haServer = HA_SERVER }) {
  if (!Array.isArray(allowedTools) || allowedTools.some((t) => typeof t !== 'string' || t === '')) {
    throw new TypeError('decoder: allowedTools must list the allowed tool names');
  }
  // Required, with no default: a decoder that silently compared wire names to
  // basenames refused every call a real server published (measured 2026-09-18,
  // `unexpected MCP call ha/homeassistant__GetLiveContext`), and a default would
  // let that state come back the moment a caller forgot the oracle.
  if (typeof basename !== 'function') {
    throw new TypeError('decoder: basename must be the core\'s rule for a published tool name');
  }
  const allowed = new Set(allowedTools);
  const state = {
    threadId: null,
    completed: false,
    failure: null, // { reason, message }
    finalText: null,
    usage: null,
    warnings: [],
    toolCalls: new Map(), // item id -> { server, published, tool, status, error }
  };

  function fail(reason, message) {
    if (!state.failure) state.failure = { reason, message };
    return { kind: 'failure', reason, message };
  }

  function violate(what) {
    return fail('policy', `unexpected ${what}`);
  }

  function mcpItem(phase, it) {
    const server = typeof it.server === 'string' ? it.server : '';
    const tool = typeof it.tool === 'string' ? it.tool : '';
    const id = typeof it.id === 'string' ? it.id : '';
    if (id === '') return fail('protocol', 'MCP call without an id');
    // One id is one call: its server and tool never change, and it ends once.
    const known = state.toolCalls.get(id);
    if (known && (known.server !== server || known.published !== tool)) {
      return fail('protocol', `MCP call ${id} changed its identity`);
    }
    if (known && known.status !== 'started') return fail('protocol', `MCP call ${id} reported after it ended`);
    if (known && phase === 'start') return null; // progress of a started call
    // The wire name goes to the oracle first; what comes back is the one name
    // the rest of this add-on speaks, and the violation still quotes what the
    // CLI actually said, because that is what a reader has to recognise.
    const name = tool === '' ? '' : basename(tool);
    if (server !== haServer || name === '' || !allowed.has(name)) {
      return violate(`MCP call ${server || '?'}/${tool || '?'}`);
    }
    const call = known || { server, published: tool, tool: name, status: 'started', error: null };
    state.toolCalls.set(id, call);
    if (phase === 'start') return { kind: 'tool-start', id, server, tool: name };
    call.status = it.status === 'completed' && !it.error ? 'completed' : 'failed';
    call.error = it.error ? errorText(it.error) : null;
    return { kind: 'tool-result', id, server, tool: name, ok: call.status === 'completed', error: call.error };
  }

  function decodeItem(phase, it) {
    if (!it || typeof it !== 'object' || typeof it.type !== 'string') return fail('protocol', 'item without a type');
    if (it.type === 'mcp_tool_call') return mcpItem(phase, it);
    if (it.type === 'error') {
      if (phase === 'start') return null;
      if (isKnownWarning(it.message)) {
        state.warnings.push(it.message);
        return { kind: 'warning', message: it.message };
      }
      return fail('cli_error', errorText(it));
    }
    if (PASSIVE_ITEMS.has(it.type)) {
      if (phase === 'completed' && it.type === 'agent_message' && typeof it.text === 'string') {
        state.finalText = it.text;
        return { kind: 'message', id: it.id, text: it.text };
      }
      return null;
    }
    return violate(`${it.type} item`);
  }

  // One stdout line → the decoded events it produced (possibly none).
  function line(text) {
    if (typeof text !== 'string' || text.trim() === '') return [];
    let ev;
    try {
      ev = JSON.parse(text);
    } catch {
      return [fail('protocol', 'output line is not JSON')];
    }
    if (!ev || typeof ev !== 'object') return [fail('protocol', 'output line is not an event')];
    let out = null;
    switch (ev.type) {
      case 'thread.started':
        state.threadId = typeof ev.thread_id === 'string' ? ev.thread_id : null;
        break;
      case 'turn.started':
        break;
      case 'item.started':
        out = decodeItem('start', ev.item);
        break;
      case 'item.updated': {
        // Progress of an item already reported as started; the completed item
        // is the one that counts. Its type is still checked.
        const checked = ev.item && PASSIVE_ITEMS.has(ev.item.type) ? null : decodeItem('start', ev.item);
        out = checked && checked.kind === 'failure' ? checked : null;
        break;
      }
      case 'item.completed':
        out = decodeItem('completed', ev.item);
        break;
      case 'turn.completed':
        state.completed = true;
        state.usage = normalizeUsage(ev.usage);
        out = state.usage ? { kind: 'usage', usage: state.usage } : null;
        break;
      case 'turn.failed':
        out = fail('turn_failed', errorText(ev.error));
        break;
      case 'error':
        out = fail('cli_error', errorText(ev));
        break;
      default:
        // A new event type is not evidence of anything; it cannot make a run
        // succeed, and items are the only events that carry actions.
        break;
    }
    return out ? [out] : [];
  }

  /**
   * The outcome facts once the process has exited.
   * @param {number|null} exitCode
   */
  function end(exitCode) {
    const calls = [...state.toolCalls.values()];
    const base = {
      threadId: state.threadId,
      text: state.finalText,
      final: null,
      // `published` is the wire name the server actually used; `tool` is the
      // basename the add-on speaks. Two HA namespaces share a basename, so a
      // record without `published` cannot say which one answered.
      toolCalls: calls.map((c) => ({ server: c.server, published: c.published, tool: c.tool, status: c.status, error: c.error })),
      toolsUsed: calls.filter((c) => c.status === 'completed').map((c) => c.tool),
      mcpFailed: calls.some((c) => c.status !== 'completed'),
      usage: state.usage,
      warnings: [...state.warnings],
      costUsd: null,
      reportedModel: null,
      numTurns: null,
    };
    if (state.failure) return { ...base, status: 'error', ...state.failure };
    if (exitCode !== 0) return { ...base, status: 'error', reason: 'exit', message: `exit status ${exitCode}` };
    if (!state.completed) return { ...base, status: 'error', reason: 'incomplete', message: 'the turn did not complete' };
    if (state.finalText === null) return { ...base, status: 'error', reason: 'no_result', message: 'no final message' };
    let final;
    try {
      final = JSON.parse(state.finalText);
    } catch {
      final = null;
    }
    if (!final || typeof final !== 'object' || Array.isArray(final)) {
      return { ...base, status: 'error', reason: 'no_result', message: 'the final message is not a JSON object' };
    }
    return { ...base, status: 'ok', final };
  }

  return { line, end };
}

module.exports = { createDecoder, normalizeUsage, isKnownWarning, HA_SERVER, KNOWN_WARNINGS };
