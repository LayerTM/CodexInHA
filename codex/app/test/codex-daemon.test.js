'use strict';

// The console matches the CLI's background service to the CLI the add-on
// installed (rootfs/usr/local/lib/codex-daemon.sh). The real function runs here
// against a stand-in `codex` that records each call and answers as the CLI does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'lib');

// `codex --version` prints FAKE_VERSION; `codex app-server daemon update
// --from-cli --yes` logs its argv and ends as FAKE_UPDATE says: ok, missing (no
// service installed yet), or fail.
const FAKE_CODEX = `#!/bin/bash
if [ "$1" = --version ]; then echo "codex-cli $FAKE_VERSION"; exit 0; fi
echo "$*" >> "$FAKE_CALLS"
case "$FAKE_UPDATE" in
  ok) echo '{"status":"updated"}' ;;
  missing) echo 'Error: no daemon package is selected; run \`codex app-server daemon start\` first' >&2; exit 1 ;;
  *) printf 'warning: x\\nError: install lock busy\\n' >&2; exit 1 ;;
esac
`;

function run({ version = '0.167.2', update = 'ok', pinned = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'codex'), FAKE_CODEX, { mode: 0o755 });
    const marker = path.join(dir, 'pinned');
    if (pinned !== null) fs.writeFileSync(marker, `${pinned}\n`);
    const calls = path.join(dir, 'calls');
    // PATH is set inside the script: a shell may rebuild it from its own startup
    // files, and the stand-in has to come first in the one the function sees.
    const script = `PATH='${path.join(dir, 'bin')}':$PATH\n. '${path.join(LIB, 'codex-daemon.sh')}'\npin_codex_daemon`;
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_DAEMON_PINNED: marker,
        FAKE_VERSION: version,
        FAKE_UPDATE: update,
        FAKE_CALLS: calls,
      },
    });
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: read(calls), marker: read(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const UPDATE = 'app-server daemon update --from-cli --yes\n';

test('a CLI never matched pins the service and records the version', () => {
  const r = run({ version: '0.167.2' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.calls, UPDATE);
  assert.strictEqual(r.marker, '0.167.2\n');
  assert.match(r.stdout, /matched to Codex CLI 0\.167\.2/);
});

test('a CLI already matched starts without touching the service', () => {
  const r = run({ version: '0.167.2', pinned: '0.167.2' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.calls, null);
  assert.strictEqual(r.stdout, '');
});

test('a changed CLI version, newer or a rollback, pins again', () => {
  for (const [version, pinned] of [['0.167.2', '0.167.1'], ['0.167.1', '0.167.2']]) {
    const r = run({ version, pinned });
    assert.strictEqual(r.calls, UPDATE, `${pinned} -> ${version}`);
    assert.strictEqual(r.marker, `${version}\n`);
  }
});

test('no service installed yet: nothing to match, nothing recorded, nothing said', () => {
  const r = run({ update: 'missing' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.calls, UPDATE);
  assert.strictEqual(r.marker, null);
  assert.strictEqual(r.stdout + r.stderr, '');
});

test('a failed pin is reported, not recorded, and never stops the console', () => {
  const r = run({ version: '0.167.2', pinned: '0.167.1', update: 'fail' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.marker, '0.167.1\n');
  assert.match(r.stderr, /could not match it to Codex CLI 0\.167\.2: Error: install lock busy\n$/);
});

test('without a CLI to ask, nothing runs', () => {
  const r = run({ version: '' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.calls, null);
});
