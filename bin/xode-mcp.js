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
 *
 * With XODE_MCP_MODE=agent it instead serves one Claude agent its canvas and
 * browser tools (plus the team tools with XODE_MCP_TEAM=1), using that agent's
 * own token so the app knows who is asking.
 */

const http = require('node:http');

const ENDPOINT = process.env.XODE_CONTROL_URL;
const TOKEN = process.env.XODE_CONTROL_TOKEN;
// "agent" mode serves one Claude agent instead of the Director; team members
// ("team" mode, or XODE_MCP_TEAM=1) also get the team tools.
const MODE = process.env.XODE_MCP_MODE || '';
const AGENT_MODE = MODE === 'agent' || MODE === 'team';
const WITH_TEAM = MODE === 'team' || process.env.XODE_MCP_TEAM === '1';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

const WINDOW_ARG = {
  type: 'string',
  description: 'The browser window: its id or name from the canvas tool (or from browser_open).',
};
const TARGET_ARGS = {
  ref: { type: 'number', description: 'Element number from browser_read.' },
  selector: { type: 'string', description: 'CSS selector, if there is no ref.' },
  text: { type: 'string', description: 'Visible text of the element, if there is no ref or selector.' },
};

/**
 * Canvas and browser tools for every Claude agent. Anyone may look at the
 * canvas and read any browser; only windows the agent opened (or, for a team
 * lead, its team's windows) can be driven or closed. The app enforces this.
 */
const AGENT_TOOLS = [
  {
    name: 'canvas',
    description:
      'List the windows on your canvas page: id, kind, name, title, url, who owns it, and which are yours.',
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    method: 'tool.canvas',
  },
  {
    name: 'browser_open',
    description:
      'Open a new browser window on the canvas (max 3 of your own). Use it to view web work, e.g. http://localhost:5173. Waits for the page to load.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    method: 'tool.browser_open',
  },
  {
    name: 'navigate',
    description: 'Send one of your browser windows to a URL, or "back" / "forward" / "reload". Waits for the load.',
    inputSchema: {
      type: 'object',
      properties: { window: WINDOW_ARG, url: { type: 'string' } },
      required: ['window', 'url'],
      additionalProperties: false,
    },
    method: 'tool.navigate',
  },
  {
    name: 'browser_read',
    description:
      'Read a browser window: url, title, visible text, and numbered interactive elements (links, buttons, inputs) to use with browser_click / browser_type. Works on any browser on the canvas.',
    inputSchema: {
      type: 'object',
      properties: { window: WINDOW_ARG },
      required: ['window'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    method: 'tool.browser_read',
  },
  {
    name: 'browser_screenshot',
    description: 'See a browser window as an image. Works on any browser on the canvas.',
    inputSchema: {
      type: 'object',
      properties: { window: WINDOW_ARG },
      required: ['window'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    method: 'tool.browser_screenshot',
  },
  {
    name: 'browser_click',
    description: 'Click an element in one of your browser windows (by ref from browser_read, selector, or text).',
    inputSchema: {
      type: 'object',
      properties: { window: WINDOW_ARG, ...TARGET_ARGS },
      required: ['window'],
      additionalProperties: false,
    },
    method: 'tool.browser_click',
  },
  {
    name: 'browser_type',
    description: 'Type into an input in one of your browser windows; submit:true presses Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        window: WINDOW_ARG,
        ...TARGET_ARGS,
        value: { type: 'string', description: 'What to type (replaces the current value).' },
        submit: { type: 'boolean' },
      },
      required: ['window', 'value'],
      additionalProperties: false,
    },
    method: 'tool.browser_type',
  },
  {
    name: 'browser_eval',
    description: 'Run JavaScript in one of your browser windows and get the result back as JSON.',
    inputSchema: {
      type: 'object',
      properties: { window: WINDOW_ARG, code: { type: 'string', description: 'An expression or IIFE.' } },
      required: ['window', 'code'],
      additionalProperties: false,
    },
    method: 'tool.browser_eval',
  },
  {
    name: 'note',
    description: 'Pin a sticky note on the canvas for the user (status, a link, a summary).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    method: 'tool.note',
  },
  {
    name: 'close_window',
    description: 'Close a window you opened (a browser or note).',
    inputSchema: {
      type: 'object',
      properties: { window: WINDOW_ARG },
      required: ['window'],
      additionalProperties: false,
    },
    method: 'tool.close',
  },
];

/**
 * Team tools. The app knows which window is calling (each agent has its own
 * token) and refuses anything above the caller's rank, so these are listed to
 * every member; the descriptions say which are lead-only.
 */
const TEAM_TOOLS = [
  {
    name: 'team',
    description:
      'See your team: your rank (lead or worker), the lead, every member with status and title, their latest reports, and the shared brief path.',
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    method: 'team.info',
  },
  {
    name: 'report',
    description:
      'Report up the chain. Workers report to their lead; the lead reports to the Director. Use "done" when your task is finished, "blocked" when you need something, "question" to ask, "progress" for a short update.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'blocked', 'question', 'progress'] },
        text: { type: 'string', description: 'One or two sentences.' },
      },
      required: ['status', 'text'],
      additionalProperties: false,
    },
    method: 'team.report',
  },
  {
    name: 'spawn_worker',
    description:
      'Lead only. Start a new worker in your team (max 4 workers). Give it a concrete task and the files it owns.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Short role, e.g. "API routes".' },
        prompt: { type: 'string', description: 'The worker\'s task.' },
        model: { type: 'string', description: 'Optional: sonnet (default) or opus.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['role', 'prompt'],
      additionalProperties: false,
    },
    method: 'team.spawn',
  },
  {
    name: 'prompt_worker',
    description: 'Lead only. Send a message or a new task to one of your own workers.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'The worker\'s name (call sign) or id.' },
        text: { type: 'string' },
      },
      required: ['worker', 'text'],
      additionalProperties: false,
    },
    method: 'team.prompt',
  },
  {
    name: 'brief',
    description: 'Lead only. Replace or append to the team\'s shared brief.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        append: { type: 'boolean', description: 'Append instead of replacing.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    method: 'team.brief',
  },
];

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

/** The tools this agent sees: canvas/browser tools, plus team tools in a team. */
function agentTools() {
  return WITH_TEAM ? [...AGENT_TOOLS, ...TEAM_TOOLS] : AGENT_TOOLS;
}

async function callAgentTool(name, args) {
  const tool = agentTools().find((entry) => entry.name === name);
  if (!tool) return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true };
  const result = await post(tool.method, args);
  // Screenshots come back as an image the model can look at.
  if (result && result.image && result.image.data) {
    return {
      content: [
        { type: 'image', data: result.image.data, mimeType: result.image.mime || 'image/jpeg' },
        { type: 'text', text: result.caption || 'screenshot' },
      ],
    };
  }
  if (result && typeof result.text === 'string' && Object.keys(result).length === 1) {
    return { content: [{ type: 'text', text: result.text }] };
  }
  return { content: [{ type: 'text', text: text(result) }] };
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
      reply(id, {
        tools: AGENT_MODE ? agentTools().map(({ method: _method, ...tool }) => tool) : TOOLS,
      });
      return;
    case 'tools/call':
      try {
        reply(
          id,
          AGENT_MODE
            ? await callAgentTool(params?.name, params?.arguments || {})
            : await callTool(params?.name, params?.arguments || {})
        );
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
