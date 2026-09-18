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

const js = require('./app/node_modules/@eslint/js');
const globals = require('./app/node_modules/globals');

module.exports = [
  {
    // Only the executables this add-on writes. Everything else here belongs to
    // the core or is not JavaScript.
    ignores: ['app/**', 'ha-tools/**', 'install-tools/**', 'core/**'],
  },
  js.configs.recommended,
  {
    // Named one by one: these files have no extension, so a directory glob does
    // not pick them up.
    files: ['rootfs/usr/local/bin/agent-ask'],
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
