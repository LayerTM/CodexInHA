'use strict';

// The bearer of one prompt run crosses the add-on in a file: the core calls
// `prompt.writeMcpConfig` to put the endpoint and the run's bearer somewhere, names that
// file in the run spec, and `runner.relay` reads it back when the run is launched. The two
// halves are written in different files (adapter/index.js and adapter/runner.js) and nothing
// but agreement on one key name makes them work — rename it on ONE side and every run is
// launched with no Home Assistant server, or with an empty bearer, which the relay answers
// with 401 and the model then reports as "the live-context tool isn't available".
//
// This test is the contract, not two calls in a row: it asserts only that what one half WROTE
// is what the other half READ. A coordinated rename of the key stays legal, because the core
// never looks inside the file; a one-sided rename turns this red.
//
// It lives in test/assembled/ because runner.js loads a module that arrives with the core.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapter = require('../../adapter/index.js');
const runner = require('../../adapter/runner.js');

const URL = 'http://127.0.0.1:8099/mcp';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ha-mcp-contract-'));

// Bearers the core is free to mint. The odd ones are here because a token is a byte string, not
// an identifier: base64url padding, a trailing newline and surrounding spaces have all been the
// difference between "the same string" and 401 in somebody's add-on.
const BEARERS = [
  'plain-token',
  'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=',
  'has spaces inside',
  '  leading and trailing spaces  ',
  'trailing-newline\n',
  'odd/chars+and=padding~tilde.dot_underscore',
  'x'.repeat(4096),
];

test('what writeMcpConfig wrote is what relay reads, byte for byte', async () => {
  for (const bearer of BEARERS) {
    const dir = tmp();
    const file = await adapter.prompt.writeMcpConfig({ dir, url: URL, bearer });
    assert.ok(file, `a bearer must produce a file: ${JSON.stringify(bearer)}`);
    const back = runner.relay(file);
    assert.ok(back, `relay must read the file writeMcpConfig wrote: ${JSON.stringify(bearer)}`);
    assert.equal(back.token, bearer, `bearer changed in transit: ${JSON.stringify(bearer)}`);
    assert.equal(back.url, URL);
    // A value the writer puts in the file and the reader silently drops is a divergence with no
    // voice: both halves keep working, and the extra value simply never crosses. Counting keys
    // rather than naming them keeps the names out of the contract, which stays about values.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.keys(onDisk).length, Object.keys(back).length,
      `the file carries a value the relay drops: ${JSON.stringify(bearer)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relay reads the file at the path writeMcpConfig returned, not a name of its own', async () => {
  const dir = tmp();
  const file = await adapter.prompt.writeMcpConfig({ dir, url: URL, bearer: 'the-run-bearer' });
  // The path is the contract too: the core passes this exact string on as the spec's
  // mcpConfigPath, so a file written under one name and looked for under another would leave
  // every run without a server while both halves still "worked" on their own.
  assert.equal(runner.relay(file).token, 'the-run-bearer');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no bearer and no url leave no file behind, and relay says so', async () => {
  for (const [url, bearer] of [[URL, ''], ['', 'tok'], ['', '']]) {
    const dir = tmp();
    // The file must EXIST first, or "it is gone" would pass on a file that was never written —
    // which is how this test read before prove-control was pointed at it.
    const file = await adapter.prompt.writeMcpConfig({ dir, url: URL, bearer: 'first' });
    assert.equal(fs.existsSync(file), true, 'a bearer must leave a file to remove');
    assert.equal(await adapter.prompt.writeMcpConfig({ dir, url, bearer }), null);
    assert.equal(fs.existsSync(file), false, 'the previous run\'s bearer must not survive');
    assert.equal(runner.relay(file), null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relay refuses a file that is not the one writeMcpConfig writes', () => {
  const dir = tmp();
  const file = path.join(dir, 'ha-mcp.json');
  for (const body of ['', 'not json', '{}', '{"url":"' + URL + '"}', '{"token":"t"}', '{"url":1,"token":2}']) {
    fs.writeFileSync(file, body);
    assert.equal(runner.relay(file), null, body);
  }
  assert.equal(runner.relay(path.join(dir, 'absent.json')), null);
  assert.equal(runner.relay(undefined), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
