'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../adapter/launch.js');

const FEATURES_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'features-0.154.0.txt'), 'utf8');
const FEATURES = L.parseFeatureList(FEATURES_TEXT);

function disabled(argv) {
  const names = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--disable') names.push(argv[i + 1]);
  return names;
}

function configs(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '-c') values.push(argv[i + 1]);
  return values;
}

function launch(overrides = {}) {
  return L.promptLaunch({
    mode: 'read',
    features: FEATURES,
    workDir: '/run/prompt/w1',
    schemaFile: '/run/prompt/schema.json',
    ...overrides,
  });
}

const HA = { url: 'http://127.0.0.1:8099/mcp', token: 'secret-token-value', tools: ['GetLiveContext'] };

test('the feature list of the measured CLI is read completely', () => {
  assert.equal(FEATURES.length, 140);
  const shell = FEATURES.find((f) => f.name === 'shell_tool');
  assert.deepEqual(shell, { name: 'shell_tool', stage: 'stable', enabled: true });
  assert.ok(FEATURES.some((f) => f.stage === 'under development'));
});

test('an unreadable feature list refuses to produce a profile', () => {
  assert.throws(() => L.parseFeatureList(''), /empty/);
  assert.throws(() => L.parseFeatureList('shell_tool stable maybe\n'), /unreadable/);
  assert.throws(() => L.parseFeatureList('apps stable true\n'), /no shell_tool/);
  assert.throws(() => L.parseFeatureList(`WARNING: something\n${FEATURES_TEXT}`), /unreadable/);
  assert.throws(() => L.parseFeatureList(undefined), /not text/);
});

test('every feature that still exists is disabled except the kept ones', () => {
  const names = disabled(L.promptFeatureArgs(FEATURES));
  const expected = FEATURES
    .filter((f) => f.stage !== 'removed' && !L.KEEP_FEATURES.has(f.name) && !(f.stage === 'deprecated' && !f.enabled))
    .map((f) => f.name);
  assert.deepEqual(names, expected);
  // The same count the live run of this CLI version passed.
  assert.equal(names.length, 99);
  for (const name of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'hooks', 'memories',
    'multi_agent', 'view_image', 'browser_use', 'computer_use', 'image_generation', 'skill_search']) {
    assert.ok(names.includes(name), `${name} must be disabled`);
  }
  assert.ok(!names.includes('code_mode_host'));
  for (const f of FEATURES.filter((x) => x.stage === 'removed')) assert.ok(!names.includes(f.name));
});

test('features are disabled whatever the user configuration switched on or off', () => {
  const flipped = FEATURES.map((f) => ({ ...f, enabled: f.stage === 'deprecated' ? f.enabled : !f.enabled }));
  assert.deepEqual(disabled(L.promptFeatureArgs(flipped)), disabled(L.promptFeatureArgs(FEATURES)));
});

test('a deprecated feature is left alone only while it is off', () => {
  const list = [{ name: 'shell_tool', stage: 'stable', enabled: true },
    { name: 'old_off', stage: 'deprecated', enabled: false },
    { name: 'old_on', stage: 'deprecated', enabled: true }];
  assert.deepEqual(disabled(L.promptFeatureArgs(list, new Set())), ['shell_tool', 'old_on']);
});

test('no dangerous feature can be kept', () => {
  for (const name of L.KEEP_FEATURES) assert.ok(!L.NEVER_KEEP.has(name), name);
  assert.throws(() => L.promptFeatureArgs(FEATURES, new Set(['shell_tool'])), /cannot be kept/);
  assert.throws(() => L.promptFeatureArgs(FEATURES, new Set(['apps'])), /cannot be kept/);
});

test('the prompt profile carries every restricting switch', () => {
  const { argv, cwd, env } = launch();
  assert.equal(argv[0], 'exec');
  for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config']) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.deepEqual(argv.slice(argv.indexOf('--sandbox'), argv.indexOf('--sandbox') + 2), L.PROMPT_SANDBOX_ARGS);
  assert.equal(argv[argv.indexOf('--cd') + 1], '/run/prompt/w1');
  assert.equal(argv[argv.indexOf('--output-schema') + 1], '/run/prompt/schema.json');
  assert.deepEqual(configs(argv), [
    'approval_policy="never"',
    'web_search="disabled"',
    'check_for_update_on_startup=false',
    'project_doc_max_bytes=0',
  ]);
  assert.ok(disabled(argv).includes('shell_tool'));
  assert.equal(argv.at(-1), '-', 'the request text comes from stdin');
  assert.equal(cwd, '/run/prompt/w1');
  assert.deepEqual(env, {});
  // The run carries no approval bypass and no permission switch of its own: the
  // one thing it says about the sandbox is the boundary it really has.
  assert.ok(!argv.includes(L.BYPASS_FLAG));
  assert.ok(!argv.some((a) => /yolo|--full-auto|--approve-for-me|bypass/i.test(a)));
});

// The sandbox a prompt run asks for is the only thing that refuses an
// apply_patch write: measured in the add-on, `read-only` rejected the patch and
// `danger-full-access` wrote the file into the Home Assistant configuration
// directory. So a prompt run must never carry the console's permissive mode,
// and it must keep every denial around it.
test('a prompt run keeps the sandbox that refuses a write, and every denial with it', () => {
  const { argv } = launch();
  assert.deepEqual(L.PROMPT_SANDBOX_ARGS, ['--sandbox', 'read-only']);
  assert.ok(!argv.includes('danger-full-access'), 'never the console\'s permissive mode');
  assert.ok(!argv.some((a) => /yolo|--full-auto|--approve-for-me|bypass/i.test(a)));
  for (const flag of ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config',
    '--ignore-rules', '--strict-config']) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(configs(argv), [
    'approval_policy="never"',
    'web_search="disabled"',
    'check_for_update_on_startup=false',
    'project_doc_max_bytes=0',
  ]);
  const off = disabled(argv);
  // A feature the CLI has removed, or a deprecated one already off by default,
  // is not switched off again — the profile says so and warns otherwise.
  const present = FEATURES.filter((f) => L.NEVER_KEEP.has(f.name) && f.stage !== 'removed'
    && !(f.stage === 'deprecated' && !f.enabled));
  assert.ok(present.length >= 15, 'the fixture still names the features a prompt run denies');
  for (const f of present) assert.ok(off.includes(f.name), `${f.name} stays disabled`);
  for (const name of ['shell_tool', 'unified_exec', 'apps']) assert.ok(off.includes(name), name);
  const ask = L.askLaunch({ features: FEATURES, workDir: '/tmp/ask' }).argv;
  assert.deepEqual(ask.slice(0, 2), ['exec', '--json'], 'the one-shot question uses the same profile');
  assert.deepEqual(ask.slice(ask.indexOf('--sandbox'), ask.indexOf('--sandbox') + 2), L.PROMPT_SANDBOX_ARGS);
});

// The two profiles are two different answers to the same question, and the
// permissive one belongs to the owner's own console alone.
test('the console profile and the prompt profile are not the same boundary', () => {
  assert.deepEqual(L.CONSOLE_SANDBOX_ARGS, ['--sandbox', 'danger-full-access']);
  assert.notDeepEqual(L.CONSOLE_SANDBOX_ARGS, L.PROMPT_SANDBOX_ARGS);
});

// The console is launched by a shell script, not by this module, so the two say
// the same words or the console keeps asking for a sandbox it cannot have.
test('the console launcher declares the same boundary', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'bin', 'start-codex'), 'utf8',
  );
  assert.ok(script.includes(L.CONSOLE_SANDBOX_ARGS.join(' ')), 'the boundary, in the console launcher');
  assert.ok(script.includes(L.BYPASS_FLAG), 'the bypass option, in the console launcher');
});

test('write mode uses the same restrictions as read mode', () => {
  assert.deepEqual(launch({ mode: 'write' }).argv, launch().argv);
});

test('the Home Assistant server gets exactly the allowed tools and the token only in the environment', () => {
  const { argv, env } = launch({ mode: 'write', ha: { ...HA, tools: ['HassTurnOn', 'GetLiveContext', 'HassTurnOn'] } });
  assert.deepEqual(configs(argv).slice(4), [
    'mcp_servers.ha.url="http://127.0.0.1:8099/mcp"',
    'mcp_servers.ha.bearer_token_env_var="CODEX_HA_MCP_TOKEN"',
    'mcp_servers.ha.enabled_tools=["HassTurnOn","GetLiveContext"]',
    'mcp_servers.ha.default_tools_approval_mode="approve"',
  ]);
  assert.deepEqual(env, { CODEX_HA_MCP_TOKEN: 'secret-token-value' });
  assert.ok(!argv.some((a) => a.includes('secret-token-value')));
  assert.equal(argv.at(-1), '-');
});

test('no allowed tool means no server at all', () => {
  for (const ha of [null, undefined, { ...HA, tools: [] }, { ...HA, tools: undefined }]) {
    const { argv, env } = launch({ ha });
    assert.ok(!argv.some((a) => a.startsWith('mcp_servers')), JSON.stringify(ha));
    assert.deepEqual(env, {});
  }
});

test('values that could change the configuration are refused', () => {
  for (const tool of ['a"]', 'x,y', 'a b', '', '-x', 'a\nb', 7]) {
    assert.throws(() => launch({ ha: { ...HA, tools: [tool] } }), /tool name/, String(tool));
  }
  for (const url of ['ftp://x', 'http://a b', '', 'http://x"\n']) {
    assert.throws(() => launch({ ha: { ...HA, url } }), /url/, url);
  }
  assert.throws(() => launch({ ha: { ...HA, token: '' } }), /token/);
  for (const model of ['-c', 'a b', 'x"', 'm'.repeat(65)]) {
    assert.throws(() => launch({ model }), /model/, model);
  }
  assert.throws(() => launch({ workDir: 'relative' }), /absolute/);
  assert.throws(() => launch({ schemaFile: '/x\n/y' }), /absolute/);
  assert.throws(() => launch({ imageFile: 'snap.jpg' }), /absolute/);
  assert.throws(() => launch({ mode: 'console' }), /read or write/);
  // A control character is escaped, not refused: it arrives in text somebody
  // already saved, and one character may not fail the whole request.
  assert.equal(L.tomlString(`a${String.fromCharCode(0)}b`), '"a\\u0000b"');
});

test('model and image are passed as their own arguments', () => {
  const { argv } = launch({ model: 'gpt-5.5', imageFile: '/run/prompt/snap.jpg' });
  assert.equal(argv[argv.indexOf('--model') + 1], 'gpt-5.5');
  assert.equal(argv[argv.indexOf('--image') + 1], '/run/prompt/snap.jpg');
  assert.ok(!launch().argv.includes('--model'));
  assert.ok(!launch().argv.includes('--image'));
});

test('a TOML string is a valid JSON string of the same text', () => {
  for (const s of ['plain', 'quote " and \\ backslash', 'ünïcødé']) assert.equal(JSON.parse(L.tomlString(s)), s);
});

function tmpHomes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const consoleHome = path.join(root, 'console');
  fs.mkdirSync(consoleHome);
  fs.writeFileSync(path.join(consoleHome, 'auth.json'), '{}');
  fs.writeFileSync(path.join(consoleHome, 'AGENTS.md'), 'the user instructions');
  return { root, consoleHome, promptHome: path.join(root, 'prompt') };
}

test('the prompt home holds only a link to the console login', (t) => {
  const { root, consoleHome, promptHome } = tmpHomes();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(L.preparePromptHome(consoleHome, promptHome), promptHome);
  assert.equal(fs.readlinkSync(path.join(promptHome, 'auth.json')), path.join(consoleHome, 'auth.json'));
  assert.equal(fs.statSync(promptHome).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(promptHome), ['auth.json']);
  // Idempotent, and a login written through the link is the console's login.
  L.preparePromptHome(consoleHome, promptHome);
  fs.writeFileSync(path.join(promptHome, 'auth.json'), '{"refreshed":true}');
  assert.equal(fs.readFileSync(path.join(consoleHome, 'auth.json'), 'utf8'), '{"refreshed":true}');
});

test('a wrong link is replaced, a copied login is refused', (t) => {
  const { root, consoleHome, promptHome } = tmpHomes();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(promptHome);
  fs.symlinkSync('/elsewhere/auth.json', path.join(promptHome, 'auth.json'));
  L.preparePromptHome(consoleHome, promptHome);
  assert.equal(fs.readlinkSync(path.join(promptHome, 'auth.json')), path.join(consoleHome, 'auth.json'));
  fs.unlinkSync(path.join(promptHome, 'auth.json'));
  fs.writeFileSync(path.join(promptHome, 'auth.json'), '{}');
  assert.throws(() => L.preparePromptHome(consoleHome, promptHome), /is a file/);
});

test('instructions in the prompt home stop the run', (t) => {
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const { root, consoleHome, promptHome } = tmpHomes();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(promptHome);
    fs.writeFileSync(path.join(promptHome, name), 'x');
    assert.throws(() => L.preparePromptHome(consoleHome, promptHome), new RegExp(name.replace('.', '\\.')));
    fs.unlinkSync(path.join(promptHome, name));
    fs.symlinkSync('/nowhere', path.join(promptHome, name));
    assert.throws(() => L.preparePromptHome(consoleHome, promptHome), /must not exist/, `dangling ${name}`);
  }
});

test("the CLI's own config.toml is cleared, not a reason to refuse", (t) => {
  // The CLI writes one itself: every run records a trust entry for the working
  // directory it was started in. Measured in the sandbox, that file then blocked
  // every following run, so no question was ever answered.
  const { root, consoleHome, promptHome } = tmpHomes();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(promptHome);
  fs.writeFileSync(path.join(promptHome, 'config.toml'),
    '[projects."/data/codex-prompt/run/run-1-2-abc/work"]\ntrust_level = "trusted"\n');
  assert.equal(L.preparePromptHome(consoleHome, promptHome), promptHome);
  assert.deepEqual(fs.readdirSync(promptHome), ['auth.json']);
  // A dangling link by that name goes the same way.
  fs.symlinkSync('/nowhere', path.join(promptHome, 'config.toml'));
  L.preparePromptHome(consoleHome, promptHome);
  assert.deepEqual(fs.readdirSync(promptHome), ['auth.json']);
});

test('the prompt home is never the console home', () => {
  assert.throws(() => L.preparePromptHome('/data/codex', '/data/codex/'), /differ/);
  assert.throws(() => L.preparePromptHome('/data/codex', 'rel'), /absolute/);
});

test('the console is unrestricted: bypass when asked, then the extra arguments as given', () => {
  assert.deepEqual(L.consoleArgs({ bypass_permissions: true, extra_args: ['--search', '-m', 'gpt-5.5'] }),
    [L.BYPASS_FLAG, '--search', '-m', 'gpt-5.5']);
  assert.deepEqual(L.consoleArgs({ bypass_permissions: false, extra_args: ['-c', 'x=1', '', 5, null] }),
    [...L.CONSOLE_SANDBOX_ARGS, '-c', 'x=1']);
  assert.deepEqual(L.consoleArgs({ bypass_permissions: /** @type {any} */ ('true') }), L.CONSOLE_SANDBOX_ARGS);
  assert.deepEqual(L.consoleArgs(undefined), L.CONSOLE_SANDBOX_ARGS);
  assert.equal(L.BYPASS_FLAG, '--dangerously-bypass-approvals-and-sandbox');
});

// The one-shot question the health check and the morning briefing ask is built
// from the same profile as a prompt run. It used to carry its own short list of
// switches, which missed seventeen of the features this one denies.
test('the one-shot question denies everything a prompt run denies', () => {
  const ask = L.askLaunch({ features: FEATURES, workDir: '/tmp/ask' });
  const prompt = L.promptLaunch({
    mode: 'read', features: FEATURES, workDir: '/tmp/ask', schemaFile: '/tmp/s.json',
  });
  assert.deepEqual(disabled(ask.argv), disabled(prompt.argv));
  // Only a feature this CLI still has can be switched off: an unknown name is a
  // startup error, so a name the list no longer carries is not passed at all,
  // and a deprecated switch that is already off is left alone.
  const present = new Set(FEATURES
    .filter((f) => f.stage !== 'removed' && !(f.stage === 'deprecated' && !f.enabled))
    .map((f) => f.name));
  for (const name of L.NEVER_KEEP) {
    if (present.has(name)) assert.ok(disabled(ask.argv).includes(name), `${name} must be disabled`);
  }
});

// Compared on the argv both calls actually produce, not on the feature list
// they were handed: the point of the shared profile is that neither path can
// add or drop a switch of its own.
test('the one-shot question is the prompt profile with nothing added', () => {
  const ask = L.askLaunch({ features: FEATURES, workDir: '/tmp/ask' });
  const prompt = L.promptLaunch({
    mode: 'read', features: FEATURES, workDir: '/tmp/ask', schemaFile: '/tmp/s.json',
  });
  const withoutSchema = [...prompt.argv];
  const at = withoutSchema.indexOf('--output-schema');
  withoutSchema.splice(at, 2);
  assert.deepEqual(ask.argv, withoutSchema);
});

test('the one-shot question carries no schema, no image and no Home Assistant server', () => {
  const { argv } = L.askLaunch({ features: FEATURES, workDir: '/tmp/ask' });
  assert.ok(!argv.includes('--output-schema'));
  assert.ok(!argv.includes('--image'));
  assert.ok(!argv.some((a) => a.startsWith('mcp_servers.')));
  // The prompt arrives on stdin, never as an argument.
  assert.equal(argv[argv.length - 1], '-');
  assert.deepEqual(L.askLaunch({ features: FEATURES, workDir: '/tmp/ask' }).env, {});
});

test('both restricted profiles start in the directory they are given', () => {
  assert.throws(() => L.askLaunch({ features: FEATURES, workDir: 'relative' }), /absolute path/);
  const { argv } = L.askLaunch({ features: FEATURES, workDir: '/tmp/ask' });
  assert.equal(argv[argv.indexOf('--cd') + 1], '/tmp/ask');
});

test('a DELETE character in saved text is escaped, not refused', () => {
  const text = `before${String.fromCharCode(127)}after`;
  assert.equal(L.tomlString(text), '"before\\u007Fafter"');
  assert.equal(L.tomlString('a\nb'), '"a\\nb"');
  assert.throws(() => L.tomlString(7), /must be text/);
});
