'use strict';

/**
 * Unauthenticated callers must not be able to kill or restart the Easy API
 * process, including when an API key and an IP allow-list are configured.
 *
 * These tests fail while POST /meta/process/exit and POST /meta/process/restart
 * are registered before the IP filter and the API-key middleware. They pass
 * once those guards run first and reject the request before Client.kill or
 * process.exit.
 *
 * Run:
 *   node --test --test-concurrency=1 test/meta-process-auth.test.js
 */

const assert = require('assert');
const { fork } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const test = require('node:test');

const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const OUTSIDE_ALLOW_LIST = '203.0.113.10';
// Product listen(port) binds ::. A connection to 127.0.0.1 is reported as this mapped address.
const CALLER_SOCKET_IP = '::ffff:127.0.0.1';
const CONNECT_HOST = '127.0.0.1';
const HARNESS = path.join(__dirname, 'meta-process-auth-harness.ts');
const TS_NODE_REGISTER = require.resolve('ts-node/register/transpile-only');

const ROUTES = ['/meta/process/exit', '/meta/process/restart'];

function post(port, requestPath, headers) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CONNECT_HOST,
        port,
        path: requestPath,
        method: 'POST',
        headers: headers || {},
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            error: null,
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      resolve({ status: 0, body: '', error: error.message });
    });
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, CONNECT_HOST, () => {
      const assigned = probe.address().port;
      probe.close(() => resolve(assigned));
    });
  });
}

function startServer(allowIps, port) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('WA_')) env[key] = value;
  }
  env.OWA_TEST_API_KEY = PLACEHOLDER_API_KEY;
  env.OWA_TEST_ALLOW_IPS = allowIps;
  env.OWA_TEST_PORT = String(port);
  const child = fork(HARNESS, [], {
    cwd: path.join(__dirname, '..'),
    execArgv: ['-r', TS_NODE_REGISTER],
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  let readySettled = false;
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('harness did not listen\n' + stderr));
    }, 30000);
    child.on('message', (message) => {
      messages.push(message);
      if (message && message.type === 'ready') {
        readySettled = true;
        clearTimeout(timer);
        resolve(message.port);
      }
    });
    child.on('exit', (code) => {
      if (!readySettled && code && code !== 0) {
        clearTimeout(timer);
        reject(new Error('harness exited ' + code + '\n' + stderr));
      }
    });
  });
  return { child, messages, ready };
}

async function attack(route, allowIps, headers) {
  const port = await freePort();
  const started = startServer(allowIps, port);
  let exitCode = null;
  started.child.on('exit', (code) => {
    exitCode = code;
  });
  try {
    const port = await started.ready;
    const result = await post(port, route, headers);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const killCalled = started.messages.some(
      (message) =>
        message &&
        message.type === 'process:msg' &&
        message.data &&
        message.data.reason === 'API_KILL'
    );
    return { result, killCalled, exitCode, messages: started.messages };
  } finally {
    if (started.child.exitCode === null) started.child.kill('SIGKILL');
  }
}

function assertClosed(observed, label) {
  const problems = [];
  if (!observed.result || observed.result.status !== 401) {
    problems.push(
      'expected HTTP 401, got status ' +
        (observed.result && observed.result.status) +
        ' error ' +
        (observed.result && observed.result.error) +
        ' body ' +
        JSON.stringify(observed.result && observed.result.body)
    );
  }
  if (observed.killCalled) problems.push('Client.kill ran with API_KILL');
  if (observed.exitCode !== null) problems.push('process exited with code ' + observed.exitCode);
  if (observed.result && /Closing/.test(observed.result.body || '')) {
    problems.push('response body started shutdown');
  }
  assert.equal(problems.length, 0, label + ': ' + problems.join('; '));
}

for (const route of ROUTES) {
  test(route + ' rejects a caller outside the IP allow-list with no API key', async () => {
    const observed = await attack(route, OUTSIDE_ALLOW_LIST, {});
    assertClosed(observed, route + ' outside allow-list, no key');
  });

  test(route + ' rejects a caller when no IP allow-list is configured and no API key is sent', async () => {
    const observed = await attack(route, 'off', {});
    assertClosed(observed, route + ' no allow-list, no key');
  });

  test(route + ' rejects a caller outside the IP allow-list even with the API key header', async () => {
    const observed = await attack(route, OUTSIDE_ALLOW_LIST, {
      api_key: PLACEHOLDER_API_KEY,
    });
    assertClosed(observed, route + ' outside allow-list, key header');
  });

  test(route + ' rejects an allow-listed caller that sends a wrong API key header', async () => {
    const observed = await attack(route, CALLER_SOCKET_IP, {
      api_key: PLACEHOLDER_API_KEY + '-wrong',
    });
    assertClosed(observed, route + ' allow-listed, wrong key');
  });

  test(route + ' rejects an allow-listed caller that puts the API key only in the query string', async () => {
    const observed = await attack(
      route + '?api_key=' + encodeURIComponent(PLACEHOLDER_API_KEY),
      CALLER_SOCKET_IP,
      {}
    );
    assertClosed(observed, route + ' allow-listed, query key');
  });

  test(route + ' rejects a forged forwarded-for address that is on the allow-list', async () => {
    const observed = await attack(route, OUTSIDE_ALLOW_LIST, {
      api_key: PLACEHOLDER_API_KEY,
      'x-forwarded-for': OUTSIDE_ALLOW_LIST,
    });
    assertClosed(observed, route + ' forged forwarded-for');
  });
}
