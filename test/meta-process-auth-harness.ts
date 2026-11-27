/**
 * Boots the Easy API CLI (src/cli/index.ts) the way bin/server.js does, with
 * one stand-in: create() returns a Client whose kill method is Client.kill and
 * whose other methods are no-ops, so the process reaches listen without
 * launching WhatsApp. Middleware registration order is whatever start() runs.
 */
import Module = require('module');
import path from 'path';
import { Client } from '../src/api/Client';

const apiKey = process.env.OWA_TEST_API_KEY || '';
const allowIps = process.env.OWA_TEST_ALLOW_IPS || 'off';
const port = process.env.OWA_TEST_PORT || '';

const argv = ['--key', apiKey, '--port', port, '--no-generate-api-docs'];
if (allowIps !== 'off') {
  for (const ip of allowIps.split(',').filter(Boolean)) argv.push('--allow-ips', ip);
}
process.argv = [process.execPath, __filename, ...argv];

const client = Object.create(Client.prototype) as Client & Record<string, unknown>;
client.onLogout = () => true;
client.onIncomingCall = async () => true;
client.autoReject = async () => true;
client.registerWebhook = async () => true;
client.onStateChanged = () => true;
client.emitUnreadMessages = async () => true;
client.waitAllQEmpty = async () => true;
client.getSessionInfo = () => ({});
client.getHostNumber = async () => '';
client.getLicenseLink = async () => '';
client.middleware = () => (_req: unknown, res: { status: (code: number) => { end: () => void } }) => {
  res.status(404).end();
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (this: NodeModule, id: string) {
  const loaded = originalRequire.apply(this, arguments as unknown as [string]);
  const filename = this.filename || '';
  const fromCliIndex = filename.endsWith(`${path.sep}src${path.sep}cli${path.sep}index.ts`);
  if (fromCliIndex && (id === '../index' || id === '..')) {
    return Object.assign({}, loaded, {
      create: async () => client,
    });
  }
  return loaded;
};

require('../src/cli/index.ts');

async function waitUntilListening(): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const server = require('../src/cli/server').server;
    const address = server && typeof server.address === 'function' ? server.address() : null;
    if (address && typeof address === 'object' && address.port) {
      if (process.send) process.send({ type: 'ready', port: address.port });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.error('Easy API server did not listen');
  process.exit(1);
}

waitUntilListening().catch((error) => {
  console.error(error);
  process.exit(1);
});
