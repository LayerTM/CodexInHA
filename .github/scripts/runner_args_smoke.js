#!/usr/bin/env node
// Hands the prompt runs' real argument lists to a Codex CLI and asserts that the
// CLI PARSES every one of them, and that each list has the shape its run mode
// depends on. Parsing is not working: it proves no flag, configuration key or
// feature name was dropped or renamed, not that a run would answer a question.
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
// So the one outcome that proves the whole list was parsed is that refusal —
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

// The shape every list has, whatever the mode: the non-interactive command with
// JSON events, a throwaway session, no repository requirement, nothing of the
// user's configuration, the read-only sandbox, a working directory of its own and
// the request on stdin. A list that parses but loses one of these would run
// unrestricted or never produce events the core reads.
function shapeProblems(args, want) {
  const problems = [];
  const has = (flag) => args.includes(flag);
  const value = (flag) => (has(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (args[0] !== 'exec') problems.push(`the first argument is ${JSON.stringify(args[0])}, not exec`);
  for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config']) {
    if (!has(flag)) problems.push(`${flag} is missing`);
  }
  if (value('--sandbox') !== 'read-only') problems.push(`--sandbox is ${JSON.stringify(value('--sandbox'))}, not read-only`);
  if (has('--dangerously-bypass-approvals-and-sandbox')) problems.push('the bypass flag is present');
  if (!args.includes('approval_policy="never"')) problems.push('approval_policy="never" is missing');
  const cd = value('--cd');
  if (!cd || !path.isAbsolute(cd)) problems.push(`--cd is ${JSON.stringify(cd)}, not an absolute directory`);
  if (args[args.length - 1] !== '-') problems.push('the request is not read from stdin (no trailing -)');
  if (!args.includes('--disable')) problems.push('no feature is switched off');
  const schema = has('--output-schema');
  if (schema !== want.schema) problems.push(`--output-schema ${schema ? 'present' : 'absent'}, expected ${want.schema ? 'present' : 'absent'}`);
  const model = has('--model');
  if (model !== want.model) problems.push(`--model ${model ? 'present' : 'absent'}, expected ${want.model ? 'present' : 'absent'}`);
  const image = has('--image');
  if (image !== want.image) problems.push(`--image ${image ? 'present' : 'absent'}, expected ${want.image ? 'present' : 'absent'}`);
  const mcp = args.some((a) => a.startsWith('mcp_servers.'));
  if (mcp !== want.mcp) problems.push(`the MCP server is ${mcp ? 'registered' : 'absent'}, expected ${want.mcp ? 'registered' : 'absent'}`);
  return problems;
}

// Every run mode the adapter builds, and every branch of its builders, at least
// once: the read run (the core builds no other; its write path is the
// proposal the user confirms, which never reaches the CLI), with and without the
// Home Assistant MCP server, a model, an image, the web run, and the one-shot
// question of the health check and the morning briefing with and without a model.
const RUN = { schema: true, model: false, image: false, mcp: false };
const ASK = { schema: false, model: false, image: false, mcp: false };
const cases = {
  'read, no MCP server': [() => buildRunArgs({}), RUN],
  'read, MCP server': [() => buildRunArgs({ mcpConfigPath, haTools: ['homeassistant__GetLiveContext'] }), { ...RUN, mcp: true }],
  'read, everything on': [() => buildRunArgs({
    mcpConfigPath,
    imagePath: path.join(home, 'snap.jpg'),
    model: 'gpt-5',
    language: 'uk',
    surface: 'voice',
    editAutomation: { alias: 'a', triggers: [], actions: [] },
    haTools: ['homeassistant__GetLiveContext', 'intent__HassTurnOn'],
    stream: true,
  }), { schema: true, model: true, image: true, mcp: true }],
  'web run': [() => buildRunArgs({ web: { search: true, fetch: false, domains: [] }, model: 'gpt-5' }), { ...RUN, model: true }],
  'one-shot question': [() => buildAskArgs({}), ASK],
  'one-shot question with a model': [() => buildAskArgs({ model: 'gpt-5' }), { ...ASK, model: true }],
};

let failed = 0;
for (const [label, [build, want]] of Object.entries(cases)) {
  let args;
  try {
    args = build();
  } catch (err) {
    failed += 1;
    console.log(`NOT ok - ${label}: the argument list could not be built: ${err.message}`);
    continue;
  }
  const problems = shapeProblems(args, want);
  if (problems.length > 0) {
    failed += 1;
    console.log(`NOT ok - ${label}: the argument list has the wrong shape`);
    for (const problem of problems) console.log(`         ${problem}`);
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
    console.log(`ok     - ${label} (parses, shape as expected)`);
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
console.log(`every argument list parses with ${bin}`);
