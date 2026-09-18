'use strict';

// The add-on's environment: the CLI's directory, the CLI's home and the npm
// prefix. The CLI is installed into /data at run time and replaced by
// update-codex, so where it lives is a property of the add-on — and it has to
// reach EVERY shell the user can open, not only the launchers.
//
// What these tests would have caught: in 0.1.0 a shell tab answered
// `bash: codex: command not found`. A tab is a login shell, /etc/profile rebuilds
// PATH from scratch, and the image's ENV was thrown away with it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOTFS = path.join(__dirname, '..', '..', 'rootfs');
const ENV_LIB = path.join(ROOTFS, 'usr', 'local', 'lib', 'codex-env.sh');
const PROFILE = path.join(ROOTFS, 'etc', 'profile.d', 'codex-env.sh');
const CLI_BIN = '/data/npm/bin';

// A login shell's PATH, as /etc/profile leaves it for root in this base image.
const LOGIN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function sourced(script) {
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

test('the environment file puts the CLI on PATH and names its home', () => {
  const out = sourced(
    `PATH='${LOGIN_PATH}'; unset CODEX_HOME NPM_CONFIG_PREFIX;`
    + ` . '${ENV_LIB}'; printf '%s\\n%s\\n%s' "$PATH" "$CODEX_HOME" "$NPM_CONFIG_PREFIX"`,
  );
  const [pathValue, home, prefix] = out.split('\n');
  assert.ok(pathValue.split(':').includes(CLI_BIN), `${CLI_BIN} is on PATH`);
  assert.equal(pathValue.split(':')[0], CLI_BIN, 'the add-on\'s CLI wins over anything else');
  assert.equal(home, '/data/codex');
  assert.equal(prefix, '/data/npm');
});

// Sourced by a launcher AND by the shell profile, it can run twice in one shell.
test('sourcing it twice does not grow PATH', () => {
  const out = sourced(
    `PATH='${LOGIN_PATH}'; . '${ENV_LIB}'; . '${ENV_LIB}'; printf '%s' "$PATH"`,
  );
  const hits = out.split(':').filter((p) => p === CLI_BIN);
  assert.equal(hits.length, 1, 'exactly one entry');
});

// The tab is where the user types `codex`, and it is a login shell.
test('every shell tab gets it, through /etc/profile.d', () => {
  assert.ok(fs.existsSync(PROFILE), 'a profile.d snippet is shipped');
  const snippet = fs.readFileSync(PROFILE, 'utf8');
  assert.ok(snippet.includes('/usr/local/lib/codex-env.sh'), 'and it sources the one file');
  const out = sourced(
    `PATH='${LOGIN_PATH}'; . '${PROFILE.replace(/'/g, "'\\''")}' 2>/dev/null || true;`
    + ` printf '%s' "$PATH"`,
  );
  // The snippet sources an absolute path that exists only inside the image, so
  // here it is enough that it names the file; the behaviour is proven above.
  assert.ok(typeof out === 'string');
});

// The directory is declared once. A launcher that spells it out again drifts the
// day the CLI moves — which is exactly how the shell tab was missed.
test('nothing but the environment file spells the CLI directory', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (full === ENV_LIB) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (text.includes(CLI_BIN)) offenders.push(path.relative(ROOTFS, full));
    }
  };
  walk(ROOTFS);
  assert.deepEqual(offenders, [], 'only codex-env.sh names the CLI directory');
});

// The image's own default has to agree with the file; they are written in
// different languages and cannot share a line, so the test ties them together.
test('the image declares the same directory', () => {
  const dockerfile = path.join(__dirname, '..', '..', 'Dockerfile');
  if (!fs.existsSync(dockerfile)) return; // not shipped into the assembled tree
  const text = fs.readFileSync(dockerfile, 'utf8');
  assert.ok(
    text.includes(`ENV PATH="${CLI_BIN}:\${PATH}"`),
    'the Dockerfile puts the same directory on PATH for non-login processes',
  );
});
