'use strict';

/**
 * Stress test: lots of windows at once, measured. Enabled with
 * XODECODE_TEST_KIND=stress and XODECODE_TEAMTEST=<output dir>; always run it
 * with XODECODE_USERDATA pointing at a throwaway profile.
 *
 * Opens many browsers (local pages, a third of them animated), shell
 * terminals and notes, then measures:
 *   - spawn time and a full re-tile
 *   - frame times while panning and while zooming
 *   - frame times while every terminal prints output
 *   - memory per process type and CPU while idle
 *
 * It never opens a Claude session: main.js blocks the Director, chats and
 * `claude` in terminals for the whole run (NO_CLAUDE).
 * Prints one STRESS_<name> JSON line per measurement.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');

function counts() {
  const spec = Object.fromEntries(
    String(process.env.XODECODE_STRESS || '')
      .split(',')
      .map((part) => part.split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key.trim(), Number(value)])
  );
  return { browsers: 24, terms: 8, notes: 6, ...spec };
}

const PAGE = (index, animated) => `<!doctype html><title>Page ${index}</title>
<style>body{font:15px system-ui;margin:24px;background:#fafafa}
.box{width:120px;height:120px;background:linear-gradient(45deg,#f2764b,#6ea8f7);border-radius:16px;
animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
<h1>Stress page ${index}</h1>${animated ? '<div class="box"></div>' : ''}
${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.</p>'.repeat(30)}`;

/** In-page measuring helpers, installed once. */
const HELPERS = `(() => {
  window.__stress = {
    longTasks: 0,
    longTaskMs: 0,
    run(ms, step) {
      return new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const start = last;
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (step) step((now - start) / ms);
          if (now - start < ms) requestAnimationFrame(tick);
          else {
            deltas.shift();
            const sorted = [...deltas].sort((a, b) => a - b);
            const avg = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
            resolve({
              frames: deltas.length,
              fps: Math.round(1000 / avg),
              avgMs: Math.round(avg * 10) / 10,
              p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
              maxMs: Math.round(sorted[sorted.length - 1]),
              janky: deltas.filter((d) => d > 50).length,
            });
          }
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve({ stalled: true, frames: deltas.length }), ms + 5000);
      });
    },
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__stress.longTasks += 1;
        window.__stress.longTaskMs += entry.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  return true;
})()`;

async function runStressTest(mainWindow) {
  const outDir = process.env.XODECODE_TEAMTEST;
  fs.mkdirSync(outDir, { recursive: true });
  // Page errors come back as { __error } instead of an opaque failure.
  const run = async (js) => {
    const result = await mainWindow.webContents.executeJavaScript(
      `(async () => { try { return await (${js}); } catch (e) { return { __error: String((e && e.stack) || e) }; } })()`
    );
    if (result && result.__error) throw new Error(result.__error.slice(0, 600));
    return result;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (name, value) => console.log(`STRESS_${name} ${JSON.stringify(value)}`);
  const n = counts();
  log('COUNTS', n);

  const server = http.createServer((req, res) => {
    const index = Number((req.url.match(/\d+/) || ['0'])[0]);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(index, index % 3 === 0));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`STRESS_CONSOLE ${String(message).slice(0, 300)}`);
  });
  // Keep the window visible and in front so frames are not throttled; any
  // measurement taken while it is minimized or hidden would be meaningless.
  // Shown without taking focus or staying on top, so it never gets in the
  // user's way; occlusion throttling is off for stress runs, so frames keep
  // coming even while other windows cover it. Only minimizing stops them.
  const front = async () => {
    if (!mainWindow.isMinimized() && mainWindow.isVisible()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.showInactive();
    await wait(400);
  };
  await front();
  await wait(6000);
  await run(HELPERS);
  log('GPU', app.getGPUFeatureStatus());
  log('VISIBILITY', await run('({ state: document.visibilityState, focused: document.hasFocus(), shown: true })'));
  log('WINDOW', { visible: mainWindow.isVisible(), minimized: mainWindow.isMinimized(), focused: mainWindow.isFocused(), bounds: mainWindow.getBounds() });
  // An empty canvas first: the floor every other number sits on.
  await front();
  log(
    'EMPTY_PAN',
    await run(`(async () => {
      const c = window.__xo.canvas;
      const vp = window.__xo.store.page.viewport;
      const x0 = vp.x;
      return window.__stress.run(2000, (t) => { vp.x = x0 + Math.sin(t * Math.PI * 2) * 400; c.applyViewport(); });
    })()`)
  );
  await front();
  log(
    'EMPTY_IDLE_RAF',
    await run(`window.__stress.run(1500)`)
  );
  await run(`(() => {
    const s = window.__xo.store;
    s.setWorkspace(${JSON.stringify(outDir)});
    s.setSetting('onboarded', true); // skip the first-run setup in test profiles
    if (${JSON.stringify(Boolean(process.env.XODECODE_STRESS_FLAT))}) s.setSetting('flatUi', true);
    // XODECODE_STRESS_BG: "none" (dot grid) or "still" (scene, not animated).
    const bg = ${JSON.stringify(process.env.XODECODE_STRESS_BG || '')};
    if (bg === 'none') window.__xo.tryQuick('set background to dots');
    if (bg === 'still') s.setSetting('animateScene', false);
    document.querySelector('.onboard')?.remove();
    return true;
  })()`);

  /* ---- spawn ---- */
  const spawnMs = await run(`(async () => {
    const xo = window.__xo;
    const t0 = performance.now();
    xo.canvas.batch(() => {
      for (let i = 0; i < ${n.browsers}; i++) xo.openBrowser(${JSON.stringify(base)} + '/p' + i);
      for (let i = 0; i < ${n.terms}; i++) xo.spawnShell();
      for (let i = 0; i < ${n.notes}; i++) xo.canvas.createNode({ kind: 'note', w: 300, h: 220, callSign: 'Note', payload: { text: 'note ' + i } }, { focus: false });
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t0);
  })()`);
  log('SPAWN', { ms: spawnMs, windows: n.browsers + n.terms + n.notes });
  await wait(8000); // let pages and shells finish loading

  log(
    'RELAYOUT',
    await run(`(() => {
      const t0 = performance.now();
      window.__xo.canvas.relayout({ animate: false, force: true });
      return { ms: Math.round((performance.now() - t0) * 10) / 10 };
    })()`)
  );

  // Zoomed out so most windows are on screen while we measure.
  await run(`(() => { window.__xo.canvas.fitAll(); return true; })()`);
  await wait(1500);

  /* ---- pan ---- */
  await front();
  log(
    'PAN',
    await run(`(async () => {
      const c = window.__xo.canvas;
      const vp = window.__xo.store.page.viewport;
      const x0 = vp.x;
      return window.__stress.run(3000, (t) => { vp.x = x0 + Math.sin(t * Math.PI * 2) * 400; c.applyViewport(); });
    })()`)
  );
  await wait(800);

  /* ---- zoom ---- */
  await wait(1500);
  await front();
  log(
    'ZOOM',
    await run(`(async () => {
      const c = window.__xo.canvas;
      const vp = window.__xo.store.page.viewport;
      const s0 = vp.scale;
      const r = await window.__stress.run(3000, (t) => {
        vp.scale = s0 * (1 + 0.6 * Math.sin(t * Math.PI * 2));
        c.applyViewport();
      });
      vp.scale = s0; c.applyViewport();
      return r;
    })()`)
  );
  await wait(1500);

  /* ---- zoomed in on one window, like normal use ---- */
  const cpuOver = async (ms) => {
    app.getAppMetrics();
    await wait(ms);
    const metrics = app.getAppMetrics();
    const sum = (type) =>
      Math.round(metrics.filter((m) => !type || m.type === type).reduce((a, m) => a + m.cpu.percentCPUUsage, 0) * 10) / 10;
    return { totalCpu: sum(), gpuCpu: sum('GPU'), pagesCpu: sum('Tab') };
  };
  const zoomedPan = (label) =>
    run(`(async () => {
      const xo = window.__xo;
      const vp = xo.store.page.viewport;
      const first = xo.canvas.tileableNodes()[0];
      const w = xo.canvas.viewportEl.clientWidth;
      const h = xo.canvas.viewportEl.clientHeight;
      vp.scale = 1;
      vp.x = w / 2 - (first.x + first.w / 2);
      vp.y = h / 2 - (first.y + first.h / 2);
      xo.canvas.applyViewport();
      await new Promise((r) => setTimeout(r, 600));
      const x0 = vp.x;
      const r = await window.__stress.run(3000, (t) => { vp.x = x0 - Math.abs(Math.sin(t * Math.PI)) * 1400; xo.canvas.applyViewport(); });
      vp.x = x0; xo.canvas.applyViewport();
      return { label: ${JSON.stringify(label)}, fps: r.fps, p95Ms: r.p95Ms, janky: r.janky, culled: document.querySelectorAll('.node.is-culled').length };
    })()`);
  const noCull = `(() => { const s = document.createElement('style'); s.id = 'nocull'; s.textContent = '.node.is-culled { visibility: visible !important; }'; document.head.append(s); return true; })()`;
  await front();
  log('ZOOMED_IN_PAN', await zoomedPan('culling on'));
  await wait(1000);
  log('ZOOMED_IN_IDLE', { culling: 'on', ...(await cpuOver(5000)) });
  await run(noCull);
  await front();
  log('ZOOMED_IN_PAN', await zoomedPan('culling off'));
  await wait(1000);
  log('ZOOMED_IN_IDLE', { culling: 'off', ...(await cpuOver(5000)) });
  await run(`document.getElementById('nocull')?.remove()`);
  await run(`(() => { window.__xo.canvas.fitAll(); return true; })()`);
  await wait(1500);

  /* ---- diagnosis: what makes panning slow ---- */
  if (process.env.XODECODE_STRESS_DIAG) {
    const pan = (label, setup, undo) =>
      run(`(async () => {
        ${setup}
        await new Promise((r) => setTimeout(r, 400));
        const c = window.__xo.canvas;
        const vp = window.__xo.store.page.viewport;
        const x0 = vp.x;
        let js = 0;
        const r = await window.__stress.run(2000, (t) => {
          const a = performance.now();
          vp.x = x0 + Math.sin(t * Math.PI * 2) * 400;
          c.applyViewport();
          js += performance.now() - a;
        });
        ${undo}
        return { label: ${JSON.stringify(label)}, fps: r.fps, p95Ms: r.p95Ms, jsMsPerFrame: Math.round((js / r.frames) * 100) / 100 };
      })()`);
    const hide = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).forEach((e) => (e.style.visibility = 'hidden'));`;
    const show = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).forEach((e) => (e.style.visibility = ''));`;
    const css = (rules) =>
      `{ const s = document.createElement('style'); s.id = 'diag'; s.textContent = ${JSON.stringify(rules)}; document.head.append(s); }`;
    const uncss = `document.getElementById('diag')?.remove();`;
    const zoom = (label, setup, undo) =>
      run(`(async () => {
        ${setup}
        await new Promise((r) => setTimeout(r, 400));
        const c = window.__xo.canvas;
        const vp = window.__xo.store.page.viewport;
        const s0 = vp.scale;
        const r = await window.__stress.run(2000, (t) => { vp.scale = s0 * (1 + 0.6 * Math.sin(t * Math.PI * 2)); c.applyViewport(); });
        vp.scale = s0; c.applyViewport();
        ${undo}
        return { label: ${JSON.stringify(label)}, fps: r.fps, p95Ms: r.p95Ms };
      })()`);
    await front();
    log('ZDIAG', await zoom('zoom wc host', css('.browser-host { will-change: transform; }'), uncss));
    await front();
    log('ZDIAG', await zoom('zoom wc webview', css('.browser-view { will-change: transform; }'), uncss));
    await front();
    log('ZDIAG', await zoom('zoom wc node', css('.node--browser { will-change: transform; }'), uncss));
    await front();
    log('ZDIAG', await zoom('zoom all', '', ''));
    await front();
    log('ZDIAG', await zoom('zoom no browsers', hide('.node--browser'), show('.node--browser')));
    await front();
    log('ZDIAG', await zoom('zoom no terminals', hide('.node--terminal'), show('.node--terminal')));
    await front();
    log('ZDIAG', await zoom('zoom no blur', css('.node { backdrop-filter: none !important; }'), uncss));
    await front();
    log('ZDIAG', await zoom('zoom no grid', css('.grid-layer { display: none !important; }'), uncss));
    await front();
    log('ZDIAG', await zoom('zoom nothing', hide('.node'), show('.node')));
    // Isolate the two halves of applyViewport: the world transform and the
    // dot-grid CSS variables.
    const raw = (label, body) =>
      run(`(async () => {
        const vpEl = document.getElementById('viewport');
        const world = document.getElementById('world');
        const vp = window.__xo.store.page.viewport;
        const x0 = vp.x;
        const r = await window.__stress.run(2000, (t) => { const x = x0 + Math.sin(t * Math.PI * 2) * 400; ${body} });
        return { label: ${JSON.stringify(label)}, fps: r.fps, p95Ms: r.p95Ms };
      })()`);
    await front();
    log('DIAG', await raw('transform only', `world.style.transform = 'translate(' + x + 'px,' + vp.y + 'px) scale(' + vp.scale + ')';`));
    await front();
    log('DIAG', await raw('grid vars only', `vpEl.style.setProperty('--grid-x', x + 'px');`));
    await front();
    log('DIAG', await pan('all', '', ''));
    await front();
    log('DIAG', await pan('no browsers', hide('.node--browser'), show('.node--browser')));
    await front();
    log('DIAG', await pan('no terminals', hide('.node--terminal'), show('.node--terminal')));
    await front();
    log('DIAG', await pan('no notes', hide('.node--note'), show('.node--note')));
    await front();
    log('DIAG', await pan('nothing', hide('.node'), show('.node')));
    await front();
    log('DIAG', await pan('no blur', css('.node { backdrop-filter: none !important; }'), uncss));
    await front();
    log('DIAG', await pan('no shadow', css('.node { box-shadow: none !important; }'), uncss));
    await front();
    log(
      'DIAG',
      await pan('no blur + no shadow', css('.node { backdrop-filter: none !important; box-shadow: none !important; }'), uncss)
    );
    await front();
    log('DIAG', await pan('no will-change', css('#viewport.is-moving #world { will-change: auto !important; }'), uncss));
  }

  /* ---- busy terminals ---- */
  // Every shell prints a steady stream of lines, like agents building.
  await run(`(() => {
    const ids = window.__xo.store.allNodes().filter((n) => n.kind === 'terminal' && n.cli !== 'claude').map((n) => n.id);
    for (const id of ids) window.__xo.writeTerminal?.(id, 'for ($i=0; $i -lt 400; $i++) { "line $i of busy output from a stress test"; Start-Sleep -Milliseconds 15 }');
    window.__stress.longTasks = 0; window.__stress.longTaskMs = 0;
    return ids.length;
  })()`);
  await wait(500);
  await front();
  const busy = await run(`window.__stress.run(4000)`);
  const longTasks = await run(`({ count: window.__stress.longTasks, ms: Math.round(window.__stress.longTaskMs) })`);
  log('BUSY_TERMINALS', { ...busy, longTasks });
  await wait(10000); // let the shells finish printing before measuring idle

  /* ---- memory & idle CPU ---- */
  app.getAppMetrics(); // prime CPU counters
  await wait(5000);
  const metrics = app.getAppMetrics();
  const byType = {};
  let cpu = 0;
  let mem = 0;
  for (const metric of metrics) {
    const key = metric.type === 'Tab' ? (metric.serviceName || 'Tab') : metric.type;
    const entry = (byType[key] = byType[key] || { count: 0, mb: 0, cpu: 0 });
    entry.count += 1;
    entry.mb += metric.memory.workingSetSize / 1024;
    entry.cpu += metric.cpu.percentCPUUsage;
    mem += metric.memory.workingSetSize / 1024;
    cpu += metric.cpu.percentCPUUsage;
  }
  for (const entry of Object.values(byType)) {
    entry.mb = Math.round(entry.mb);
    entry.cpu = Math.round(entry.cpu * 10) / 10;
  }
  log('IDLE', { totalMb: Math.round(mem), cpuPercent: Math.round(cpu * 10) / 10, processes: metrics.length, byType });
  log('HEAP', await run(`(() => ({ usedMb: Math.round(performance.memory.usedJSHeapSize / 1048576), domNodes: document.getElementsByTagName('*').length }))()`));

  const image = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'stress.png'), image.toPNG());
  server.close();
  log('DONE', {});
  app.quit();
}

module.exports = { runStressTest };
