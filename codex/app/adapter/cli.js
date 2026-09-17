'use strict';

// Where the Codex CLI lives in the add-on and how it is updated.
//
// The CLI is an npm package installed under a prefix in /data, so it survives
// restarts and add-on updates; its state (login, sessions, instructions) lives
// in a separate CODEX_HOME. An update never touches CODEX_HOME.
//
// - latest:  `codex update`, which on an npm install runs npm for the latest
//   release (it takes no version);
// - a chosen version (a rollback): `npm install -g @openai/codex@<version>`.
//
// Both are described as { command, args, env } so the core runs them with its
// own timeout, lock and logging; nothing here starts a process.

const path = require('node:path');

const NPM_PREFIX = '/data/npm';
const CODEX_BIN = path.join(NPM_PREFIX, 'bin', 'codex');
const CONSOLE_HOME = '/data/codex';
const PROMPT_HOME = '/data/codex-prompt';
const PACKAGE = '@openai/codex';

// Plain semantic versions only, with an optional pre-release: the value ends up
// in an npm package spec, where a range, tag, URL or path means something else.
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

function isVersion(value) {
  return typeof value === 'string' && value.length <= 64 && VERSION_RE.test(value);
}

// `codex --version` → '0.154.0', or null when the output is not a version line.
function parseVersion(output) {
  if (typeof output !== 'string') return null;
  const m = /^codex-cli (\S+)\s*$/m.exec(output);
  return m && isVersion(m[1]) ? m[1] : null;
}

function npmEnv() {
  return { NPM_CONFIG_PREFIX: NPM_PREFIX };
}

function versionCommand() {
  return { command: CODEX_BIN, args: ['--version'], env: {} };
}

function updateLatestCommand() {
  return { command: CODEX_BIN, args: ['update'], env: npmEnv() };
}

function installVersionCommand(version) {
  if (!isVersion(version)) throw new Error('version must be a plain semantic version such as 0.154.0');
  return {
    command: 'npm',
    args: ['install', '--global', '--no-audit', '--no-fund', `${PACKAGE}@${version}`],
    env: npmEnv(),
  };
}

module.exports = {
  NPM_PREFIX,
  CODEX_BIN,
  CONSOLE_HOME,
  PROMPT_HOME,
  PACKAGE,
  isVersion,
  parseVersion,
  versionCommand,
  updateLatestCommand,
  installVersionCommand,
};
