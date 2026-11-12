'use strict';

// A stand-in for the model API, for the behaviour pins: it answers every request
// with one fixed message and records each request (line, then body) in a log. It
// listens on loopback only and reaches nothing.
//
// Usage: node fake-responses-api.js <port> <log file>

const http = require('node:http');
const fs = require('node:fs');

const [port, log] = process.argv.slice(2);
if (!port || !log) {
  console.error('usage: fake-responses-api.js <port> <log file>');
  process.exit(2);
}

const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    fs.appendFileSync(log, `${req.method} ${req.url}\n${body}\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event('response.created', { type: 'response.created', response: { id: 'r1' } }));
    res.write(event('response.output_item.done', {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: 'm1',
        content: [{ type: 'output_text', text: '{"text":"pinned answer"}' }],
      },
    }));
    res.end(event('response.completed', {
      type: 'response.completed',
      response: {
        id: 'r1',
        usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 },
      },
    }));
  });
}).listen(Number(port), '127.0.0.1');
