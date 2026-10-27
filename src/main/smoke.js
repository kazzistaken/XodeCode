'use strict';

/**
 * Development smoke test, enabled with XODECODE_SMOKE=<path/to/shot.png>.
 * Boots the app, exercises the Director bridge, spawns and closes agents,
 * captures screenshots and prints JSON reports.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const BOOT_DELAY = 9000;

function runCli(args, url, token) {
  return new Promise((resolve) => {
    execFile(
      'node.exe',
      [path.join(__dirname, '..', '..', 'bin', 'xode.js'), ...args],
      {
        env: { ...process.env, XODE_CONTROL_URL: url, XODE_CONTROL_TOKEN: token },
        timeout: 20000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout || '').trim().slice(0, 400),
          stderr: String(stderr || '').trim().slice(0, 200),
        });
      }
    );
  });
}

function rpc(url, token, method, params, timeout = 15000) {
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
        timeout,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`unreadable RPC response: ${data.slice(0, 160)}`));
          }
        });
      }
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('rpc timeout')));
    request.write(body);
    request.end();
  });
}

async function runSmoke(mainWindow, basePath, controlInfo = {}) {
  const run = (js) => mainWindow.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shot = async (name) => {
    const image = await mainWindow.webContents.capturePage();
    const file = basePath.replace(/\.png$/i, `-${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`SMOKE_PNG ${file}`);
  };
  const ptyCount = () => (typeof controlInfo.ptyCount === 'function' ? controlInfo.ptyCount() : -1);

  await wait(BOOT_DELAY);

  let initialIds = [];
  let initialJoints = [];
  try {
    initialIds = await run(`window.__xo.store.allNodes().map((n) => n.id)`);
    initialJoints = await run(`Object.keys(window.__xo.store.joints)`);
  } catch {
    initialIds = [];
    initialJoints = [];
  }

  // Remove any windows this run created so repeated smoke runs never leave
  // test terminals and notes behind in the user's saved canvas.
  const cleanup = async () => {
    try {
      const result = await run(`(() => {
        const app = window.__xo;
        const keep = ${JSON.stringify(initialIds)};
        const keepJoints = ${JSON.stringify(initialJoints)};
        const cleanAll = ${process.env.XODECODE_SMOKE_CLEAN ? 'true' : 'false'};
        const ids = app.store
          .allNodes()
          .map((n) => n.id)
          .filter((id) => cleanAll || !keep.includes(id));
        for (const id of ids) app.canvas.removeNode(id);
        const joints = Object.keys(app.store.joints).filter((id) => cleanAll || !keepJoints.includes(id));
        for (const id of joints) delete app.store.joints[id];
        app.store.save();
        return { removed: ids.length, left: app.store.allNodes().length, jointsRemoved: joints.length };
      })()`);
      console.log(`SMOKE_CLEANUP ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`SMOKE_CLEANUP_FAIL ${error && error.message}`);
    }
  };

  try {
    const report = await run(`(() => ({
      nodes: document.querySelectorAll('.node').length,
      pages: document.querySelectorAll('.page').length,
      tabs: document.querySelectorAll('.tab').length,
      hasToolRail: Boolean(document.querySelector('#toolbar')),
      winButtons: document.querySelectorAll('.win-btn').length,
      director: window.__xo.director.status(),
      mic: Boolean(document.querySelector('#cb-mic')),
      voiceApi: typeof window.api.voice?.start === 'function',
      directorPanel: Boolean(document.querySelector('#director-panel')),
      canvasTool: window.__xo.canvas.tool,
      errors: window.__errors || [],
      theme: document.documentElement.dataset.theme,
    }))()`);
    console.log(`SMOKE_REPORT ${JSON.stringify(report)}`);
    await shot('boot');

    /* ---- clipboard bridge (terminal copy/paste) ---- */
    const clip = await run(`(() => {
      const previous = window.api.clipboard.readText();
      window.api.clipboard.writeText('xodecode-clipboard-check');
      const value = window.api.clipboard.readText();
      window.api.clipboard.writeText(previous);
      return value;
    })()`);
    console.log(`SMOKE_CLIPBOARD ${JSON.stringify(clip)}`);

    /* ---- dictation wiring (feed text as the speech engine would) ---- */
    mainWindow.webContents.send('voice:text', 'dictated words from the mic');
    await wait(250);
    const dictated = await run(`document.querySelector('#cb-input').value`);
    console.log(`SMOKE_VOICE ${JSON.stringify(dictated)}`);
    await run(
      `(() => { const i = document.querySelector('#cb-input'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`
    );
    await wait(120);

    /* ---- spaces survive the PTY write path ---- */
    const ptySpace = await run(`(async () => {
      const created = await window.api.pty.create({ command: 'shell', cols: 90, rows: 24 });
      let out = '';
      const off = window.api.pty.onData(({ id, data }) => { if (id === created.id) out += data; });
      await new Promise((r) => setTimeout(r, 1800));
      window.api.pty.write(created.id, 'echo MARKER_A B C');
      await new Promise((r) => setTimeout(r, 250));
      window.api.pty.write(created.id, '\\r');
      await new Promise((r) => setTimeout(r, 2500));
      off();
      window.api.pty.kill(created.id);
      return {
        hasSpaces: /MARKER_A B C/.test(out),
        hasJoined: /MARKER_ABC/.test(out),
        tail: out.slice(-160).replace(/\\r?\\n/g, ' | '),
      };
    })()`);
    console.log(`SMOKE_PTY_SPACES ${JSON.stringify(ptySpace)}`);

    /* ---- instant fast-path for simple app actions ---- */
    const quick = await run(`(() => {
      const app = window.__xo;
      const before = app.store.page.nodes.length;
      const r1 = app.tryQuick('open a terminal');
      const r2 = app.tryQuick('open example.com');
      const r3 = app.tryQuick('spawn an agent to fix the failing tests');
      const r4 = app.tryQuick('tidy the canvas');
      const r5 = app.tryQuick('add a note saying hello');
      const r6 = app.tryQuick('open claude and fix the build');
      return { r1, r2, r3, r4, r5, r6, added: app.store.page.nodes.length - before };
    })()`);
    console.log(`SMOKE_QUICK ${JSON.stringify(quick)}`);
    await wait(500);

    /* ---- compound instant commands + layout modes ---- */
    const compound = await run(`(async () => {
      const app = window.__xo;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = app.store.page.nodes.filter((n) => n.kind === 'browser').length;
      const r1 = app.tryQuick('open youtube and github');
      await sleep(500);
      const opened = app.store.page.nodes.filter((n) => n.kind === 'browser').length - before;
      const r2 = app.tryQuick('put them side by side');
      await sleep(450);
      const columns = app.store.page.layout;
      const r3 = app.tryQuick('close all browsers');
      await sleep(450);
      const left = app.store.page.nodes.filter((n) => n.kind === 'browser').length;
      const r4 = app.tryQuick('open github and fix the login bug');
      app.tryQuick('tidy');
      return { r1, opened, r2, columns, r3, left, r4 };
    })()`);
    console.log(`SMOKE_COMPOUND ${JSON.stringify(compound)}`);

    /* ---- Director batch: several actions in one call, one re-tile ---- */
    const batch = await rpc(controlInfo.url, controlInfo.token, 'batch', {
      actions: [
        { op: 'browser', url: 'example.com' },
        { op: 'browser', url: 'example.org' },
        { op: 'terminal', title: 'Batch shell' },
        { op: 'nope' },
      ],
    });
    console.log(`SMOKE_BATCH ${JSON.stringify(batch)}`);
    const snapshot = await run(`window.__xo.canvasSummary()`);
    console.log(`SMOKE_SNAPSHOT ${JSON.stringify(snapshot)}`);
    await wait(500);
    await shot('batch');

    /* ---- Director panel + transcript sheet ---- */
    await run(`(() => {
      const d = window.__xo.director;
      d.noteQuick('open youtube and github', 'Opened Youtube · Opened Github');
      return true;
    })()`);
    await wait(400);
    await shot('director-panel');
    await run(`(() => { window.__xo.openDirectorLog(); return true; })()`);
    await wait(500);
    await shot('director-sheet');
    const sheetOpen = await run(`Boolean(document.querySelector('#overlay:not([hidden]) .dx-sheet'))`);
    console.log(`SMOKE_DIRECTOR_SHEET ${JSON.stringify({ open: sheetOpen })}`);
    await run(`document.querySelector('.sheet-close')?.click(); true`);
    await wait(250);

    /* ---- clear parks windows in the dock; a tile brings one back ---- */
    const dock = await run(`(async () => {
      const app = window.__xo;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const live = () => app.store.page.nodes.filter((n) => !n.parked).length;
      const before = live();
      const reply = app.tryQuick('clear the canvas');
      await sleep(600);
      const tiles = document.querySelectorAll('#dock .dock-tile').length;
      const after = live();
      return { before, reply, tiles, after };
    })()`);
    console.log(`SMOKE_DOCK ${JSON.stringify(dock)}`);
    await shot('dock');
    const restored = await run(`(async () => {
      const app = window.__xo;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#dock .dock-tile').click();
      await sleep(600);
      const tiles = document.querySelectorAll('#dock .dock-tile').length;
      const live = app.store.page.nodes.filter((n) => !n.parked).length;
      return { tiles, live };
    })()`);
    console.log(`SMOKE_DOCK_RESTORE ${JSON.stringify(restored)}`);
    await shot('dock-restored');
    const closed = await run(`(async () => {
      const reply = window.__xo.tryQuick('close everything');
      await new Promise((r) => setTimeout(r, 400));
      return { reply, tiles: document.querySelectorAll('#dock .dock-tile').length, nodes: window.__xo.store.page.nodes.length };
    })()`);
    console.log(`SMOKE_DOCK_CLOSE ${JSON.stringify(closed)}`);

    /* ---- sunset background + its settings preview ---- */
    const sunset = await run(`(async () => {
      const app = window.__xo;
      const keep = app.store.state.settings;
      window.__bgBeforeSunset = { background: keep.background || '', backgroundFit: keep.backgroundFit, backgroundPreset: keep.backgroundPreset || '', backgroundPixel: Boolean(keep.backgroundPixel) };
      const reply = app.tryQuick('set the background to sunset');
      await new Promise((r) => setTimeout(r, 300));
      const vp = document.querySelector('#viewport');
      app.settings.open('canvas');
      await new Promise((r) => setTimeout(r, 400));
      const preview = document.querySelector('.background-preview');
      const img = new Image();
      img.src = app.store.state.settings.background;
      await img.decode().catch(() => {});
      return {
        reply,
        bg: getComputedStyle(vp).backgroundSize,
        pixel: getComputedStyle(vp).imageRendering,
        loaded: img.naturalWidth,
        previewRatio: preview ? Math.round((preview.clientWidth / preview.clientHeight) * 100) / 100 : null,
        cards: document.querySelectorAll('.bg-card').length,
      };
    })()`);
    console.log(`SMOKE_SUNSET ${JSON.stringify(sunset)}`);
    await shot('sunset-settings');
    await run(`document.querySelector('.sheet-close')?.click(); true`);
    await wait(300);
    await shot('sunset');
    await run(`(() => { const s = window.__xo.store; Object.assign(s.state.settings, window.__bgBeforeSunset); s.setSetting('background', window.__bgBeforeSunset.background); return true; })()`);

    /* ---- canvas background ---- */
    // Remember the user's real background so the smoke run restores it.
    await run(`(() => {
      const s = window.__xo.store.state.settings;
      window.__bgOriginal = { background: s.background || '', backgroundFit: s.backgroundFit || 'contain' };
      return true;
    })()`);
    const bg = await run(`(() => {
      // A 1920x1080 SVG with a perfect circle: if it renders as an ellipse the
      // image was distorted; if it stays a circle the fit is correct.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">' +
        '<rect width="1920" height="1080" fill="#1b2b3a"/>' +
        '<circle cx="960" cy="540" r="420" fill="#e6a53c"/>' +
        '</svg>';
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      window.__xo.store.setSetting('background', url);
      window.__xo.store.setSetting('backgroundFit', 'contain');
      const vp = document.querySelector('#viewport');
      return {
        hasClass: vp.classList.contains('has-background'),
        fit: vp.dataset.bgFit,
        size: getComputedStyle(vp).backgroundSize,
        repeat: getComputedStyle(vp).backgroundRepeat,
      };
    })()`);
    console.log(`SMOKE_BG ${JSON.stringify(bg)}`);
    await wait(250);
    await shot('background');
    const fits = {};
    for (const fit of ['cover', 'contain', 'center', 'tile']) {
      fits[fit] = await run(`(() => {
        window.__xo.store.setSetting('backgroundFit', '${fit}');
        return getComputedStyle(document.querySelector('#viewport')).backgroundSize;
      })()`);
    }
    console.log(`SMOKE_BG_FITS ${JSON.stringify(fits)}`);
    await run(`(() => {
      const o = window.__bgOriginal || { background: '', backgroundFit: 'contain' };
      window.__xo.store.setSetting('background', o.background);
      window.__xo.store.setSetting('backgroundFit', o.backgroundFit);
      return true;
    })()`);
    await wait(150);

    /* ---- per-tab workspace drives agent cwd ---- */
    const workspace = await run(`(() => {
      const app = window.__xo;
      const page = app.store.page;
      const original = { name: page.name, workspace: page.workspace || '' };
      app.store.setPageWorkspace(page.id, 'C:\\\\Windows');
      const node = app.spawnShell();
      const result = {
        pageWorkspace: app.store.page.workspace,
        nodeCwd: node.cwd,
        pageName: app.store.page.name,
        renamed: app.store.page.name !== original.name,
      };
      app.store.setPageWorkspace(page.id, original.workspace);
      app.store.renamePage(page.id, original.name);
      return result;
    })()`);
    console.log(`SMOKE_WORKSPACE ${JSON.stringify(workspace)}`);
    await wait(300);

    /* ---- stress mode: many terminals + pan/zoom frame timing ---- */
    if (process.env.XODECODE_STRESS) {
      const count = Math.max(1, Number(process.env.XODECODE_STRESS) || 8);
      const spawnMs = await run(`(() => {
        const t0 = performance.now();
        for (let i = 0; i < ${count}; i += 1) window.__xo.spawnShell();
        return performance.now() - t0;
      })()`);
      await wait(6000);

      const measure = async (label, mutate) => {
        const result = await run(`(async () => {
          const canvas = window.__xo.canvas;
          const vp = window.__xo.store.page.viewport;
          const samples = [];
          let last = performance.now();
          for (let i = 0; i < 150; i += 1) {
            await new Promise((r) => requestAnimationFrame(r));
            ${mutate}
            const now = performance.now();
            samples.push(now - last);
            last = now;
          }
          samples.sort((a, b) => a - b);
          return {
            median: Math.round(samples[Math.floor(samples.length / 2)] * 100) / 100,
            p95: Math.round(samples[Math.floor(samples.length * 0.95)] * 100) / 100,
            max: Math.round(samples[samples.length - 1] * 100) / 100,
          };
        })()`);
        console.log(`SMOKE_STRESS_${label} ${JSON.stringify(result)}`);
      };

      await measure('PAN', 'vp.x -= 2; canvas.applyViewport();');
      await measure('ZOOM', 'canvas.zoomAt(700, 400, 1.002);');
      await measure('IDLE', '/* nothing */');
      await shot('stress');

      const final = await run(`(() => ({
        nodes: document.querySelectorAll('.node').length,
        terminals: document.querySelectorAll('.node--terminal').length,
        errors: window.__errors || [],
      }))()`);
      console.log(`SMOKE_STRESS ${JSON.stringify({ count, spawnMs: Math.round(spawnMs * 100) / 100, ...final })}`);

      await cleanup();
      await wait(600);
      app.quit();
      return;
    }

    /* ---- control bridge (what the Director's CLI uses) ---- */
    if (controlInfo.url) {
      const state = await rpc(controlInfo.url, controlInfo.token, 'app.state', {});
      console.log(`SMOKE_RPC ${JSON.stringify(state).slice(0, 400)}`);

      const policy = await run(`(() => {
        const f = window.__xo.normalizeModel;
        return {
          haiku: f('haiku'),
          fable: f('fable'),
          opus: f('opus'),
          sonnet: f('sonnet'),
          fullId: f('claude-opus-5-5'),
          passthrough: f('gpt-5'),
          missing: f(undefined),
          effortMax: window.__xo.normalizeEffort('max'),
          effortBad: window.__xo.normalizeEffort('nonsense'),
        };
      })()`);
      console.log(`SMOKE_POLICY ${JSON.stringify(policy)}`);
    }

    /* ---- permissions: agents must be launched bypassed ---- */
    {
      const build = typeof controlInfo.claudeCommand === 'function' ? controlInfo.claudeCommand : null;
      if (build) {
        const agent = build({ prompt: 'do a thing', model: 'claude-sonnet-5-5', effort: 'medium', fullPermissions: true });
        const agentOff = build({ prompt: 'do a thing', model: 'claude-sonnet-5-5', effort: 'medium', fullPermissions: false });
        const director = build({ model: 'claude-opus-5-5', effort: 'high', director: true });
        console.log(
          `SMOKE_PERMISSIONS ${JSON.stringify({
            agent: agent.includes('--permission-mode bypassPermissions') && agent.includes('--allow-dangerously-skip-permissions'),
            agentOff: !agentOff.includes('bypassPermissions'),
            director: director.includes('bypassPermissions'),
            agentCmd: agent,
            agentOffCmd: agentOff,
          })}`
        );
      } else {
        console.log('SMOKE_PERMISSIONS {"skipped":true}');
      }
    }

    /* ---- spawn an agent, then close it with the X ---- */
    console.log(`SMOKE_PTY_BEFORE ${ptyCount()}`);
    await run(`(() => { window.__xo.spawnShell(); return true; })()`);
    await wait(2600);

    if (controlInfo.url) {
      const cliList = await runCli(['list'], controlInfo.url, controlInfo.token);
      console.log(`SMOKE_CLI_LIST ${JSON.stringify(cliList).slice(0, 600)}`);
      const cliTerminal = await runCli(
        ['terminal', '--title', 'Plain shell'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_CLI_TERMINAL ${JSON.stringify(cliTerminal)}`);
      const cliNote = await runCli(
        ['note', '--text', 'Director note'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_CLI_NOTE ${JSON.stringify(cliNote)}`);
      const cliShape = await runCli(
        ['shape', '--kind', 'ellipse', '--w', '200', '--h', '120'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_CLI_SHAPE ${JSON.stringify(cliShape)}`);
      const cliNotify = await runCli(
        ['notify', '--text', 'Director bridge online'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_CLI_NOTIFY ${JSON.stringify(cliNotify)}`);
      const cliSpawn = await runCli(
        ['spawn', '--title', 'Idle agent'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_CLI_SPAWN ${JSON.stringify(cliSpawn)}`);
      const cliJointNew = await runCli(
        ['joint', 'new', '--name', 'SmokeJoint'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_JOINT_NEW ${JSON.stringify(cliJointNew)}`);
      const cliJointSpawn = await runCli(
        ['joint', 'spawn', '--joint', 'SmokeJoint', '--role', 'idle member', '--model', 'claude-opus-5-5', '--effort', 'high'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_JOINT_SPAWN ${JSON.stringify(cliJointSpawn).slice(0, 700)}`);
      const cliJointCtx = await runCli(
        ['joint', 'context', 'append', '--joint', 'SmokeJoint', '--text', 'smoke test'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_JOINT_CTX ${JSON.stringify(cliJointCtx)}`);
      await runCli(
        ['joint', 'spawn', '--joint', 'SmokeJoint', '--role', 'ui member', '--model', 'claude-sonnet-5-5', '--effort', 'low'],
        controlInfo.url,
        controlInfo.token
      );
      await wait(1200);
      await shot('joint');
      const jointNodes = await run(`(() => ({
        jointNodes: document.querySelectorAll('.node.is-joint').length,
        badges: document.querySelectorAll('.node-joint').length,
        lines: document.querySelectorAll('svg.joint-lines path').length,
      }))()`);
      console.log(`SMOKE_JOINT_VISUAL ${JSON.stringify(jointNodes)}`);

      /* ---- Claude GUI mode (chat) ---- */
      await run(`(() => { window.__xo.store.setSetting('guiTerminals', true); return true; })()`);
      const guiNode = await run(`(() => {
        const node = window.__xo.spawnClaude('');
        return { id: node.id };
      })()`);
      await wait(700);
      const gui = await run(`(() => ({
        chatBodies: document.querySelectorAll('.cx-body').length,
        pills: document.querySelectorAll('.cx-pill').length,
        greeting: Boolean(document.querySelector('.cx-hello')),
      }))()`);
      console.log(`SMOKE_GUI ${JSON.stringify(gui)}`);
      await shot('gui');

      const guiReply = await run(`(async () => {
        const node = window.__xo.store.page.nodes.find((n) => n.kind === 'terminal' && n.cli === 'claude' && n.id === ${JSON.stringify(guiNode.id)});
        // Type into the composer like the user would, then read the saved chat.
        const input = document.querySelector('[data-id="' + node.id + '"] .cx-input');
        input.value = 'reply with exactly: gui-ok';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const deadline = Date.now() + 70000;
        let saved = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 700));
          saved = await window.api.chats.load(node.chatId);
          const last = saved && saved.messages[saved.messages.length - 1];
          if (last && last.role === 'meta') break;
        }
        return {
          messages: ((saved && saved.messages) || []).map((m) => m.role + ':' + String(m.text).slice(0, 30)),
          sessionId: Boolean(saved && saved.sessionId),
          rows: document.querySelectorAll('[data-id="' + node.id + '"] .cx-row').length,
        };
      })()`);
      console.log(`SMOKE_GUI_REPLY ${JSON.stringify(guiReply)}`);
      await run(`(() => { window.__xo.store.setSetting('guiTerminals', false); return true; })()`);

      /* ---- music player ---- */
      const cliMusic = await runCli(['music'], controlInfo.url, controlInfo.token);
      console.log(`SMOKE_MUSIC ${JSON.stringify(cliMusic)}`);
      await wait(1500);
      const music = await run(`(async () => {
        const data = await window.api.radio.search({ query: 'jazz', limit: 5 });
        return {
          bodies: document.querySelectorAll('.music-body').length,
          tabs: document.querySelectorAll('.music-tab').length,
          stations: (data && data.stations ? data.stations.length : 0),
          error: data && data.error,
        };
      })()`);
      console.log(`SMOKE_MUSIC_UI ${JSON.stringify(music)}`);
      await shot('music');

      /* ---- canvas: undo/redo, select, duplicate ---- */
      const canvasOps = await run(`(() => {
        const app = window.__xo;
        const canvas = app.canvas;
        const page = app.store.page;
        const start = page.nodes.length;
        app.spawnShell();
        const added = page.nodes.length;
        canvas.undo();
        const undone = page.nodes.length;
        canvas.redo();
        const redone = page.nodes.length;
        const note = canvas.createNode({ kind: 'note', w: 200, h: 140, callSign: 'DupTest', payload: { text: '' } });
        canvas.setSelection([note.id], note.id);
        const duplicated = (canvas.duplicateSelection() || []).length;
        canvas.selectAll();
        const selected = canvas.selection.size;
        return { start, added, undone, redone, duplicated, selected };
      })()`);
      console.log(`SMOKE_CANVAS ${JSON.stringify(canvasOps)}`);

      /* ---- tiling: apps arrange side by side and fill the screen ---- */
      const placement = await run(`(() => {
        const app = window.__xo;
        const canvas = app.canvas;
        const page = app.store.page;
        for (const node of [...page.nodes]) canvas.removeNode(node.id);
        page.viewport.x = 0;
        page.viewport.y = 0;
        page.viewport.scale = 1;
        canvas.applyViewport();
        const vpBefore = { x: page.viewport.x, y: page.viewport.y };
        const view = canvas.visibleWorldRect();

        const overlaps = (a, b) =>
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        const countOverlaps = (rects) => {
          let n = 0;
          for (let i = 0; i < rects.length; i += 1) {
            for (let j = i + 1; j < rects.length; j += 1) if (overlaps(rects[i], rects[j])) n += 1;
          }
          return n;
        };
        const covers = (rects) => {
          const right = Math.max(...rects.map((r) => r.x + r.w));
          const bottom = Math.max(...rects.map((r) => r.y + r.h));
          // Tiles should span most of the usable screen (minus the top bar and
          // the command bar), not huddle in a corner.
          return right >= view.x + view.w * 0.85 && bottom >= view.y + view.h * 0.78;
        };

        const three = [app.spawnShell(), app.spawnShell(), app.spawnShell()];
        const threeRects = three.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
        const threeOverlaps = countOverlaps(threeRects);
        const threeCovers = covers(threeRects);
        // How many distinct rows the three windows occupy (2 means a 2+1 grid).
        const rows3 = new Set(threeRects.map((r) => Math.round(r.y))).size;

        // Add a fourth app (music player): it should reflow to a 2x2 grid.
        app.openMusic({ url: '' });
        const fourRects = canvas
          .tileableNodes(page)
          .map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
        const fourOverlaps = countOverlaps(fourRects);
        const fourCovers = covers(fourRects);
        const rows4 = new Set(fourRects.map((r) => Math.round(r.y))).size;
        const cols4 = new Set(fourRects.map((r) => Math.round(r.x))).size;

        const drift = { x: page.viewport.x - vpBefore.x, y: page.viewport.y - vpBefore.y };
        return {
          threeRects,
          threeOverlaps,
          threeCovers,
          rows3,
          fourOverlaps,
          fourCovers,
          rows4,
          cols4,
          drift,
        };
      })()`);
      console.log(`SMOKE_PLACEMENT ${JSON.stringify(placement)}`);
      await wait(600);
      await shot('tiling');

      /* ---- closing a window lets the rest reflow ---- */
      const reflow = await run(`(() => {
        const app = window.__xo;
        const page = app.store.page;
        const music = page.nodes.find((n) => n.kind === 'music');
        if (music) app.canvas.removeNode(music.id);
        const rects = app.canvas.tileableNodes(page).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
        const overlaps = (a, b) =>
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        let n = 0;
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) if (overlaps(rects[i], rects[j])) n += 1;
        }
        return { count: rects.length, overlaps: n };
      })()`);
      console.log(`SMOKE_REFLOW ${JSON.stringify(reflow)}`);

      /* ---- motion: entrances animate, AI moves slide, exits defer removal ---- */
      const motion = await run(`(() => {
        const app = window.__xo;
        const canvas = app.canvas;
        const page = app.store.page;
        const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
        const ours = (el) =>
          el
            .getAnimations()
            .filter(
              (a) =>
                a.effect &&
                a.effect.getTiming().easing === EASE &&
                !(typeof CSSTransition !== 'undefined' && a instanceof CSSTransition)
            ).length;
        for (const node of [...page.nodes]) canvas.removeNode(node.id);
        const node = app.spawnShell();
        const el = canvas.views.get(node.id).el;
        const entering = ours(el);
        // Re-tiling a second window resizes and slides the first, so both a
        // move animation and a size animation should be running on it.
        app.spawnShell();
        const retiling = ours(el);
        const sizes = el.getAnimations().filter((a) => {
          const frames = a.effect.getKeyframes();
          return frames.length && frames[0].width !== undefined;
        }).length;
        canvas.removeNode(node.id);
        const stillInDom = Boolean(canvas.views.get(node.id)) === false && document.querySelector('.node[data-id="' + node.id + '"]') !== null;
        app.spawnShell(); // leave a terminal for the close test below
        return { entering, retiling, sizes, exitKeepsEl: stillInDom };
      })()`);
      console.log(`SMOKE_MOTION ${JSON.stringify(motion)}`);

      /* ---- task board + budget via the CLI ---- */
      const cliBoardOpen = await runCli(['board', 'open'], controlInfo.url, controlInfo.token);
      console.log(`SMOKE_BOARD_OPEN ${JSON.stringify(cliBoardOpen).slice(0, 240)}`);
      const cliBoardAdd = await runCli(
        ['board', 'add', '--title', 'Ship the release', '--status', 'doing'],
        controlInfo.url,
        controlInfo.token
      );
      console.log(`SMOKE_BOARD_ADD ${JSON.stringify(cliBoardAdd)}`);
      const cliBoardList = await runCli(['board', 'list'], controlInfo.url, controlInfo.token);
      console.log(`SMOKE_BOARD_LIST ${JSON.stringify(cliBoardList).slice(0, 300)}`);
      const cliBudget = await runCli(['budget'], controlInfo.url, controlInfo.token);
      console.log(`SMOKE_BUDGET ${JSON.stringify(cliBudget)}`);
      await shot('board');
    }

    const closeResult = await run(`(() => {
      const app = window.__xo;
      const before = app.store.page.nodes.length;
      const node = app.store.page.nodes.find((n) => n.kind === 'terminal');
      if (!node) return { error: 'no terminal found' };
      const button = document.querySelector('.node[data-id="' + node.id + '"] .node-act.danger');
      if (!button) return { error: 'no close button' };
      button.click();
      return {
        before,
        after: app.store.page.nodes.length,
        inDom: Boolean(document.querySelector('.node[data-id="' + node.id + '"]')),
      };
    })()`);
    console.log(`SMOKE_CLOSE ${JSON.stringify(closeResult)}`);
    await wait(900);
    console.log(`SMOKE_PTY_AFTER ${ptyCount()}`);

    /* ---- spawn again for the notification + interaction tests ---- */
    await run(`(() => { window.__xo.spawnShell(); return true; })()`);
    await wait(2000);

    await run(`(() => {
      const app = window.__xo;
      const node = app.store.page.nodes.find((n) => n.kind === 'terminal');
      app.store.emit('attention', {
        id: node.id,
        kind: 'needs',
        snippet: 'Ship the 1.5.2 notes to production now, or hold for the DMG?',
        raw: 'Do you want to proceed?\\n\\u276f 1. Ship now\\n  2. Hold',
      });
      return true;
    })()`);
    await wait(500);
    await shot('tiles');

    await run(
      `(() => { const i = document.querySelector('#cb-input'); i.focus(); i.value = 'fix the failing tests'; i.dispatchEvent(new Event('input')); return true; })()`
    );
    await wait(500);
    await shot('prompt');
    await run(`(() => { document.querySelector('#cb-input').blur(); return true; })()`);
    await wait(250);

    await run(`(() => { window.__xo.store.setActivePage(1); return true; })()`);
    await wait(400);
    await shot('empty');
    await run(`(() => { window.__xo.store.setActivePage(0); return true; })()`);
    await wait(300);

    await run(`(() => {
      window.__xo.store.setSetting('background', 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"%3E%3Crect width="8" height="8" fill="%231b2b3a"/%3E%3C/svg%3E');
      window.__xo.settings.open('canvas');
      return true;
    })()`);
    await wait(600);
    await shot('settings');
    await run(`document.querySelector('.sheet-close')?.click(); true`);
    await run(`(() => {
      const o = window.__bgOriginal || { background: '', backgroundFit: 'contain' };
      window.__xo.store.setSetting('background', o.background);
      window.__xo.store.setSetting('backgroundFit', o.backgroundFit);
      return true;
    })()`);
    await wait(250);

    await run(`(() => { window.__xo.pages.openMap(); return true; })()`);
    await wait(500);
    await shot('map');
    await run(`document.querySelector('.sheet-close')?.click(); true`);
    await wait(250);

    /* ---- narrow window: check the panels do not overlap ---- */
    mainWindow.setSize(960, 680);
    await wait(700);
    await shot('narrow');
    mainWindow.setSize(1440, 900);
    await wait(500);

    /* ---- note creation + dragging ---- */
    const interaction = await run(`(() => {
      const app = window.__xo;
      const vp = document.querySelector('#viewport');
      const mk = (t, x, y, b) => new PointerEvent(t, { clientX: x, clientY: y, button: b || 0, bubbles: true, pointerId: 7 });

      window.__xo.canvas.setTool('note');
      vp.dispatchEvent(mk('pointerdown', 700, 520));
      const notes = [...document.querySelectorAll('.node--note')];
      const body = notes.length ? notes[notes.length - 1].querySelector('.node-body') : null;
      if (body) {
        body.innerText = 'Ship the DMG on Friday';
        body.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const term = document.querySelector('.node--terminal');
      const meta = app.store.page.nodes.find((n) => n.kind === 'terminal');
      const before = { x: Math.round(meta.x), y: Math.round(meta.y) };
      const viewportBefore = { x: app.store.page.viewport.x, y: app.store.page.viewport.y };
      const head = term.querySelector('.node-head');
      const r = head.getBoundingClientRect();
      head.dispatchEvent(mk('pointerdown', r.left + 40, r.top + 14));
      term.dispatchEvent(mk('pointermove', r.left + 140, r.top + 94));
      term.dispatchEvent(mk('pointerup', r.left + 140, r.top + 94));
      const after = { x: Math.round(meta.x), y: Math.round(meta.y) };

      return {
        noteCreated: notes.length,
        dragDelta: { dx: after.x - before.x, dy: after.y - before.y },
        viewportDelta: {
          dx: app.store.page.viewport.x - viewportBefore.x,
          dy: app.store.page.viewport.y - viewportBefore.y,
        },
      };
    })()`);
    console.log(`SMOKE_INTERACTION ${JSON.stringify(interaction)}`);
    await wait(400);
    await shot('note');

    /* ---- empty-canvas drag pans (grab mode always on) ---- */
    const pan = await run(`(() => {
      const app = window.__xo;
      const vp = document.querySelector('#viewport');
      const mk = (t, x, y, b) => new PointerEvent(t, { clientX: x, clientY: y, button: b || 0, bubbles: true, pointerId: 11 });
      app.canvas.setTool('select');
      const before = { x: app.store.page.viewport.x, y: app.store.page.viewport.y };
      vp.dispatchEvent(mk('pointerdown', 1200, 300));
      vp.dispatchEvent(mk('pointermove', 1240, 340));
      vp.dispatchEvent(mk('pointerup', 1240, 340));
      const after = { x: app.store.page.viewport.x, y: app.store.page.viewport.y };
      return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y) };
    })()`);
    console.log(`SMOKE_PAN ${JSON.stringify(pan)}`);

    /* ---- zoom keeps terminal bitmaps at native resolution ---- */
    await run(`(() => { window.__xo.canvas.setZoom(2); return true; })()`);
    await wait(700);
    const zoomInfo = await run(`(() => {
      const host = document.querySelector('.node--terminal .xterm-host');
      const meta = window.__xo.store.page.nodes.find((n) => n.kind === 'terminal');
      return {
        scale: window.__xo.store.page.viewport.scale,
        hostWidth: host?.style.width || null,
        hostTransform: host?.style.transform || null,
        nodeW: meta ? meta.w : null,
      };
    })()`);
    console.log(`SMOKE_ZOOM ${JSON.stringify(zoomInfo)}`);
    await shot('zoom');
    await run(`(() => { window.__xo.canvas.resetZoom(); return true; })()`);
    await wait(400);

    /* ---- page tabs: add, rename, delete ---- */
    const tabTest = await run(`(() => {
      const app = window.__xo;
      const before = app.store.pages.length;
      app.canvas.createPage();
      const afterAdd = app.store.pages.length;
      const page = app.store.page;
      app.store.renamePage(page.id, 'Renamed page');
      const renamed = app.store.page.name;
      app.canvas.deletePage(page.id);
      const afterDelete = app.store.pages.length;
      return { before, afterAdd, renamed, afterDelete };
    })()`);
    console.log(`SMOKE_TABS ${JSON.stringify(tabTest)}`);
    await wait(300);
    await shot('tabs');

    /* ---- in-app browser ---- */
    await run(`(() => { window.__xo.openBrowser('https://example.com'); return true; })()`);
    await wait(5000);
    const browserInfo = await run(`(() => {
      const wv = document.querySelector('.browser-view');
      return {
        present: Boolean(wv),
        src: wv ? wv.getAttribute('src') : null,
        url: wv && wv.getURL ? wv.getURL() : null,
        title: document.querySelector('.node--browser .node-sub')?.textContent || null,
      };
    })()`);
    console.log(`SMOKE_BROWSER ${JSON.stringify(browserInfo)}`);
    await shot('browser');
    await run(`(() => { const n = window.__xo.store.page.nodes.find((x) => x.kind === 'browser'); if (n) window.__xo.canvas.removeNode(n.id); return true; })()`);
    await wait(300);

    /* ---- menu bar dropdown ---- */
    await run(`(() => { document.querySelector('.menu-btn')?.click(); return true; })()`);
    await wait(300);
    const menu = await run(`(() => ({
      items: [...document.querySelectorAll('.menu-item')].map((b) => b.querySelector('.menu-text')?.textContent),
    }))()`);
    console.log(`SMOKE_MENU ${JSON.stringify(menu)}`);
    await shot('menu');
    await run(`(() => { document.querySelector('.menu-btn')?.click(); return true; })()`);
    await wait(200);

    const final = await run(`(() => ({
      nodes: document.querySelectorAll('.node').length,
      shapes: document.querySelectorAll('.node--shape').length,
      errors: window.__errors || [],
    }))()`);
    console.log(`SMOKE_FINAL ${JSON.stringify(final)}`);
    console.log(`SMOKE_PTY_FINAL ${ptyCount()}`);

    /* ---- optional end-to-end Director test (slow, uses tokens) ---- */
    if (process.env.XODECODE_TEST_DIRECTOR) {
      const before = await run(
        `window.__xo.store.page.nodes.filter((n) => n.kind === 'terminal').length`
      );
      await run(`(() => {
        window.__xo.director.send(
          "Start one Claude session titled Director smoke on sonnet at low effort with the prompt: Reply with exactly OK."
        );
        return true;
      })()`);

      const deadline = Date.now() + 100000;
      let spawned = null;
      while (Date.now() < deadline) {
        await wait(3000);
        const agents = await run(`window.__xo.store.page.nodes
          .filter((n) => n.kind === 'terminal')
          .map((n) => ({ callSign: n.callSign, title: n.title, model: n.model, effort: n.effort, status: n.status }))`);
        if (agents.length > before) {
          spawned = agents;
          break;
        }
      }
      console.log(`SMOKE_DIRECTOR ${JSON.stringify({ before, spawned })}`);
      await wait(4000);
      const timing = await run(`(() => {
        const t = window.__xo.director.transcript();
        const start = [...t].reverse().find((e) => e.role === 'user');
        const reply = [...t].reverse().find((e) => e.role === 'assistant');
        return { replyMs: start && reply ? reply.at - start.at : null };
      })()`);
      console.log(`SMOKE_DIRECTOR_TIMING ${JSON.stringify(timing)}`);
      const log = await run(`window.__xo.director.log().slice(-5000)`);
      console.log(`SMOKE_DIRECTOR_LOG ${JSON.stringify(log)}`);
      await shot('director');
    }

    /* ---- F5 reloads the renderer from disk ---- */
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
    await wait(2500);
    const reloaded = await run(`(() => ({
      ready: Boolean(window.__xo && window.__xo.canvas),
      tabs: document.querySelectorAll('.tab').length,
      errors: window.__errors || [],
    }))()`);
    console.log(`SMOKE_RELOAD ${JSON.stringify(reloaded)}`);
  } catch (error) {
    console.error(`SMOKE_FAIL ${error && error.message}`);
  }

  await cleanup();
  // store.save() is debounced, so give it a beat to persist before quitting.
  await wait(600);
  app.quit();
}

module.exports = { runSmoke };
