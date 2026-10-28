'use strict';

/**
 * Live test of the shared-context log (XODECODE_TEAMTEST=<dir>
 * XODECODE_TEST_KIND=contextlog). Run with XODECODE_USERDATA=<dir>/profile.
 *
 * Phase "run" (default): a Haiku agent on low effort writes one file, then gets
 * a second message, then a third turn is cancelled mid-way. Each turn must add
 * exactly one entry to <workspace>/.xode/context-log.jsonl, and the open log
 * window must show it without a refresh.
 * Phase "restart" (XODECODE_CLPHASE=restart): a fresh launch on the same
 * profile must list and show the entries written by the first run.
 * Prints CLTEST_* lines.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');

const BOOT_DELAY = 7000;
const TIMEOUT = 180000;

function rpc(url, token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, ...JSON.parse(data || '{}') });
          } catch {
            resolve({ status: response.statusCode, raw: data });
          }
        });
      }
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function runContextLogTest(mainWindow, control) {
  const outDir = process.env.XODECODE_TEAMTEST;
  const phase = process.env.XODECODE_CLPHASE || 'run';
  const workspace = path.join(outDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const jsonl = path.join(workspace, '.xode', 'context-log.jsonl');

  const run = (js) => mainWindow.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (name, value) => console.log(`CLTEST_${name} ${JSON.stringify(value)}`);
  const shot = async (name) => {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  };
  const lines = () => {
    try {
      return fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const summary = (entry) => ({
    id: entry.id,
    agent: entry.agentName,
    model: entry.model,
    status: entry.status,
    prompt: String(entry.prompt || '').slice(0, 60),
    output: String(entry.output || '').slice(0, 80),
    files: entry.filesChanged,
    effort: entry.effort,
    tools: entry.toolCount,
    error: entry.error,
    workspace: entry.workspace,
  });
  // Rows the log window shows: anything carrying a data-id inside the window.
  const viewRows = () =>
    run(`(() => {
      const node = window.__xo.store.allNodes().find((n) => n.kind === 'contextlog');
      if (!node) return { open: false };
      const host = window.__xo.canvas.views.get(node.id)?.el || document;
      const ids = [...host.querySelectorAll('[data-id]')].map((e) => e.dataset.id);
      return { open: true, ids };
    })()`);
  const started = Date.now();
  const deadline = () => Date.now() - started > TIMEOUT;
  await wait(BOOT_DELAY);

  const setWorkspace = await rpc(control.url, control.token, 'batch', { actions: [{ op: 'workspace', path: workspace }] });
  log('WORKSPACE', setWorkspace.result?.[0] || setWorkspace);
  const api = await run(`Boolean(window.api && window.api.contextLog)`);
  log('API', api);

  if (phase === 'restart') {
    const listed = await run(
      `window.api.contextLog.list({ workspace: ${JSON.stringify(workspace)}, limit: 50 }).then((r) => r.map((e) => e.id))`
    );
    log('RESTART_LIST', { onDisk: lines().map((e) => e.id), listed });
    const open = await rpc(control.url, control.token, 'contextlog.open', {});
    log('OPEN', open.result || open);
    await wait(1500);
    log('RESTART_VIEW', await viewRows());
    await shot('contextlog-restart');
    log('DONE', { seconds: Math.round((Date.now() - started) / 1000) });
    app.quit();
    return;
  }

  // Count live events independently of the view.
  await run(`(() => {
    window.__clEvents = [];
    window.api.contextLog.onUpdated((entry) => window.__clEvents.push({ id: entry.id, lagMs: Date.now() - Date.parse(entry.ts) }));
    return true;
  })()`);
  const open = await rpc(control.url, control.token, 'contextlog.open', {});
  log('OPEN', open.result || open);

  const agent = await rpc(control.url, control.token, 'agent.spawn', {
    model: 'haiku',
    effort: 'low',
    prompt: 'Use the Write tool to create hello.txt containing exactly: hi pelican. Then reply with one word: written.',
  });
  const agentId = agent.result?.id;
  log('AGENT', agent.result?.callSign || agent);

  const status = () => run(`window.__xo.store.findNode(${JSON.stringify(agentId)})?.node.status || 'gone'`);
  async function untilIdle(expectEntries) {
    while (!deadline()) {
      await wait(1000);
      const s = await status();
      if (s === 'idle' && lines().length >= expectEntries) return true;
    }
    return false;
  }

  // Turn 1: writes a file.
  let ok = await untilIdle(1);
  await wait(1500);
  log('TURN1', { ok, entries: lines().map(summary) });

  // Turn 2: plain reply.
  await rpc(control.url, control.token, 'agent.send', { agent: agentId, text: 'Reply with exactly: second turn ok' });
  ok = await untilIdle(2);
  await wait(1500);
  log('TURN2', { ok, entries: lines().map(summary) });
  log('VIEW_AFTER_2', await viewRows());
  await shot('contextlog-live');

  // Turn 3: cancelled mid-way, must still be logged once, as interrupted.
  await rpc(control.url, control.token, 'agent.send', {
    agent: agentId,
    text: 'Use the Bash tool to run exactly: ping -n 40 127.0.0.1 — then reply done.',
  });
  for (let i = 0; i < 30 && (await status()) !== 'working'; i++) await wait(300);
  await wait(6000);
  await run(`(window.api.claude.cancel({ nodeId: ${JSON.stringify(agentId)} }), true)`);
  for (let i = 0; i < 20 && lines().length < 3; i++) await wait(500);
  await wait(2000);

  const all = lines();
  const ids = all.map((e) => e.id);
  const events = await run(`window.__clEvents`);
  const view = await viewRows();
  log('FINAL', {
    entries: all.map(summary),
    uniqueIds: new Set(ids).size === ids.length,
    count: all.length,
    events,
    view,
    mdExists: fs.existsSync(path.join(workspace, '.xode', 'context-log.md')),
    fileWritten: fs.existsSync(path.join(workspace, 'hello.txt')),
  });
  await shot('contextlog-final');
  log('DONE', { seconds: Math.round((Date.now() - started) / 1000), timedOut: deadline() });
  app.quit();
}

module.exports = { runContextLogTest };
