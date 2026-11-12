#!/usr/bin/env node
// Hands the prompt runs' real argument lists to a Codex CLI and asserts that the
// CLI accepts every one of them.
//
// Runs inside the built add-on image, so all three sides are what ships: the run
// spec from the image's core, the command line from the image's Codex adapter
// (which asks the CLI for its feature list, as it does on a device) and the
// image's pinned CLI. The lists are never copied here, so a core, adapter or CLI
// change is checked against the others on the pull request that makes it.
//
// How acceptance is observed without an account or a network call: stdin is
// empty. `codex exec` parses the command line (an unknown flag or a value
// outside an option's choices exits 2 with its own message) and loads the
// configuration the -c overrides and --disable switches build (an unknown
// configuration key, a bad value or an unknown feature name exits 1 with its
// own message), and only then reads the prompt and refuses to go on with none.
// So the one outcome that proves the whole list was accepted is that refusal —
// exit 1 and "No prompt provided via stdin." — and anything else, including a
// run that starts and waits for the network, fails.
//
// Usage: node runner_args_smoke.js <codex binary> <console app dir>

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NO_INPUT = 'No prompt provided via stdin.';

const [bin, appDir] = process.argv.slice(2);
if (!bin || !appDir) {
  console.error('usage: runner_args_smoke.js <codex binary> <console app dir>');
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'args-smoke-'));

// The adapter keeps its state under /data and runs the CLI from the copy kept
// there, neither of which a fresh image has. Both are properties of the module
// that every caller reads when it calls, so they are pointed at this run's own
// directories before anything is built.
const cli = require(path.resolve(appDir, 'adapter/cli.js'));
cli.CODEX_BIN = path.resolve(bin);
cli.CONSOLE_HOME = path.join(home, 'console');
cli.PROMPT_HOME = path.join(home, 'prompt');
fs.mkdirSync(cli.CONSOLE_HOME, { recursive: true });

const { launchSpec } = require(path.resolve(appDir, 'server/prompt/run.js'));
const runner = require(path.resolve(appDir, 'adapter/runner.js'));
const launch = require(path.resolve(appDir, 'adapter/launch.js'));

const mcpConfigPath = path.join(home, 'ha-mcp.json');
fs.writeFileSync(mcpConfigPath, JSON.stringify({ url: 'http://127.0.0.1:9/api/mcp', token: 'x' }));

const buildRunArgs = (options) => runner.launch(launchSpec(options), { env: {} }).args;
// The one-shot question (health check, morning briefing) is built from the same
// restricted profile by agent-ask, from the feature list of the CLI.
const buildAskArgs = (options) => {
  const workDir = fs.mkdtempSync(path.join(home, 'ask-'));
  return launch.askLaunch({ features: runner.features(), workDir, ...options }).argv;
};

// Every branch of the builders at least once: with and without the Home
// Assistant MCP server, a model, an image, the web run, and the one-shot
// question with and without a model.
const cases = {
  'read, no MCP server': () => buildRunArgs({}),
  'read, MCP server': () => buildRunArgs({ mcpConfigPath, haTools: ['homeassistant__GetLiveContext'] }),
  'read, everything on': () => buildRunArgs({
    mcpConfigPath,
    imagePath: path.join(home, 'snap.jpg'),
    model: 'gpt-5',
    language: 'uk',
    surface: 'voice',
    editAutomation: { alias: 'a', triggers: [], actions: [] },
    haTools: ['homeassistant__GetLiveContext', 'intent__HassTurnOn'],
    stream: true,
  }),
  'web run': () => buildRunArgs({ web: { search: true, fetch: false, domains: [] }, model: 'gpt-5' }),
  'one-shot question': () => buildAskArgs({}),
  'one-shot question with a model': () => buildAskArgs({ model: 'gpt-5' }),
};

let failed = 0;
for (const [label, build] of Object.entries(cases)) {
  let args;
  try {
    args = build();
  } catch (err) {
    failed += 1;
    console.log(`NOT ok - ${label}: the argument list could not be built: ${err.message}`);
    continue;
  }
  const run = spawnSync(bin, args, {
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: cli.PROMPT_HOME, TERM: 'dumb' },
  });
  const output = `${run.stderr || ''}${run.stdout || ''}`.trim();
  if (run.status === 1 && output.includes(NO_INPUT)) {
    console.log(`ok     - ${label}`);
  } else {
    failed += 1;
    console.log(`NOT ok - ${label}: exit ${run.status}${run.error ? ` (${run.error.message})` : ''}`);
    console.log(`         ${output.split('\n').slice(0, 5).join('\n         ')}`);
    console.log(`         flags: ${args.filter((a) => a.startsWith('--')).join(' ')}`);
  }
}
fs.rmSync(home, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} argument list(s) rejected by ${bin}`);
  process.exit(1);
}
console.log(`every argument list accepted by ${bin}`);
