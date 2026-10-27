'use strict';

/**
 * Session isolation test: every Claude chat window must show only its own
 * conversation — with several open at once, for a brand-new window, and
 * after the app restarts.
 *
 * Runs the real app against a throwaway user-data folder with a fake
 * `claude` on PATH (echoes each message, keeps one session id per
 * conversation, logs every call), and drives it over the DevTools protocol.
 *
 *   node scripts/test-sessions.js [--keep]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require('electron');
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xodecode-sessions-'));
const userData = path.join(tmp, 'user-data');
const binDir = path.join(tmp, 'bin');
const callLog = path.join(tmp, 'claude-calls.jsonl');

/* ----------------------------- fake claude ----------------------------- */

fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(
  path.join(binDir, 'fake-claude.js'),
  `const fs = require('fs');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const resume = at >= 0 ? args[at + 1] : '';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const message = input.trim();
  const session = resume || require('crypto').randomUUID();
  fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ resume, session, message }) + '\\n');
  const out = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo ' + message }] } });
  out({ type: 'result', is_error: false, result: 'ok', total_cost_usd: 0, duration_ms: 1 });
});
`
);
fs.writeFileSync(
  path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
  process.platform === 'win32'
    ? `@"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.js" "$@"\n`,
  { mode: 0o755 }
);

// A file shared by several chats under the old naming, which must stay hidden.
fs.mkdirSync(path.join(userData, 'chats'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'chats', '.json'),
  JSON.stringify({ id: 'chat_legacy', title: 'Director', messages: [{ role: 'user', text: 'LEGACY-SHARED', at: 1 }] })
);

/* ------------------------------- the app ------------------------------- */

let app = null;

async function launch() {
  const port = 9300 + Math.floor(Math.random() * 600);
  const out = fs.openSync(path.join(tmp, 'app.log'), 'a');
  app = spawn(ELECTRON, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    stdio: ['ignore', out, out],
  });
  const exited = new Promise((resolve) => app.once('exit', resolve));

  const deadline = Date.now() + 40000;
  let target = null;
  while (!target) {
    if (Date.now() > deadline) throw new Error('app did not open a page');
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(300);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (message) => {
        const details = message.result?.exceptionDetails;
        if (message.error || details) reject(new Error(JSON.stringify(message.error || details).slice(0, 400)));
        else resolve(message.result.result.value);
      });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });

  while (!(await evaluate('Boolean(window.__xo && window.__xo.store)').catch(() => false))) await sleep(200);

  return {
    evaluate,
    /** Close the window the normal way so state is flushed to disk. */
    async quit() {
      await sleep(1200);
      evaluate('window.close()').catch(() => {});
      const timer = setTimeout(() => app.kill(), 15000);
      await exited;
      clearTimeout(timer);
      ws.close();
    },
  };
}

/* ------------------------------- helpers ------------------------------- */

const failures = [];
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

function send(ev, nodeId, text) {
  return ev(`(() => {
    const input = document.querySelector('[data-id=${JSON.stringify(nodeId)}] .cx-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
}

async function waitForReply(ev, nodeId, text) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const log = await ev(`document.querySelector('[data-id=${JSON.stringify(nodeId)}] .cx-log')?.innerText || ''`);
    if (log.includes(`echo ${text}`)) return true;
    await sleep(250);
  }
  throw new Error(`no reply to "${text}" in ${nodeId}`);
}

/** What each window shows, and what is saved for it. */
function snapshot(ev, ids) {
  return ev(`Promise.all(${JSON.stringify(ids)}.map(async (id) => {
    const node = window.__xo.store.findNode(id).node;
    const saved = await window.api.chats.load(node.chatId);
    return {
      id,
      chatId: node.chatId,
      sessionId: node.chatSessionId,
      shown: document.querySelector('[data-id="' + id + '"] .cx-log').innerText,
      empty: Boolean(document.querySelector('[data-id="' + id + '"] .cx-hello')),
      saved: saved ? saved.messages.map((m) => m.text).join('\\n') : '',
      savedSession: saved ? saved.sessionId : '',
    };
  }))`);
}

const FOREIGN = ['DIRECTOR-ONLY', 'LEGACY-SHARED'];

/** Each window holds exactly its own tokens — none of anyone else's. */
function checkIsolation(label, views, tokens) {
  for (const view of views) {
    const own = tokens[view.id] || [];
    const others = [
      ...FOREIGN,
      ...Object.entries(tokens)
        .filter(([id]) => id !== view.id)
        .flatMap(([, list]) => list),
    ];
    for (const where of ['shown', 'saved']) {
      const text = view[where];
      const missing = own.filter((token) => !text.includes(token));
      const leaked = others.filter((token) => text.includes(token));
      check(
        !missing.length && !leaked.length,
        `${label}: ${view.name} ${where} only its own messages` +
          (missing.length ? ` (missing ${missing})` : '') +
          (leaked.length ? ` (LEAKED ${leaked})` : '')
      );
    }
  }
}

/* --------------------------------- run --------------------------------- */

async function main() {
  const names = ['A', 'B', 'C'];
  const tokens = {};

  /* -------- first launch: three sessions at once, then a new one -------- */
  let session = await launch();
  let ev = session.evaluate;
  await ev(`window.__xo.store.setSetting('guiTerminals', true)`);
  // The Director keeps its own transcript; it must never appear in a session.
  await ev(`window.api.chats.save({ id: 'director', title: 'Director', messages: [{ role: 'user', text: 'DIRECTOR-ONLY', at: Date.now() }] })`);

  const ids = [];
  for (let i = 0; i < names.length; i += 1) ids.push(await ev(`window.__xo.spawnClaude('').id`));
  await sleep(800);
  const nameOf = (id) => names[ids.indexOf(id)] || 'D';
  for (const id of ids) tokens[id] = [];

  for (const round of ['one', 'two']) {
    // Send in every window at once so the sessions run concurrently.
    for (const id of ids) {
      const text = `msg-${nameOf(id)}-${round}`;
      tokens[id].push(text);
      await send(ev, id, text);
    }
    for (const id of ids) await waitForReply(ev, id, `msg-${nameOf(id)}-${round}`);
  }

  const fresh = await ev(`window.__xo.spawnClaude('').id`);
  await sleep(1200);
  const all = [...ids, fresh];
  tokens[fresh] = [];

  let views = (await snapshot(ev, all)).map((view) => ({ ...view, name: nameOf(view.id) }));
  checkIsolation('open together', views, tokens);
  const fresh1 = views.find((view) => view.id === fresh);
  check(fresh1.empty && !fresh1.saved, 'open together: new session D starts empty');

  const sessions = views.filter((view) => view.id !== fresh).map((view) => view.sessionId);
  check(sessions.every(Boolean) && new Set(sessions).size === sessions.length, 'each session has its own Claude session id');
  const chatIds = views.map((view) => view.chatId);
  check(new Set(chatIds).size === chatIds.length, 'each window has its own chat id');

  const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (const view of views.filter((v) => v.id !== fresh)) {
    const first = calls.find((call) => call.message === `msg-${view.name}-one`);
    const second = calls.find((call) => call.message === `msg-${view.name}-two`);
    check(
      first && !first.resume && second && second.resume === first.session && view.sessionId === first.session,
      `${view.name}: follow-up resumed its own Claude session`
    );
  }

  const listed = await ev(`window.api.chats.list()`);
  check(
    listed.length === ids.length && listed.every((item) => chatIds.includes(item.id)),
    `history lists only the ${ids.length} real chats (got ${listed.map((item) => item.title)})`
  );

  await session.quit();

  /* ------------------- second launch: after a restart ------------------- */
  session = await launch();
  ev = session.evaluate;
  await sleep(1500);
  views = (await snapshot(ev, all)).map((view) => ({ ...view, name: nameOf(view.id) }));
  checkIsolation('after restart', views, tokens);
  const fresh2 = views.find((view) => view.id === fresh);
  check(fresh2.empty && !fresh2.saved, 'after restart: session D still empty');

  const [a] = ids;
  tokens[a].push('msg-A-three');
  await send(ev, a, 'msg-A-three');
  await waitForReply(ev, a, 'msg-A-three');
  const third = fs
    .readFileSync(callLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((call) => call.message === 'msg-A-three');
  check(third && third.resume === views[0].sessionId, 'after restart: A resumed its own Claude session');
  await sleep(500);
  views = (await snapshot(ev, all)).map((view) => ({ ...view, name: nameOf(view.id) }));
  checkIsolation('after restart + new message', views, tokens);

  await session.quit();
}

main()
  .catch((error) => {
    failures.push(error.message);
    console.error(`ERROR ${error.stack || error.message}`);
    app?.kill();
  })
  .finally(() => {
    console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll session isolation checks passed.');
    if (KEEP || failures.length) console.log(`Test files kept in ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = failures.length ? 1 : 0;
  });
