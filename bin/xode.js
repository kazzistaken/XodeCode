#!/usr/bin/env node
'use strict';

/**
 * xode — the control surface for XodeCode.
 *
 * Injected into the Director session's environment (XODE_CONTROL_URL /
 * XODE_CONTROL_TOKEN), so Claude can drive the app by running:
 *
 *   node "C:\path\to\XodeCode\bin\xode.js" spawn --prompt "..." --model ...
 *
 * Every command prints a JSON result.
 */

const http = require('node:http');

const ENDPOINT = process.env.XODE_CONTROL_URL;
const TOKEN = process.env.XODE_CONTROL_TOKEN;

if (!ENDPOINT || !TOKEN) {
  console.error(
    'xode: no control endpoint. This CLI only works inside a XodeCode Director session.'
  );
  process.exit(2);
}

const HELP = `xode — control XodeCode

  list                                  List every window on the canvas
  state                                 Full app snapshot
  spawn [--prompt "<task>"] [--model <id>] [--effort <level>] [--title "<short>"] [--cwd "<dir>"]
  terminal [--title "<short>"] [--cwd "<dir>"]     Open a plain shell terminal
  browser --url "<url>" [--title "<short>"]        Open an in-app browser
  browser --node <id> --url "<url>"                Navigate an open browser
  music [--url "<stream>"] [--spotify "<link>"]    Open the music player
  board [--title "<short>"]                        Open the task board
  board list
  board add --title "<task>" [--status todo|doing|done] [--owner "<name>"]
  board move --task "<id|title>" --status <todo|doing|done> [--owner "<name>"]
  board clear
  undo | redo
  select | duplicate
  layout                                           Re-tile every app window side by side
  budget                                           Show spend and the cap
  budget --usd <amount>                            Set the spend cap (0 = off)
  focus --node <id|callSign>
  close --node <id|callSign>
  move --node <id|callSign> --x <n> --y <n>
  resize --node <id|callSign> --w <n> --h <n>
  send --agent <id|callSign> --text "<message>"
  model --agent <id|callSign> --model <id>
  effort --agent <id|callSign> --effort <low|medium|high>
  note --text "<text>" [--x <n>] [--y <n>]
  text --text "<text>" [--x <n>] [--y <n>]
  shape --kind <rect|ellipse|diamond|arrow|line> [--x <n>] [--y <n>] [--w <n>] [--h <n>] [--color <hex>]
  image --path "<file>"
  page --index <n>
  page add
  page rename --name "<name>" [--index <n>]
  page close [--index <n>]
  zoom --scale <n> | zoom in | zoom out | zoom reset
  theme --id <graphite|slate|ash>
  open --target <settings|map|director>
  notify --text "<message>"
  workspace
  workspace --path "<dir>"
  joint new --name "<name>"
  joint list
  joint spawn --joint "<name>" --role "<role>" --model <id> --effort <level> [--title "<short>"] [--prompt "<subtask>"]
  joint context get --joint "<name>"
  joint context set --joint "<name>" --text "<brief>"
  joint context append --joint "<name>" --text "<text>"
  context get
  context set --text "<brief>"
  context append --text "<text>"
  clear
  tidy
`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function resolveRequest(rest, flags) {
  const command = rest[0];
  const sub = rest[1];
  const num = (value) => (value === undefined ? undefined : Number(value));

  switch (command) {
    case 'list':
      return ['nodes.list', {}];
    case 'state':
      return ['app.state', {}];
    case 'spawn':
      return [
        'agent.spawn',
        {
          prompt: flags.prompt || '',
          model: flags.model,
          effort: flags.effort,
          title: flags.title,
          cwd: flags.cwd,
        },
      ];
    case 'terminal':
      return ['terminal.open', { title: flags.title, cwd: flags.cwd }];
    case 'browser':
      return flags.node
        ? ['browser.navigate', { node: flags.node, url: flags.url }]
        : ['browser.open', { url: flags.url, title: flags.title }];
    case 'music':
      return ['music.open', { url: flags.url, spotify: flags.spotify, title: flags.title }];
    case 'board': {
      if (sub === 'list') return ['board.list', {}];
      if (sub === 'add') {
        return ['board.add', { title: flags.title, status: flags.status, owner: flags.owner }];
      }
      if (sub === 'move') {
        return ['board.move', { task: flags.task, status: flags.status, owner: flags.owner }];
      }
      if (sub === 'clear') return ['board.clear', {}];
      return ['board.open', { title: flags.title }];
    }
    case 'undo':
      return ['canvas.undo', {}];
    case 'redo':
      return ['canvas.redo', {}];
    case 'select':
      return ['canvas.select', {}];
    case 'duplicate':
      return ['canvas.duplicate', {}];
    case 'layout':
      return ['layout.apply', {}];
    case 'budget':
      return flags.usd !== undefined ? ['budget.set', { usd: num(flags.usd) }] : ['budget.get', {}];
    case 'focus':
      return ['node.focus', { node: flags.node || flags.agent }];
    case 'close':
      return ['node.close', { node: flags.node || flags.agent }];
    case 'move':
      return ['node.move', { node: flags.node || flags.agent, x: num(flags.x), y: num(flags.y) }];
    case 'resize':
      return ['node.resize', { node: flags.node || flags.agent, w: num(flags.w), h: num(flags.h) }];
    case 'send':
      return ['agent.send', { agent: flags.agent, text: flags.text }];
    case 'model':
      return ['agent.model', { agent: flags.agent, model: flags.model }];
    case 'effort':
      return ['agent.effort', { agent: flags.agent, effort: flags.effort }];
    case 'note':
      return ['note.add', { text: flags.text, x: num(flags.x), y: num(flags.y) }];
    case 'text':
      return ['text.add', { text: flags.text, x: num(flags.x), y: num(flags.y) }];
    case 'shape':
      return [
        'shape.add',
        {
          kind: flags.kind,
          x: num(flags.x),
          y: num(flags.y),
          w: num(flags.w),
          h: num(flags.h),
          color: flags.color,
        },
      ];
    case 'image':
      return ['image.add', { path: flags.path }];
    case 'page':
      if (sub === 'add') return ['page.add', {}];
      if (sub === 'rename') return ['page.rename', { index: num(flags.index), name: flags.name }];
      if (sub === 'close') return ['page.close', { index: num(flags.index) }];
      return ['app.page', { index: num(flags.index) }];
    case 'zoom':
      if (sub === 'in') return ['zoom.set', { factor: 1.25 }];
      if (sub === 'out') return ['zoom.set', { factor: 0.8 }];
      if (sub === 'reset') return ['zoom.set', { reset: true }];
      return ['zoom.set', { scale: num(flags.scale) }];
    case 'theme':
      return ['theme.set', { id: flags.id }];
    case 'context':
      if (sub === 'get') return ['context.get', {}];
      if (sub === 'set') return ['context.set', { text: flags.text }];
      if (sub === 'append') return ['context.append', { text: flags.text }];
      throw new Error('context needs: get | set --text "…" | append --text "…"');
    case 'notify':
      return ['app.notify', { text: flags.text }];
    case 'workspace':
      return flags.path ? ['workspace.set', { path: flags.path }] : ['workspace.get', {}];
    case 'joint': {
      if (sub === 'new') return ['joint.create', { name: flags.name }];
      if (sub === 'list') return ['joint.list', {}];
      if (sub === 'spawn') {
        return [
          'joint.spawn',
          {
            joint: flags.joint,
            role: flags.role,
            model: flags.model,
            effort: flags.effort,
            title: flags.title,
            prompt: flags.prompt,
            cwd: flags.cwd,
          },
        ];
      }
      if (sub === 'context') {
        const verb = rest[2];
        if (verb === 'get') return ['joint.context.get', { joint: flags.joint }];
        if (verb === 'set') return ['joint.context.set', { joint: flags.joint, text: flags.text }];
        if (verb === 'append') {
          return ['joint.context.append', { joint: flags.joint, text: flags.text }];
        }
        throw new Error('joint context needs: get | set --text "…" | append --text "…"');
      }
      throw new Error('joint needs: new | list | spawn | context');
    }
    case 'open':
      return ['app.open', { target: flags.target }];
    case 'clear':
      return ['app.clear', {}];
    case 'tidy':
      return ['app.tidy', {}];
    default:
      throw new Error(`unknown command "${command || ''}"`);
  }
}

function post(method, params) {
  return new Promise((resolve, reject) => {
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

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }

  const { flags, rest } = parse(argv);
  let method;
  let params;
  try {
    [method, params] = resolveRequest(rest, flags);
  } catch (error) {
    console.error(`xode: ${error.message}`);
    process.exit(1);
    return;
  }

  try {
    const result = await post(method, params);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`xode: ${error.message}`);
    process.exit(1);
  }
}

main();
