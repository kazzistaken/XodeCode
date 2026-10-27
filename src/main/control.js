'use strict';

/**
 * A tiny authenticated JSON-RPC bridge on localhost.
 *
 * The hidden Director session runs Claude Code with `XODE_CONTROL_URL` and
 * `XODE_CONTROL_TOKEN` in its environment, so the bundled `xode` CLI can ask
 * the app to open terminals, focus agents, switch pages, and so on.
 *
 * Requests are relayed to the renderer, which owns all app state.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const REQUEST_TIMEOUT = 45000;

function createControlServer({ sendToRenderer, log = console.log }) {
  const token = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  let sequence = 0;
  let url = null;

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        response.writeHead(400).end('bad json');
        return;
      }

      const id = String(payload.id ?? ++sequence);
      try {
        const result = await dispatch(id, payload.method, payload.params || {});
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
      }
    });
  });

  function dispatch(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for the app (${method})`));
      }, REQUEST_TIMEOUT);

      pending.set(id, { resolve, reject, timer });
      sendToRenderer('control:request', { id, method, params });
    });
  }

  function respond({ id, result, error } = {}) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result ?? null);
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        url = `http://127.0.0.1:${port}/rpc`;
        log(`[control] listening on ${url}`);
        resolve({ url, token });
      });
    });
  }

  function stop() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('app is shutting down'));
    }
    pending.clear();
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }

  return {
    start,
    stop,
    respond,
    get url() {
      return url;
    },
    get token() {
      return token;
    },
  };
}

module.exports = { createControlServer };
