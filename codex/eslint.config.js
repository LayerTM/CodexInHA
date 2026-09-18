'use strict';

// The add-on's executables that are Node, not shell: they live in rootfs/ and
// are installed as commands, so they are outside app/ and the console's own
// config never sees them. A script that belongs to no linter is one nobody
// checks, which is how `agent-ask` — a shell script until it started building
// its command from the adapter — could have slipped out of shellcheck and into
// nothing.
//
// This config is read from the assembled tree's root, where app/ and rootfs/
// sit side by side; it is not part of rootfs/, so it is never shipped in the
// image.
//
// The files are found the same way `.github/scripts/lint_targets.py` finds
// them — by the interpreter on their first line — because a list written by
// hand here would be a second place declaring which files are Node, and the
// two would drift. These files have no extension, and a directory glob does
// not enable linting for one, so each is named from what was found.
// Measured on ESLint 9: a file ESLint has no configuration for is reported as
// a WARNING and the run still exits 0, so the step that runs this config also
// passes --max-warnings=0 and a file that slipped past both fails loudly.

const fs = require('node:fs');
const path = require('node:path');
const js = require('./app/node_modules/@eslint/js');
const globals = require('./app/node_modules/globals');

const BIN = 'rootfs/usr/local/bin';

function nodeExecutables() {
  let names;
  try {
    names = fs.readdirSync(BIN);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      let head;
      try {
        head = fs.readFileSync(path.join(BIN, name), 'utf8').slice(0, 128).split('\n', 1)[0];
      } catch {
        return false;
      }
      return /^#!\s*\S*\b(env\s+)?node\b/.test(head);
    })
    .sort()
    .map((name) => `${BIN}/${name}`);
}

module.exports = [
  {
    // Everything else in the assembled tree belongs to the core, is not
    // JavaScript, or has its own configuration inside app/.
    ignores: ['app/**', 'ha-tools/**', 'install-tools/**', 'core/**'],
  },
  js.configs.recommended,
  {
    files: nodeExecutables(),
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
      'no-shadow': 'error',
    },
  },
];
