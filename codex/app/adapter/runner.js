'use strict';

// How one prompt-API request becomes a `codex exec` call, and how that call's
// JSON-lines output becomes the core's neutral events. The core
// (server/prompt/run.js) owns the request policy, the prompts and schemas, the
// process lifecycle and the outcome; this file only encodes them for the CLI.
//
// The call itself is built in launch.js, which is deny-by-default: every CLI
// feature that still exists is switched off, the sandbox is read-only, nothing
// of the user's configuration, rules or instructions is loaded, and the only
// tools the run can reach are the ones the request allows on its own Home
// Assistant MCP server. What this file adds is the plumbing that needs the
// running CLI or the file system:
//
//   - the feature list the profile is built from, read from the installed CLI
//     and cached per CLI version;
//   - the answer schema, which the CLI takes as a file rather than a string;
//   - the core's system prompt, which travels as `developer_instructions`
//     (measured on CLI 0.154.0: it reaches the model);
//   - the relay endpoint, which the core hands over as the file
//     `prompt.writeMcpConfig` wrote.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('./cli');
const launch = require('./launch');
const events = require('./events');

// Everything a run needs on disk, private to this add-on and never the console's
// home: the schema of the moment, and the empty directory a run starts in (the
// CLI reads AGENTS.md and the project docs of its working directory).
const RUN_DIR = path.join(cli.PROMPT_HOME, 'run');
const WORK_DIR = path.join(RUN_DIR, 'work');
const SCHEMA_FILE = path.join(RUN_DIR, 'schema.json');

// A Home Assistant tool as the core names it. The CLI reports an MCP call with
// the server and the tool apart, so the name the core sees is composed here and
// taken apart again here; nothing else in the core knows the shape.
const HA_TOOL_PREFIX = 'ha__';

function toolName(basename) {
  return `${HA_TOOL_PREFIX}${basename}`;
}

function toolBasename(name) {
  if (typeof name !== 'string' || !name.startsWith(HA_TOOL_PREFIX)) return null;
  const rest = name.slice(HA_TOOL_PREFIX.length);
  return rest === '' ? null : rest;
}

// Passed on from the add-on's environment when set: the CLI's own credential
// and the proxy settings. A Home Assistant or Supervisor token never appears
// here; the core builds the rest of the child's environment itself.
const PASSTHROUGH_ENV = [
  'OPENAI_API_KEY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

// `codex features list`, read from the installed CLI and kept per version: the
// profile switches off every feature that exists, and an unknown name passed to
// --disable is a startup error, so the list must come from the CLI that runs.
let featureCache = { version: null, features: null };

function runCli(args) {
  const out = spawnSync(cli.CODEX_BIN, args, {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CODEX_HOME: cli.PROMPT_HOME },
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`codex ${args.join(' ')}: exit status ${out.status}`);
  return out.stdout;
}

function features() {
  const version = cli.parseVersion(runCli(['--version']));
  if (!version) throw new Error('codex --version: unreadable');
  if (featureCache.version === version) return featureCache.features;
  const parsed = launch.parseFeatureList(runCli(['features', 'list']));
  featureCache = { version, features: parsed };
  return parsed;
}

// The core hands the relay over as the file its writeMcpConfig wrote; an absent
// or unreadable file means this run gets no Home Assistant server at all.
function relay(file) {
  if (!file) return null;
  try {
    const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof conf.url !== 'string' || typeof conf.token !== 'string') return null;
    return { url: conf.url, token: conf.token };
  } catch {
    return null;
  }
}

function writeSchema(schema) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SCHEMA_FILE, schema, { mode: 0o600 });
  return SCHEMA_FILE;
}

// The run's own working directory, emptied before every run: the CLI reads what
// it finds there, and a leftover file from an earlier run is input nobody meant
// to give it.
function freshWorkDir() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  return WORK_DIR;
}

/**
 * The complete command line and extra environment for one run spec.
 */
function launchRun(spec, { env }) {
  const ha = relay(spec.mcpConfigPath);
  const built = launch.promptLaunch({
    mode: spec.read ? 'read' : 'write',
    features: features(),
    workDir: freshWorkDir(),
    schemaFile: writeSchema(spec.schema),
    model: spec.model || undefined,
    imageFile: spec.vision && spec.imagePath ? spec.imagePath : undefined,
    ha: ha && spec.haAllowed.length > 0
      ? { url: ha.url, token: ha.token, tools: spec.haAllowed.map(toolBasename).filter(Boolean) }
      : null,
  });
  // The core's system prompt, as a developer message. The CLI has no flag for
  // one, and the request text is stdin, which the core owns.
  const args = [...built.argv];
  args.splice(args.length - 1, 0,
    '-c', `developer_instructions=${launch.tomlString(spec.systemPrompt)}`);
  const extra = { ...built.env, CODEX_HOME: cli.PROMPT_HOME };
  for (const key of PASSTHROUGH_ENV) {
    if (env[key]) extra[key] = env[key];
  }
  return { args, env: extra };
}

// The tokens one run used. The CLI reports them per turn, without a model name,
// so the model is the one the request asked for; `unknown` when it asked for
// none. It reports no cost at all — the add-on publishes none.
function runTokens(usage, model) {
  if (!usage) return [];
  return [{
    model: model || 'unknown',
    input: usage.input,
    output: usage.output + usage.reasoning,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  }];
}

/**
 * One run's JSON-lines output -> the core's neutral events.
 *
 * events.js decides what the output means (what counts as a tool call, what is
 * a policy violation, when a turn is really complete); this translates its
 * vocabulary into the core's and ends the run on the terminal event, because
 * the core learns the outcome from the events alone.
 */
function createDecoder(spec) {
  const allowed = new Set(spec.haAllowed.map(toolBasename).filter(Boolean));
  const decoder = events.createDecoder({ allowedTools: [...allowed] });
  const model = spec.model || '';
  let finalText = null;
  let usage = null;
  let done = false;

  const failure = (message) => {
    done = true;
    return {
      type: 'result',
      isError: true,
      deterministic: false,
      structured: undefined,
      text: message,
      numTurns: null,
      costUsd: null,
      tokens: runTokens(usage, model),
    };
  };

  return (parsed) => {
    if (done) return [];
    const out = [];
    let terminal = null;
    for (const ev of decoder.line(JSON.stringify(parsed))) {
      switch (ev.kind) {
        case 'tool-start':
          out.push({ type: 'tool-use', id: ev.id, name: toolName(ev.tool) });
          break;
        case 'tool-result':
          out.push({ type: 'tool-result', id: ev.id, isError: !ev.ok });
          break;
        case 'message':
          finalText = ev.text;
          break;
        case 'usage':
          usage = ev.usage;
          break;
        case 'failure':
          terminal = failure(ev.message);
          break;
        default:
          break;
      }
    }
    if (terminal) {
      out.push(terminal);
      return out;
    }
    // A completed turn is the only success; the answer is the last agent
    // message, which the schema made a JSON object.
    if (parsed && parsed.type === 'turn.completed') {
      done = true;
      let structured;
      try {
        structured = JSON.parse(finalText);
      } catch {
        structured = undefined;
      }
      if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
        out.push(failure('the run produced no structured answer'));
        return out;
      }
      out.push({
        type: 'result',
        isError: false,
        deterministic: false,
        structured,
        text: typeof structured.text === 'string' ? structured.text : finalText,
        numTurns: null,
        costUsd: null,
        tokens: runTokens(usage, model),
      });
    }
    return out;
  };
}

module.exports = {
  RUN_DIR,
  WORK_DIR,
  SCHEMA_FILE,
  HA_TOOL_PREFIX,
  toolName,
  toolBasename,
  runTokens,
  launch: launchRun,
  createDecoder,
};
