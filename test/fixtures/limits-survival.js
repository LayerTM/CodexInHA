'use strict';

// Runs readAccountLimits in a process of its own against an app-server stand-in
// whose limits payload makes date conversion fail. The process must print the
// result and exit 0; an uncaught error would end it with status 1.

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readAccountLimits } = require('../../codex/app/adapter/limits.js');

const replies = {
  initialize: {},
  'account/read': { account: { type: 'chatgpt' } },
  'account/rateLimits/read': { rateLimits: { limitId: 'codex', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1e14 } } },
};

function spawnFn() {
  const child = /** @type {any} */ (new EventEmitter());
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  let buf = '';
  child.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      // Answered on a later tick, as a real pipe does.
      if (msg.id !== undefined) setImmediate(() => child.stdout.write(`${JSON.stringify({ id: msg.id, result: replies[msg.method] })}\n`));
    }
  });
  return child;
}

readAccountLimits({ bin: 'codex', codexHome: '/nonexistent', spawnFn, timeoutMs: 2000 })
  .then((r) => console.log('result', JSON.stringify(r)));
