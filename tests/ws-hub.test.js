import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { createEventBus } from '../server/lib/event-bus.js';
import { attachWsHub } from '../server/ws/hub.js';

function makeClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  async function next() {
    if (queue.length) return queue.shift();
    return new Promise(resolve => waiters.push(resolve));
  }
  async function open() {
    if (ws.readyState === 1) return;
    await new Promise(r => ws.once('open', r));
  }
  return { ws, open, next };
}

describe('ws hub', () => {
  let server;
  let hub;
  let bus;
  let port;

  beforeAll(async () => {
    bus = createEventBus();
    server = http.createServer();
    hub = attachWsHub(server, { eventBus: bus });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  afterAll(async () => {
    hub.close();
    await new Promise(r => server.close(r));
  });

  it('sends hello on connect', async () => {
    const c = makeClient(port);
    await c.open();
    const hello = await c.next();
    expect(hello.type).toBe('hello');
    c.ws.close();
  });

  it('broadcasts published events', async () => {
    const c = makeClient(port);
    await c.open();
    await c.next(); // hello
    bus.publish('test.event', { hello: 'world' });
    const msg = await c.next();
    expect(msg.type).toBe('test.event');
    expect(msg.hello).toBe('world');
    c.ws.close();
  });

  it('responds to ping with pong', async () => {
    const c = makeClient(port);
    await c.open();
    await c.next(); // hello
    c.ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await c.next();
    expect(msg.type).toBe('pong');
    c.ws.close();
  });
});
