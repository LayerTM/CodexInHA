'use strict';

// The MCP registration the core drives through the engine hooks: add, ask, remove.
// The core re-registers a server whose credentials changed, which it can only do
// if the adapter removes the old registration first.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'lib');

// A stand-in `codex` that keeps its registered servers in a file, so the real
// hook functions run against it. Like the real CLI, removing a server that is
// not registered fails.
const FAKE_CODEX = `#!/bin/bash
store="$FAKE_STORE"
[ "$1" = mcp ] || exit 2
case "$2" in
  add) echo "$3" >> "$store" ;;
  list) cat "$store" 2>/dev/null ;;
  remove)
    kept=()
    found=1
    while IFS= read -r line; do
      if [ "$line" = "$3" ]; then found=0; else kept+=("$line"); fi
    done < <(cat "$store" 2>/dev/null)
    [ "$found" = 0 ] || exit 1
    printf '%s\\n' "\${kept[@]}" > "$store"
    ;;
  *) exit 2 ;;
esac
`;

function withHooks(body, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-hooks-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'codex'), FAKE_CODEX, { mode: 0o755 });
    // The hooks source their environment file by its image path.
    const hooks = fs.readFileSync(path.join(LIB, 'engine-hooks.sh'), 'utf8')
      .replace('. /usr/local/lib/codex-env.sh', `. '${path.join(LIB, 'codex-env.sh')}'`);
    fs.writeFileSync(path.join(dir, 'engine-hooks.sh'), hooks);
    return execFileSync('bash', ['-c', `. '${path.join(dir, 'engine-hooks.sh')}'\nPATH='${path.join(dir, 'bin')}':$PATH\n${body}`], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_STORE: path.join(dir, 'servers'), ...extraEnv },
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('engine_mcp_remove removes a registered server and leaves the others', () => {
  const out = withHooks(
    'engine_mcp_add alpha -- x; engine_mcp_add hass-mcp -- y;'
    + ' engine_mcp_remove hass-mcp;'
    + ' for n in alpha hass-mcp; do engine_mcp_has $n && echo "has $n" || echo "no $n"; done',
  );
  assert.equal(out, 'has alpha\nno hass-mcp');
});

test('engine_mcp_remove reports a server that is not registered', () => {
  assert.equal(withHooks('engine_mcp_remove ghost && echo ok || echo failed'), 'failed');
});

// `codex exec` (every Prompt API run) reads its API key from CODEX_API_KEY only; the
// add-on used to export OPENAI_API_KEY, which the CLI does not read for model
// authentication, so the api_key option never signed anything in.
const authenticated = (apiKey) => withHooks(
  'bashio::config() { printf %s "$SUPPLIED_OPTION"; }; bashio::var.has_value() { [ -n "$1" ]; };'
  + ' bashio::log.info() { :; }; bashio::log.notice() { :; }; ENGINE_STATE_DIR=/nonexistent;'
  + ' engine_auth; printf "%s|%s" "${CODEX_API_KEY-unset}" "${OPENAI_API_KEY-unset}"',
  { SUPPLIED_OPTION: apiKey },
);

test('engine_auth exports the api_key option as the variable codex exec reads', () => {
  assert.equal(authenticated('sk-test-not-a-real-key-0000000000000000'), 'sk-test-not-a-real-key-0000000000000000|unset');
});

test('engine_auth exports no key when the option is empty', () => {
  assert.equal(authenticated(''), 'unset|unset');
});

test('the shell hook and the adapter name the same key variable', () => {
  const { API_KEY_ENV } = require('../adapter/cli.js');
  const hook = fs.readFileSync(path.join(LIB, 'engine-hooks.sh'), 'utf8');
  assert.match(hook, new RegExp(`export ${API_KEY_ENV}=`));
});
