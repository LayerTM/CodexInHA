'use strict';

// How the add-on hands an API key to `codex exec`, through the real launch path
// (runner.launch, the function the core calls for every Prompt API run).
//
// `codex exec` reads its API key from CODEX_API_KEY and from nothing else. Measured
// on Codex CLI 0.166.0 and 0.167.0, in an empty CODEX_HOME with a made-up key:
//   OPENAI_API_KEY=<key> codex exec ...  ->  401 "Missing bearer or basic ..."  (key ignored)
//   CODEX_API_KEY=<key>  codex exec ...  ->  401 "Incorrect API key provided"  (key used)
// (source: codex-rs/login/src/auth/manager.rs, load_auth, and codex-rs/exec/src/lib.rs).
// The pin states the behaviour, not the mechanism: the add-on's key reaches a run
// under the name `codex exec` reads, and nowhere in its argv.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The paths the adapter fixes for the add-on (/data/…) are replaced BEFORE the
// runner is loaded, because it derives its run directory from them on load.
const cli = require('../../adapter/cli.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-key-launch-'));
const fake = path.join(root, 'codex');
fs.writeFileSync(
  fake,
  [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "codex-cli 0.167.0" ;;',
    `  features) cat '${path.join(__dirname, '..', 'fixtures', 'features-0.154.0.txt')}' ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
cli.CODEX_BIN = fake;
cli.CONSOLE_HOME = path.join(root, 'console-home');
cli.PROMPT_HOME = path.join(root, 'prompt-home');
fs.mkdirSync(cli.CONSOLE_HOME, { recursive: true });

const runner = require('../../adapter/runner.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const spec = () => ({
  read: true,
  vision: false,
  haAllowed: [],
  haDisallowed: [],
  schema: '{"type":"object"}',
  systemPrompt: 'be brief',
  model: 'gpt-6-astra',
});

// Not a credential: a value that is recognisable in any output it leaks into.
const KEY = 'sk-test-not-a-real-key-0000000000000000';

test('a run launched with the add-on\'s api_key carries it under the name codex exec reads', () => {
  const { env } = runner.launch(spec(), { env: { CODEX_API_KEY: KEY } });
  assert.equal(env.CODEX_API_KEY, KEY);
});

test('the adapter names the key variable the CLI reads', () => {
  assert.equal(cli.API_KEY_ENV, 'CODEX_API_KEY');
});

test('the key never appears on the command line', () => {
  const { args } = runner.launch(spec(), { env: { CODEX_API_KEY: KEY } });
  assert.ok(!args.some((a) => String(a).includes(KEY)), 'a command line is visible to every process');
});

test('a run launched without a key carries none, and a variable the CLI ignores is not handed on', () => {
  const { env } = runner.launch(spec(), { env: { OPENAI_API_KEY: KEY } });
  for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY']) {
    assert.ok(!(name in env), `${name} is absent`);
  }
});
