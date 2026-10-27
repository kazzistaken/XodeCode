#!/usr/bin/env node
'use strict';

/**
 * xode-mcp — the Director's hands.
 *
 * A tiny MCP server (stdio, newline-delimited JSON-RPC) that gives the
 * Director two native tools instead of a shell:
 *
 *   canvas  read the live canvas (pages, windows, layout, focus)
 *   run     execute a list of actions at once
 *
 * `run` sends every action to the app in one request, so "open two browsers"
 * is one tool call, the actions run together, and the windows settle into a
 * single smooth re-tile. Requests go to the same token-authenticated control
 * bridge the `xode` CLI uses (XODE_CONTROL_URL / XODE_CONTROL_TOKEN).
 */

const http = require('node:http');

const ENDPOINT = process.env.XODE_CONTROL_URL;
const TOKEN = process.env.XODE_CONTROL_TOKEN;

const TOOLS = [
  {
    name: 'canvas',
    description:
      'Read the live canvas: pages, the active page, every window (id, kind, name, title, status, url, rect, tile order), the layout mode, focus and joints. Only needed when the [canvas] snapshot in the message is not enough.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run',
    description:
      'Run one or more app actions at the same time. Put every action for the request in one call. Each action is an object with an "op" and that op\'s fields (see the system prompt). Returns one result per action.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { op: { type: 'string' } },
            required: ['op'],
            additionalProperties: true,
          },
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
  },
];

function post(method, params) {
  return new Promise((resolve, reject) => {
    if (!ENDPOINT || !TOKEN) {
      reject(new Error('no control endpoint — this server only works inside XodeCode'));
      return;
    }
    const body = JSON.stringify({ method, params });
    const url = new URL(ENDPOINT);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(parsed.error || 'command failed'));
          } catch {
            reject(new Error(`unreadable response: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function callTool(name, args) {
  if (name === 'canvas') {
    return { content: [{ type: 'text', text: text(await post('canvas.snapshot', {})) }] };
  }
  if (name === 'run') {
    const actions = Array.isArray(args?.actions) ? args.actions : [];
    if (!actions.length) {
      return { content: [{ type: 'text', text: 'run needs at least one action' }], isError: true };
    }
    const results = await post('batch', { actions });
    const failed = Array.isArray(results) && results.every((result) => result && result.error);
    return { content: [{ type: 'text', text: text(results) }], isError: failed || undefined };
  }
  return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true };
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'xode', version: '1.0.0' },
      });
      return;
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      try {
        reply(id, await callTool(params?.name, params?.arguments || {}));
      } catch (error) {
        reply(id, {
          content: [{ type: 'text', text: String((error && error.message) || error) }],
          isError: true,
        });
      }
      return;
    default:
      // Notifications (no id) need no answer.
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // Handle requests concurrently: a slow action never blocks a canvas read.
    handle(message).catch((error) => {
      if (message.id !== undefined) fail(message.id, -32603, String(error?.message || error));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
