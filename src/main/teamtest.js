'use strict';

/**
 * Lightweight live test of the team hierarchy (phases 1-4), enabled with
 * XODECODE_TEAMTEST=<output dir>. Run it with XODECODE_USERDATA pointing at a
 * throwaway profile so the real canvas is untouched.
 *
 * Uses Haiku on low effort with tiny prompts: one lead spawns one worker, the
 * worker reports done, the lead reports up to the Director. Also checks that a
 * worker's token is refused anything above its rank. Prints TEAMTEST_* lines.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');

const BOOT_DELAY = 7000;
const TIMEOUT = 240000;

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

async function runTeamTest(mainWindow, control) {
  const outDir = process.env.XODECODE_TEAMTEST;
  fs.mkdirSync(outDir, { recursive: true });
  const workspace = path.join(outDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const run = (js) => mainWindow.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (name, value) => console.log(`TEAMTEST_${name} ${JSON.stringify(value)}`);
  const shot = async (name) => {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  };
  const state = () =>
    run(`(() => {
      const s = window.__xo.store;
      const nodes = s.allNodes().filter((n) => n.joint);
      const joint = Object.values(s.joints)[0] || null;
      return {
        members: nodes.map((n) => ({ id: n.id, callSign: n.callSign, rank: n.rank, status: n.status, report: n.lastReport })),
        tasks: joint ? (joint.tasks || []).map((t) => ({ owner: t.owner, status: t.status, title: t.title.slice(0, 50) })) : [],
        spend: joint ? joint.spend || 0 : 0,
        chips: [...document.querySelectorAll('.node-joint')].map((c) => c.textContent),
        lines: document.querySelectorAll('svg.joint-lines path').length,
        director: window.__xo.director.transcript().slice(-4).map((e) => ({ role: e.role, from: e.from, text: String(e.text || '').slice(0, 120) })),
      };
    })()`);

  const started = Date.now();
  const deadline = () => Date.now() - started > TIMEOUT;
  await wait(BOOT_DELAY);

  const setup = await rpc(control.url, control.token, 'batch', {
    actions: [
      { op: 'workspace', path: workspace },
      {
        op: 'joint',
        name: 'TestTeam',
        brief: '# TestTeam\nTiny tool test. No files need to be written.',
        members: [
          {
            role: 'lead',
            lead: true,
            model: 'haiku',
            effort: 'low',
            prompt:
              'Tool test, be brief. 1) Call spawn_worker with role "echo" and prompt "Call your report tool with status done and text: echo ok. Then stop." 2) Then stop and wait. When a worker report arrives, call report with status done and text "team ok", then stop.',
          },
        ],
      },
    ],
  });
  log('SETUP', setup);

  // Wait for the worker to exist and report, and for the lead to report up.
  let snapshot = null;
  let workerChecked = false;
  while (!deadline()) {
    await wait(4000);
    snapshot = await state();
    const worker = snapshot.members.find((m) => m.rank === 'worker');
    const lead = snapshot.members.find((m) => m.rank === 'lead');
    if (worker && !workerChecked) {
      workerChecked = true;
      // Rank enforcement with the worker's own token.
      const token = control.agentToken(worker.id);
      log('WORKER_PROMPT', await rpc(control.url, token, 'team.prompt', { worker: lead ? lead.callSign : 'x', text: 'hi' }));
      log('WORKER_CANVAS', await rpc(control.url, token, 'canvas.snapshot', {}));
      log('WORKER_INFO', await rpc(control.url, token, 'team.info', {}));
      log('BAD_TOKEN', await rpc(control.url, 'nope', 'team.info', {}));
      await shot('team');
    }
    const teamReport = snapshot.director.some((e) => e.from === 'team');
    if (worker && worker.report && lead && lead.report && teamReport) break;
  }
  log('STATE', snapshot);

  // Give the Director a moment to answer the lead's report, then the views.
  await wait(8000);
  log('DIRECTOR', (await state()).director);
  await run(`window.__xo.openHierarchy(); true`);
  await wait(800);
  log(
    'HIERARCHY',
    await run(`(() => ({
      cards: document.querySelectorAll('.hv-card').length,
      teams: document.querySelectorAll('.hv-team').length,
      reports: document.querySelectorAll('.hv-report').length,
    }))()`)
  );
  await shot('hierarchy');
  await run(`(() => { document.querySelector('#overlay .sheet-close')?.click(); return true; })()`);
  await rpc(control.url, control.token, 'batch', { actions: [{ op: 'board', joint: 'TestTeam' }] });
  await wait(1200);
  log(
    'BOARD',
    await run(`(() => [...document.querySelectorAll('.board-col')].map((c) => c.querySelectorAll('.board-card').length))()`)
  );
  await shot('board');
  // The Director sees the team brief and the fleet context.
  await run(`(() => { window.__xo.store.state.sharedContext = '# Fleet context\\nFleet codename: PELICAN.'; return true; })()`);
  await run(
    `window.__xo.director.send('Without using tools: what does the TestTeam brief say, and what is the fleet codename? One sentence.'); true`
  );
  let answer = '';
  for (let i = 0; i < 15 && !answer; i++) {
    await wait(2000);
    const last = (await state()).director.slice(-1)[0];
    if (last && last.role === 'assistant' && /pelican|tool test/i.test(last.text)) answer = last.text;
  }
  log('CONTEXT_ANSWER', answer || (await state()).director.slice(-2));
  log('DONE', { seconds: Math.round((Date.now() - started) / 1000), timedOut: deadline() });
  app.quit();
}

/**
 * Agent canvas/browser tools (XODECODE_TEST_KIND=agent): a standalone Haiku
 * agent opens a local test page, reads it, types into it, screenshots it, and
 * tries to drive a browser the user opened (which must be refused).
 */
async function runAgentToolTest(mainWindow, control) {
  const outDir = process.env.XODECODE_TEAMTEST;
  fs.mkdirSync(outDir, { recursive: true });
  const run = (js) => mainWindow.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (name, value) => console.log(`TEAMTEST_${name} ${JSON.stringify(value)}`);

  // A tiny page: typing a name and pressing Enter changes the heading.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Greeter</title><h1 id="h">Hello stranger</h1>
      <form onsubmit="event.preventDefault();document.getElementById('h').textContent='Hello '+document.getElementById('n').value">
      <input id="n" placeholder="Your name"><button>Greet</button></form>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const started = Date.now();
  await wait(BOOT_DELAY);
  const setup = await rpc(control.url, control.token, 'batch', {
    actions: [
      { op: 'workspace', path: outDir },
      { op: 'browser', url: 'https://example.com' },
    ],
  });
  const userBrowser = setup.result?.[1]?.result?.callSign || 'example.com';
  log('SETUP', { userBrowser, pageUrl });
  const agent = await rpc(control.url, control.token, 'batch', {
    actions: [
      {
        op: 'agent',
        model: 'haiku',
        effort: 'low',
        prompt:
          `Test your xode tools, be brief, no file edits. 1) browser_open ${pageUrl} 2) browser_read it ` +
          `3) browser_type "pelican" into the name input with submit:true 4) browser_screenshot your browser ` +
          `5) try navigate on the window named "${userBrowser}" to https://example.org and note the error ` +
          `6) reply with the page heading you see now and the error from step 5.`,
      },
    ],
  });
  const agentId = agent.result?.[0]?.result?.id;
  log('AGENT', agent.result?.[0]?.result?.callSign || agent);

  let final = null;
  while (Date.now() - started < TIMEOUT) {
    await wait(4000);
    final = await run(`(() => {
      const s = window.__xo.store;
      const me = s.findNode(${JSON.stringify(agentId)})?.node;
      const browsers = s.allNodes().filter((n) => n.kind === 'browser');
      return {
        status: me ? me.status : 'gone',
        browsers: browsers.map((n) => ({ name: n.callSign, url: n.payload && n.payload.url, owner: n.payload && n.payload.ownerId ? 'agent' : 'user' })),
      };
    })()`);
    const own = final.browsers.find((b) => b.owner === 'agent');
    if (own && final.status === 'idle') break;
  }
  log('STATE', final);
  // What the agent's page shows now, read straight from its webview.
  log(
    'HEADING',
    await run(`(async () => {
      const s = window.__xo.store;
      const node = s.allNodes().find((n) => n.kind === 'browser' && n.payload && n.payload.ownerId);
      if (!node) return null;
      return window.__xo.canvas.views.get(node.id).exec('document.getElementById("h") && document.getElementById("h").textContent');
    })()`)
  );
  // The agent's own account: tool calls and its final reply.
  const chatId = await run(`window.__xo.store.findNode(${JSON.stringify(agentId)})?.node.chatId || null`);
  try {
    const chat = JSON.parse(fs.readFileSync(path.join(outDir, 'profile', 'chats', `${chatId}.json`), 'utf8'));
    log(
      'TOOLS',
      chat.messages.filter((m) => m.role === 'tool').map((m) => `${m.tool || m.text}${m.result && m.result.isError ? ' (error)' : ''}`)
    );
    log('REPLY', (chat.messages.filter((m) => m.role === 'assistant').pop() || {}).text || null);
  } catch (error) {
    log('CHAT', String(error.message));
  }
  const image = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'agent.png'), image.toPNG());
  server.close();
  log('DONE', { seconds: Math.round((Date.now() - started) / 1000) });
  app.quit();
}

module.exports = { runTeamTest, runAgentToolTest };
