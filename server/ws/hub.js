import { WebSocketServer } from 'ws';
import { logger } from '../lib/logger.js';
import { authorizeWsUpgrade } from '../middleware/auth.js';

export function attachWsHub(server, { eventBus, webConfig }) {
  // noServer: true lets us handle the upgrade manually so we can reject
  // unauthorized connections with a proper 401 before the WS handshake completes.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    // Only accept `/ws` exactly (not sub-paths like /ws/pty — those are handled by their own routers)
    const pathOnly = (req.url || '').split('?')[0];
    if (pathOnly !== '/ws') return;
    if (webConfig && !authorizeWsUpgrade(req, webConfig)) {
      logger.warn('ws: upgrade rejected (auth)');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  function broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(json);
    }
  }

  const unsubscribe = eventBus.subscribe(({ topic, payload, ts }) => {
    broadcast({ type: topic, ...payload, ts });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info({ total: clients.size }, 'ws: client connected');
    ws.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString() }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
      } catch (err) {
        logger.warn({ err }, 'ws: invalid message');
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info({ total: clients.size }, 'ws: client disconnected');
    });
  });

  return {
    broadcast,
    close() {
      unsubscribe();
      wss.close();
    }
  };
}
