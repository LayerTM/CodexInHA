'use strict';

// The Codex engine adapter for ha-agent-core: every value the core needs that is
// specific to Codex. The core loads it through server/adapter-contract.js.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cli = require('./cli');
const limits = require('./limits');
const runner = require('./runner');

// The console's login, and the separate home prompt runs use. They share one
// login through a link; nothing else crosses between them (see launch.js).
const CONSOLE_HOME = cli.CONSOLE_HOME;
const PROMPT_HOME = cli.PROMPT_HOME;

// The CLI both the console and the prompt API run. It is installed under /data,
// so a login, the sessions and an update survive a restart.
const CODEX_BIN = cli.CODEX_BIN;

module.exports = {
  apiVersion: require('./api-version'),
  descriptor: {
    engine: 'codex',
    // `codex-cli 0.154.0` -> `0.154.0`
    parseVersion: (stdout) => cli.parseVersion(stdout),
    // The CLI reports no cost anywhere: not in the run's events, not in its
    // session files. Nothing here may pretend otherwise — without this the core
    // publishes no budget and refuses a non-zero one.
    reportsCost: false,
    // The CLI hands a structured output to a model that accepts only CLOSED
    // objects: every object needs `additionalProperties: false`, and an open one
    // is refused before the run starts (`invalid_json_schema … additionalProperties
    // is required to be supplied and to be false`, measured 2026-09-18). An
    // intent's data and an automation block are open by nature — their keys
    // belong to the home — so the core gives this engine no schema for an answer
    // that contains one, rather than a schema this engine cannot be given.
    closedSchemasOnly: true,
  },
  runner: {
    bin: CODEX_BIN,
    launch: runner.launch,
    createDecoder: runner.createDecoder,
    toolName: runner.toolName,
    toolBasename: runner.toolBasename,
  },
  prompt: {
    // A ChatGPT login has account-wide limits; an API key is billed per request
    // and reports its mode with no entries. The figures are read from a
    // short-lived app-server, which answers without starting a model turn.
    limitsSource({ apiKey, homeDir }) {
      const epoch = limits.credentialEpoch(CONSOLE_HOME);
      if (!epoch) return apiKey ? { mode: 'api_key', key: 'api_key' } : null;
      return {
        mode: 'subscription',
        key: epoch,
        async read() {
          const answer = await limits.readAccountLimits({
            bin: CODEX_BIN,
            codexHome: CONSOLE_HOME,
            env: { PATH: process.env.PATH || '', HOME: homeDir || '/data/home' },
          });
          if (!answer) return null;
          return answer.mode === 'subscription' ? answer.limits : [];
        },
      };
    },
    authConfigured({ env }) {
      return Boolean(env.OPENAI_API_KEY) || fs.existsSync(path.join(CONSOLE_HOME, 'auth.json'));
    },
    // The CLI takes its MCP servers on the command line, one setting at a time,
    // so a run's server is registered by launch.js rather than by a file the CLI
    // reads. What is kept here is the endpoint itself, for the run that is about
    // to start: the core writes it into that run's own directory, names the file
    // in the run spec, and removes the directory when the run ends.
    async writeMcpConfig({ dir, url, bearer }) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'ha-mcp.json');
      if (!url || !bearer) {
        await fsp.rm(file, { force: true });
        return null;
      }
      await fsp.writeFile(file, JSON.stringify({ url, token: bearer }, null, 2), { mode: 0o600 });
      return file;
    },
    // Prompt runs are `--ephemeral`: the CLI writes no session file for them
    // (measured on CLI 0.154.0), so there is nothing of an earlier version to
    // remove. The run's own working directory is emptied before every run.
    async removeSavedSessions() {
      return 0;
    },
    credentials({ options, env, optionString }) {
      return {
        apiKey: optionString(options, 'api_key') || env.OPENAI_API_KEY || '',
        oauthToken: '',
      };
    },
    secretValues({ options, env, optionString }) {
      return {
        options: [optionString(options, 'api_key')],
        env: [env.OPENAI_API_KEY],
      };
    },
  },
  console: {
    bin: CODEX_BIN,
    updateCommand: '/usr/local/bin/update-codex',
    windowName: 'codex',
    launcher: '/usr/local/bin/start-codex',
    // The CLI's own remote control: its own tab, so the pairing code is printed
    // in a real terminal.
    remoteWindow(env) {
      return env.REMOTE_CONTROL === 'true' ? { name: 'remote', argv: ['/usr/local/bin/start-remote'] } : null;
    },
  },
  PROMPT_HOME,
};
