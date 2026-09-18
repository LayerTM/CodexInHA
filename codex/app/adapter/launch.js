'use strict';

// Launch profiles for the Codex CLI.
//
// Two profiles with nothing in common but the executable:
//
// - console: the owner's own interactive session. Unrestricted: the bypass
//   switch when the option asks for it, then every extra argument as given.
// - prompt (read / write): one request from the prompt API. Nothing from the
//   user's configuration, rules, skills, plugins, apps or instructions; no shell,
//   no file access, no web; only the request's own Home Assistant MCP server
//   with only the tools the request is allowed to call.
//
// The prompt profile is deny-by-default for CLI features. The set of feature
// names changes between CLI versions and an unknown name passed to --disable is
// a startup error, so the names are read from the installed CLI
// (`codex features list`) and every feature that still exists is switched off.
// KEEP_FEATURES lists the only exceptions.

const fs = require('node:fs');
const path = require('node:path');

const PROMPT_MODES = new Set(['read', 'write']);

// What bounds a run, declared once for every profile in this file.
//
// In a Home Assistant add-on the container IS the boundary: the CLI's own Linux
// sandbox is bubblewrap, and bubblewrap needs a user namespace the add-on's
// container is not allowed to create — measured on both architectures inside a
// real add-on ("No permissions to create a new namespace" on amd64, "Permission
// denied" on aarch64). Asking for that sandbox therefore buys no containment and
// costs a warning at every start: the CLI reports that bubblewrap is not on PATH
// and falls back to a bundled copy that cannot run either. So the add-on says
// what is true — the boundary is the container, the private working directory
// and the denials below — instead of asking the engine for a second one.
//
// This is the same statement the Claude add-on makes in one line of its image.
const SANDBOX_ARGS = ['--sandbox', 'danger-full-access'];


// Features a prompt run keeps at their built-in default. Each one is here
// because a prompt run is measured to need it; nothing else is kept.
//
// code_mode_host: the CLI offers MCP tools to the model only through code mode;
// with the host off the model sees no Home Assistant tool at all. The host's
// script environment has no require, fetch or process: asked to read files,
// reach the network or call a tool outside enabled_tools, every attempt failed
// and nothing reached the disk or the network. Tools the host still lists
// (apply_patch, spawn_agent) are refused by the read-only sandbox and by the
// ephemeral session respectively — spawn_agent by the ephemeral session, and
// apply_patch by the host itself, which refuses a tool outside the request's
// enabled_tools. The CLI's own sandbox is no longer one of those refusals: in a
// Home Assistant add-on it cannot be built at all (see SANDBOX_ARGS).
const KEEP_FEATURES = new Set(['code_mode_host']);

// Features that must be off in every prompt run whatever KEEP_FEATURES says:
// each of them runs commands, reads files, reaches the network or loads
// something the user installed.
const NEVER_KEEP = new Set([
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'code_mode', 'computer_use', 'hooks', 'image_generation',
  'in_app_browser', 'js_repl', 'memories', 'multi_agent', 'plugin_hooks',
  'plugins', 'remote_plugin', 'shell_snapshot', 'shell_tool',
  'skill_mcp_dependency_install', 'skill_search', 'unified_exec', 'view_image',
  'web_search_request',
]);

// The prompt API's MCP server name inside the CLI configuration, and the
// environment variable its bearer token travels in (never the command line,
// which every local process can read).
const HA_SERVER = 'ha';
const HA_TOKEN_ENV = 'CODEX_HA_MCP_TOKEN';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOOL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const FEATURE_RE = /^[a-z0-9_][a-z0-9_.]*$/;
const FEATURE_LINE_RE = /^(\S+)\s+(.+?)\s+(true|false)$/;

// `codex features list` → [{ name, stage, enabled }]. Throws when the output is
// not the table this module understands: a prompt run is not started on a
// feature set nobody could read.
function parseFeatureList(text) {
  if (typeof text !== 'string') throw new TypeError('feature list: not text');
  const features = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = FEATURE_LINE_RE.exec(line.trim());
    if (!m || !FEATURE_RE.test(m[1])) throw new Error(`feature list: unreadable line ${JSON.stringify(line)}`);
    features.push({ name: m[1], stage: m[2], enabled: m[3] === 'true' });
  }
  const names = new Set(features.map((f) => f.name));
  if (features.length === 0) throw new Error('feature list: empty');
  // A table this short, or one missing the switch the whole profile rests on,
  // is not the list of a CLI this module was measured against.
  if (!names.has('shell_tool')) throw new Error('feature list: no shell_tool feature');
  return features;
}

// Every feature that still exists and is not kept → `--disable <name>`. The
// current on/off state is ignored on purpose: it reflects the user's own
// configuration, which a prompt run does not load.
function promptFeatureArgs(features, keep = KEEP_FEATURES) {
  for (const name of keep) {
    if (NEVER_KEEP.has(name)) throw new Error(`feature ${name} cannot be kept in a prompt run`);
  }
  const args = [];
  for (const f of features) {
    if (f.stage === 'removed' || keep.has(f.name)) continue;
    // A deprecated switch warns when it is set at all; it is left alone while
    // its default is off, and switched off (warning and all) otherwise.
    if (f.stage === 'deprecated' && !f.enabled) continue;
    args.push('--disable', f.name);
  }
  return args;
}

function hasControl(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// A TOML basic string. JSON string escapes are a subset of TOML's, and it
// escapes every character below 0x20 — but not DELETE, which TOML does not
// allow raw, so that one is escaped here. This text comes from an automation
// somebody already saved; refusing the whole request over one character it
// happens to contain would be the wrong answer.
function tomlString(value) {
  if (typeof value !== 'string') throw new Error('configuration value must be text');
  return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
}

function tomlStringArray(values) {
  return `[${values.map(tomlString).join(',')}]`;
}

function checkModel(model) {
  if (model === undefined || model === null || model === '') return '';
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error('model: invalid name');
  return model;
}

function checkAbsolute(label, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || hasControl(file)) {
    throw new Error(`${label}: an absolute path is required`);
  }
  return file;
}

/**
 * The restricted profile, declared ONCE: nothing of the user's configuration,
 * rules or instructions, no approval, no web, no update check, no project docs,
 * a read-only sandbox, and every feature that still exists switched off.
 *
 * Every restricted run of this add-on is built from this one list — the
 * prompt-API run below and the one-shot question `agent-ask` asks for the
 * health check and the morning briefing. They used to declare their own
 * denials, and a feature added to one was missed by the other.
 *
 * @param {Array<{name: string, stage: string}>} features  parsed `codex features list`
 * @param {string} workDir  the empty, private directory the run starts in
 */
function restrictedArgv(features, workDir) {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--color', 'never',
    ...SANDBOX_ARGS,
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'project_doc_max_bytes=0',
    ...promptFeatureArgs(features),
    '--cd', checkAbsolute('work directory', workDir),
  ];
}

/**
 * The argv of the one-shot question: the same restricted profile, with no
 * schema, no image and no Home Assistant server at all. The prompt arrives on
 * stdin; the caller strips the Home Assistant credentials from the environment.
 *
 * @param {{features: Array<{name: string, stage: string}>, workDir: string, model?: string}} p
 */
function askLaunch(p) {
  const argv = restrictedArgv(p.features, p.workDir);
  const model = checkModel(p.model);
  if (model) argv.push('--model', model);
  argv.push('-');
  return { argv, cwd: p.workDir, env: {} };
}

/**
 * The argv (without the executable) and environment of one prompt-API run.
 *
 * @param {object} p
 * @param {'read'|'write'} p.mode
 * @param {Array<{name: string, stage: string}>} p.features  parsed `codex features list`
 * @param {string} p.workDir        empty, private directory the run starts in
 * @param {string} p.schemaFile     JSON schema of the final answer
 * @param {string} [p.model]
 * @param {string} [p.imageFile]    a camera snapshot the core fetched
 * @param {{url: string, token: string, tools: string[]}|null} [p.ha]
 *   the request's MCP endpoint and the exact tool names it may call; null or an
 *   empty tool list registers no server at all
 * @returns {{argv: string[], cwd: string, env: Record<string, string>}}
 */
function promptLaunch(p) {
  if (!p || !PROMPT_MODES.has(p.mode)) throw new Error('prompt mode must be read or write');
  const workDir = checkAbsolute('work directory', p.workDir);
  const schemaFile = checkAbsolute('schema file', p.schemaFile);
  const model = checkModel(p.model);
  const argv = [
    ...restrictedArgv(p.features, workDir),
    '--output-schema', schemaFile,
  ];
  if (model) argv.push('--model', model);
  if (p.imageFile !== undefined && p.imageFile !== null && p.imageFile !== '') {
    argv.push('--image', checkAbsolute('image file', p.imageFile));
  }
  const env = {};
  const ha = p.ha;
  if (ha && Array.isArray(ha.tools) && ha.tools.length > 0) {
    if (typeof ha.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(ha.url)) throw new Error('ha: invalid url');
    if (typeof ha.token !== 'string' || ha.token === '') throw new Error('ha: token required');
    const tools = [...new Set(ha.tools)];
    for (const t of tools) {
      if (typeof t !== 'string' || !TOOL_RE.test(t)) throw new Error('ha: invalid tool name');
    }
    const key = `mcp_servers.${HA_SERVER}`;
    argv.push(
      '-c', `${key}.url=${tomlString(ha.url)}`,
      '-c', `${key}.bearer_token_env_var=${tomlString(HA_TOKEN_ENV)}`,
      '-c', `${key}.enabled_tools=${tomlStringArray(tools)}`,
      '-c', `${key}.default_tools_approval_mode="approve"`,
    );
    env[HA_TOKEN_ENV] = ha.token;
  }
  // The request text arrives on stdin, never as an argument.
  argv.push('-');
  return { argv, cwd: workDir, env };
}

// Files the CLI reads from CODEX_HOME whatever the command line says: global
// instructions and the user's configuration.
const HOME_INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md', 'config.toml'];

/**
 * Makes `promptHome` the CODEX_HOME of prompt runs.
 *
 * Global AGENTS.md is read from CODEX_HOME even with --ignore-user-config, and
 * the console's home is where the user keeps their own instructions. Prompt
 * runs therefore get a home of their own that holds nothing but a link to the
 * console's login. The CLI writes a refreshed login by opening auth.json for
 * writing, which follows the link, so both homes keep one login.
 *
 * Throws, and the run must not start, when the home holds anything that would
 * be read as instructions or configuration.
 */
function preparePromptHome(consoleHome, promptHome) {
  checkAbsolute('console home', consoleHome);
  checkAbsolute('prompt home', promptHome);
  if (path.resolve(consoleHome) === path.resolve(promptHome)) {
    throw new Error('prompt home must differ from the console home');
  }
  fs.mkdirSync(promptHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(promptHome, 0o700);
  const link = path.join(promptHome, 'auth.json');
  const target = path.join(consoleHome, 'auth.json');
  let current = null;
  try {
    current = fs.readlinkSync(link);
  } catch (err) {
    if (err.code === 'EINVAL') {
      throw new Error('prompt home: auth.json is a file, not the link to the console login', { cause: err });
    }
    if (err.code !== 'ENOENT') throw err;
  }
  if (current !== target) {
    if (current !== null) fs.unlinkSync(link);
    fs.symlinkSync(target, link);
  }
  for (const name of HOME_INSTRUCTION_FILES) {
    if (fs.existsSync(path.join(promptHome, name)) || isLink(path.join(promptHome, name))) {
      throw new Error(`prompt home: ${name} must not exist`);
    }
  }
  return promptHome;
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

const BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

/**
 * The argv (without the executable) of the interactive console session.
 * Unrestricted by design: the owner's own session, like the Claude console.
 *
 * Either way the console states the boundary it actually has: with the bypass
 * flag, which implies it, and without it through SANDBOX_ARGS — so neither mode
 * asks for a sandbox this container cannot build. The bypass option still means
 * what it says: it is what drops the approval prompts.
 *
 * @param {{bypass_permissions?: boolean, extra_args?: unknown}} options  add-on options
 */
function consoleArgs(options) {
  const args = [];
  if (options && options.bypass_permissions === true) args.push(BYPASS_FLAG);
  else args.push(...SANDBOX_ARGS);
  const extra = options && Array.isArray(options.extra_args) ? options.extra_args : [];
  for (const a of extra) {
    if (typeof a === 'string' && a !== '') args.push(a);
  }
  return args;
}

module.exports = {
  KEEP_FEATURES,
  restrictedArgv,
  SANDBOX_ARGS,
  askLaunch,
  NEVER_KEEP,
  HA_SERVER,
  HA_TOKEN_ENV,
  BYPASS_FLAG,
  parseFeatureList,
  promptFeatureArgs,
  promptLaunch,
  preparePromptHome,
  consoleArgs,
  tomlString,
};
