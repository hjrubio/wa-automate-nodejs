/**
 * Spec for the Easy API docs-path authentication exemption.
 *
 * These tests exercise the real server stack (JSON parser, authentication
 * layer, swagger-ui mount, and Client.middleware) in the same order as
 * src/cli/index.ts. They describe the secure behavior and fail while a
 * request whose path only shares a string prefix with /api-docs or
 * /swagger-stats can invoke a client method without the configured API key.
 *
 * Run:
 *   node --test test/docs-prefix-auth-bypass.test.js
 */
'use strict';

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    esModuleInterop: true,
    skipLibCheck: true,
  },
});

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { Client } = require('../src/api/Client');
const { collections } = require('../src/cli/collections');
const {
  app,
  server,
  setUpExpressApp,
  setupAuthenticationLayer,
  setupApiDocs,
  setupRefocusDisengageMiddleware,
} = require('../src/cli/server');

// Obvious placeholders. These stand in for operator-supplied config fields.
const CONFIGURED_API_KEY = 'PLACEHOLDER_API_KEY';
const PLACEHOLDER_LICENSE_KEY = 'PLACEHOLDER_LICENSE_KEY';
const PLACEHOLDER_CHATWOOT_TOKEN = 'PLACEHOLDER_CHATWOOT_TOKEN';
const WRONG_API_KEY = 'PLACEHOLDER_WRONG_API_KEY';

const SENSITIVE_METHODS = [
  'getConfig',
  'getSessionInfo',
  'sendText',
  'sendFile',
  'registerWebhook',
  'kill',
];

// Paths that start with the exempted string but are not the docs or stats mount.
// Express mount matching (path-to-regexp end:false) requires a segment boundary,
// so these must not be treated as documentation or statistics routes.
const BYPASS_PATHS = [
  '/api-docsX',
  '/api-docsY',
  '/api-docsX/sendText',
  '/api-docs%2FsendText',
  '/api-docs%252FsendText',
  '/swagger-statsX',
  '/swagger-statsY/getConfig',
  '/swagger-stats%2FgetConfig',
];

const calls = Object.create(null);

function resetCalls() {
  for (const name of SENSITIVE_METHODS) calls[name] = 0;
}

function track(client, name, impl) {
  client[name] = function tracked(...args) {
    calls[name] += 1;
    return impl.apply(this, args);
  };
}

function installClient() {
  const createConfig = {
    sessionId: 'session',
    key: CONFIGURED_API_KEY,
    licenseKey: PLACEHOLDER_LICENSE_KEY,
    chatwootApiAccessToken: PLACEHOLDER_CHATWOOT_TOKEN,
    // getConfig scrubs these. They must not be required for the bypass to matter.
    devtools: { user: 'placeholder-user', pass: 'PLACEHOLDER_DEVTOOLS_PASSWORD' },
    sessionData: 'PLACEHOLDER_SESSION_DATA',
    browserWSEndpoint: 'PLACEHOLDER_BROWSER_ENDPOINT',
    proxyServerCredentials: 'PLACEHOLDER_PROXY_CREDENTIALS',
    restartOnCrash: true,
    host: '127.0.0.1',
  };
  const page = { on() {} };
  const client = new Client(page, createConfig, {});
  const realGetConfig = client.getConfig.bind(client);
  const realGetSessionInfo = client.getSessionInfo.bind(client);
  track(client, 'getConfig', realGetConfig);
  track(client, 'getSessionInfo', realGetSessionInfo);
  // Side-effecting methods are replaced with recorders. The middleware still
  // resolves and calls this[method] on this instance; the recorder fails the
  // test if that dispatch happens before any refusal.
  for (const name of ['sendText', 'sendFile', 'registerWebhook', 'kill']) {
    track(client, name, () => ({ recorded: name }));
  }
  return client;
}

// node:test can run cases concurrently. The call counters live on one client,
// so every request through this process is serialized.
let requestChain = Promise.resolve();

function performRequest({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        method,
        path,
        headers: {
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': payload.length,
              }
            : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (err) {
            json = null;
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function postMethodRaw(method, path, headers, body) {
  const run = requestChain.then(async () => {
    resetCalls();
    return performRequest({ method, path, headers, body });
  });
  requestChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function postMethod(path, methodName, headers) {
  const run = requestChain.then(async () => {
    resetCalls();
    return performRequest({
      method: 'POST',
      path,
      headers,
      body: { method: methodName, args: [] },
    });
  });
  requestChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

before(async () => {
  collections.swagger = {
    openapi: '3.0.0',
    info: { title: 'docs-prefix-auth-bypass', version: '0.0.0' },
    paths: {},
  };
  // Same order as src/cli/index.ts when an API key is set and API docs are on
  // (generate-api-docs defaults to true; stats defaults to false).
  setUpExpressApp();
  setupAuthenticationLayer({ key: CONFIGURED_API_KEY });
  setupRefocusDisengageMiddleware({});
  setupApiDocs({ key: CONFIGURED_API_KEY });
  const client = installClient();
  app.use(client.middleware(false));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('API docs remain reachable without the API key', async () => {
  const res = await postMethodRaw('GET', '/api-docs/');
  assert.notEqual(res.status, 401);
  assert.equal(calls.getConfig, 0);
  assert.equal(calls.kill, 0);
});

test('a normal client path without the API key does not run the method', async () => {
  const res = await postMethod('/getConfig');
  assert.equal(calls.getConfig, 0);
  assert.equal(res.status, 401);
  assert.equal(res.json && res.json.error, 'unauthorised');
});

test('a normal client path with the configured API key runs getConfig', async () => {
  const res = await postMethod('/getConfig', 'getConfig', { api_key: CONFIGURED_API_KEY });
  assert.equal(res.status, 200);
  assert.equal(calls.getConfig, 1);
  assert.equal(res.json && res.json.success, true);
  assert.equal(res.json.response.licenseKey, PLACEHOLDER_LICENSE_KEY);
  assert.equal(res.json.response.chatwootApiAccessToken, PLACEHOLDER_CHATWOOT_TOKEN);
  assert.equal(res.json.response.key, CONFIGURED_API_KEY);
  assert.equal(res.json.response.sessionData, undefined);
  assert.equal(res.json.response.devtools, undefined);
});

test('a wrong API key on a normal client path does not run the method', async () => {
  const res = await postMethod('/getConfig', 'getConfig', { api_key: WRONG_API_KEY });
  assert.equal(calls.getConfig, 0);
  assert.equal(res.status, 401);
});

test('the key header is accepted on a normal client path', async () => {
  const res = await postMethod('/sendText', 'sendText', { key: CONFIGURED_API_KEY });
  assert.equal(res.status, 200);
  assert.equal(calls.sendText, 1);
});

test('a path that merely contains the docs prefix is still authenticated', async () => {
  const res = await postMethod('/foo/api-docsX', 'getConfig');
  assert.equal(calls.getConfig, 0);
  assert.equal(res.status, 401);
});

test('POST to the mounted docs path does not dispatch the body method', async () => {
  const res = await postMethod('/api-docs/', 'getConfig');
  assert.equal(calls.getConfig, 0);
  assert.equal(calls.kill, 0);
  // The docs mount may answer this request. It must not be the client method.
  assert.notEqual(res.json && res.json.success, true);
});

for (const methodName of SENSITIVE_METHODS) {
  for (const path of BYPASS_PATHS) {
    test(`unauthenticated POST ${path} must not run ${methodName}`, async () => {
      const res = await postMethod(path, methodName);
      assert.equal(
        calls[methodName],
        0,
        `${methodName} ran ${calls[methodName]} time(s) for ${path} (status ${res.status})`
      );
      assert.equal(res.status, 401);
      assert.equal(res.json && res.json.error, 'unauthorised');
      assert.notEqual(res.json && res.json.success, true);
    });

    test(`wrong API key POST ${path} must not run ${methodName}`, async () => {
      const res = await postMethod(path, methodName, { api_key: WRONG_API_KEY });
      assert.equal(
        calls[methodName],
        0,
        `${methodName} ran ${calls[methodName]} time(s) for ${path} with a wrong key (status ${res.status})`
      );
      assert.equal(res.status, 401);
      assert.notEqual(res.json && res.json.success, true);
    });
  }
}

test('a configured API key still allows a prefix-shaped path to run the named method', async () => {
  const res = await postMethod('/api-docsX', 'getConfig', { api_key: CONFIGURED_API_KEY });
  assert.equal(res.status, 200);
  assert.equal(calls.getConfig, 1);
  assert.equal(res.json && res.json.success, true);
});
