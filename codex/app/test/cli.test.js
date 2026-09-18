'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cli = require('../adapter/cli.js');

test('the CLI and its state live in separate persistent directories', () => {
  assert.equal(cli.CODEX_BIN, '/data/npm/bin/codex');
  assert.ok(cli.CODEX_BIN.startsWith(`${cli.NPM_PREFIX}/`));
  for (const home of [cli.CONSOLE_HOME, cli.PROMPT_HOME]) {
    assert.ok(home.startsWith('/data/'));
    assert.ok(!home.startsWith(`${cli.NPM_PREFIX}/`) && !cli.NPM_PREFIX.startsWith(`${home}/`));
  }
  assert.notEqual(cli.CONSOLE_HOME, cli.PROMPT_HOME);
});

test('the version is read from the version line only', () => {
  assert.equal(cli.parseVersion('codex-cli 0.154.0\n'), '0.154.0');
  assert.equal(cli.parseVersion('WARNING: proceeding\ncodex-cli 0.155.0-alpha.2\n'), '0.155.0-alpha.2');
  for (const out of ['', 'codex-cli', 'codex-cli latest', 'claude 1.0.0', 'codex-cli 0.154', 'xcodex-cli 1.2.3', undefined]) {
    assert.equal(cli.parseVersion(out), null, String(out));
  }
});

test('latest comes from the CLI itself, with the persistent npm prefix', () => {
  assert.deepEqual(cli.versionCommand(), { command: '/data/npm/bin/codex', args: ['--version'], env: {} });
  assert.deepEqual(cli.updateLatestCommand(), { command: '/data/npm/bin/codex', args: ['update'], env: { NPM_CONFIG_PREFIX: '/data/npm' } });
});

test('a chosen version is installed with npm into the same prefix', () => {
  assert.deepEqual(cli.installVersionCommand('0.153.4'), {
    command: 'npm',
    args: ['install', '--global', '--no-audit', '--no-fund', '@openai/codex@0.153.4'],
    env: { NPM_CONFIG_PREFIX: '/data/npm' },
  });
});

test('anything but a plain version is refused before a command exists', () => {
  for (const v of ['latest', '^0.154.0', '~0.154.0', '0.154', '0.154.0 --force', '0.154.0;id', '../x', 'file:../x',
    'git+https://x', '01.2.3', '1.2.3-', '1.2.3-a..b', '', ' 0.154.0', `1.2.3-${'a'.repeat(60)}`, 154, null]) {
    assert.throws(() => cli.installVersionCommand(v), /plain semantic version/, String(v));
    assert.equal(cli.isVersion(v), false, String(v));
  }
  for (const v of ['0.0.0', '10.20.30', '0.155.0-alpha.2', '1.0.0-rc.1']) assert.ok(cli.isVersion(v), v);
});
