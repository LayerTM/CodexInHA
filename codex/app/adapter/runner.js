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
// home: its schema, and the empty directory it starts in (the CLI reads
// AGENTS.md and the project docs of its working directory).
//
// Each run gets a directory of ITS OWN. The core runs two requests at once, and
// one shared directory meant the second run emptied the directory the first was
// working in and overwrote the schema it was answering against.
const RUN_DIR = path.join(cli.PROMPT_HOME, 'run');
// A directory nothing has written to for this long belongs to a run that is
// over: the core's own limit is far below it.
const RUN_DIR_MAX_AGE_MS = 60 * 60 * 1000;

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

// Directories of runs that are long over. A run cannot be asked when it ended,
// so age decides; nothing is removed while it could still be in use.
function sweepRunDirs(now = Date.now(), root = RUN_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      if (now - fs.statSync(dir).mtimeMs > RUN_DIR_MAX_AGE_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* another run removed it, or it is not ours to remove */ }
  }
}

// One run's own empty directory. The CLI reads what it finds in its working
// directory, so a leftover file from another run is input nobody meant to give
// it — and another run's live files are not ours to delete.
function newRunDir(root = RUN_DIR) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  sweepRunDirs(Date.now(), root);
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, 'work'), { mode: 0o700 });
  return dir;
}

function writeSchema(dir, schema) {
  const file = path.join(dir, 'schema.json');
  fs.writeFileSync(file, schema, { mode: 0o600 });
  return file;
}

/**
 * The complete command line and extra environment for one run spec.
 */
function launchRun(spec, { env }) {
  // The home a run reads its login from: a directory of its own holding
  // nothing but a link to the console's sign-in, so a run never reads the
  // user's own instructions or configuration. Checked before every run, because
  // a file that appeared there since would be read as instructions.
  launch.preparePromptHome(cli.CONSOLE_HOME, cli.PROMPT_HOME);
  const ha = relay(spec.mcpConfigPath);
  const runDir = newRunDir();
  const built = launch.promptLaunch({
    mode: spec.read ? 'read' : 'write',
    features: features(),
    workDir: path.join(runDir, 'work'),
    schemaFile: writeSchema(runDir, spec.schema),
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
  let usage = null;
  let done = false;

  // `deterministic` tells the core whether a retry could ever end differently.
  // A policy violation could not: the run tried something the profile forbids,
  // and the same request would try it again, so it is not re-run.
  const failure = (message, reason) => {
    done = true;
    return {
      type: 'result',
      isError: true,
      deterministic: reason === 'policy',
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
        case 'usage':
          usage = ev.usage;
          break;
        case 'failure':
          terminal = failure(ev.message, ev.reason);
          break;
        default:
          break;
      }
    }
    if (terminal) {
      out.push(terminal);
      return out;
    }
    // A completed turn ends the run, and whether it succeeded is decided in ONE
    // place: events.js, which already holds what counts as a complete turn and
    // as an answer.
    //
    // The zero is not the child's exit status: the child is still running, and
    // a decoder that reads its output line by line never learns how it exits.
    // So the exit-status branch of that judgement cannot fire here, and nothing
    // else catches it either — core 0.5.0's close handler reads the result
    // before the code (`prompt/run.js`), so a run that answered and THEN exited
    // non-zero is reported as an answer. Worth knowing when reading that
    // branch; it is not dead in the tests, which do know the status.
    if (parsed && parsed.type === 'turn.completed') {
      done = true;
      const outcome = decoder.end(0);
      if (outcome.status !== 'ok') {
        out.push(failure(outcome.message, outcome.reason));
        return out;
      }
      out.push({
        type: 'result',
        isError: false,
        deterministic: false,
        structured: outcome.final,
        text: typeof outcome.final.text === 'string' ? outcome.final.text : outcome.text,
        numTurns: outcome.numTurns,
        costUsd: outcome.costUsd,
        tokens: runTokens(usage, model),
      });
    }
    return out;
  };
}

module.exports = {
  features,
  newRunDir,
  sweepRunDirs,
  RUN_DIR,
  RUN_DIR_MAX_AGE_MS,
  HA_TOOL_PREFIX,
  toolName,
  toolBasename,
  runTokens,
  launch: launchRun,
  createDecoder,
};
