import { store } from './store.js';
import { truncate } from './util.js';
import { openBrowser } from './browser.js';

/**
 * Canvas and browser tools for Claude agents (`tool.*` over the control
 * bridge). The caller is the agent's own window, taken from its token.
 *
 * Rules:
 * - Looking is open to everyone: `canvas`, `browser_read`, `browser_screenshot`
 *   work on any window.
 * - Driving is not: navigate, click, type, eval and close only work on windows
 *   the agent opened itself, or, for a team lead, windows its team opened.
 *   The user's and the Director's windows are never an agent's to change.
 */

const MAX_OWN_BROWSERS = 3;
const MAX_TEXT = 12000;

function findWindow(ref) {
  if (!ref) throw new Error('which window? pass its id or name from the canvas tool');
  const wanted = String(ref).toLowerCase();
  const all = store.allNodes();
  const node =
    all.find((n) => n.id === ref) ||
    all.find((n) => String(n.callSign || '').toLowerCase() === wanted) ||
    all.find((n) => String(n.title || '').toLowerCase() === wanted);
  if (!node) throw new Error(`no window "${ref}" — use the canvas tool to see what is open`);
  return node;
}

function ownerOf(node) {
  const id = node.payload && node.payload.ownerId;
  return id ? store.findNode(id)?.node || null : null;
}

function ownerLabel(node, caller) {
  const owner = ownerOf(node);
  if (!owner) return node.payload && node.payload.ownerId ? 'a closed agent' : 'the user';
  return owner.id === caller.id ? 'you' : owner.callSign;
}

function canDrive(caller, node) {
  const owner = ownerOf(node);
  if (!owner) return false;
  if (owner.id === caller.id) return true;
  return caller.rank === 'lead' && Boolean(caller.joint) && owner.joint === caller.joint;
}

function requireBrowser(node) {
  if (node.kind !== 'browser') throw new Error(`${node.callSign} is a ${node.kind}, not a browser`);
}

function requireDrivable(caller, node) {
  if (canDrive(caller, node)) return;
  const who = ownerLabel(node, caller);
  throw new Error(
    `${node.callSign} belongs to ${who}. You can only control windows you opened` +
      `${caller.rank === 'lead' ? " or your team's" : ''} — open your own with browser_open.`
  );
}

function viewOf(ctx, node) {
  const view = ctx.canvas.views.get(node.id);
  if (!view || !view.exec) throw new Error(`${node.callSign} is not ready yet`);
  return view;
}

/* --------------------------- in-page scripts --------------------------- */

const READ_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  document.querySelectorAll('[data-xode-ref]').forEach((el) => el.removeAttribute('data-xode-ref'));
  const picked = [...document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [contenteditable=true]'
  )].filter(visible).slice(0, 80);
  const label = (el) =>
    String(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || el.name || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
  return {
    url: location.href,
    title: document.title,
    text: String(document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT}),
    elements: picked.map((el, i) => {
      el.setAttribute('data-xode-ref', String(i + 1));
      const tag = el.tagName.toLowerCase();
      return { ref: i + 1, tag, type: el.type && tag === 'input' ? el.type : undefined, label: label(el) };
    }),
  };
})()`;

/** JS that finds the target element (by ref, selector or text) as `el`. */
function findScript({ ref, selector, text }) {
  return `
    let el = null;
    const ref = ${JSON.stringify(ref ?? null)};
    const selector = ${JSON.stringify(selector || null)};
    const text = ${JSON.stringify(text || null)};
    if (ref != null) el = document.querySelector('[data-xode-ref="' + ref + '"]');
    if (!el && selector) el = document.querySelector(selector);
    if (!el && text) {
      const want = text.toLowerCase();
      const all = [...document.querySelectorAll('a, button, input, textarea, select, label, [role=button], [role=link], summary')];
      el = all.find((e) => String(e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase() === want)
        || all.find((e) => String(e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(want));
    }
    if (!el) return { error: 'element not found — call browser_read for fresh refs' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const name = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).toString().trim().slice(0, 60);
  `;
}

function clickScript(target) {
  return `(() => { ${findScript(target)} el.focus?.(); el.click(); return { clicked: name }; })()`;
}

function typeScript(target, value, submit) {
  return `(() => {
    ${findScript(target)}
    el.focus();
    const value = ${JSON.stringify(String(value ?? ''))};
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      // The native setter keeps React and other frameworks in sync.
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (${submit ? 'true' : 'false'}) {
      const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', key));
      el.dispatchEvent(new KeyboardEvent('keypress', key));
      el.dispatchEvent(new KeyboardEvent('keyup', key));
      if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    }
    return { typed: name, submitted: ${submit ? 'true' : 'false'} };
  })()`;
}

function formatRead(result, node) {
  const lines = [`${node.callSign} — ${result.title || '(no title)'}`, result.url, ''];
  lines.push(result.text ? result.text.trim() : '(no visible text)');
  if (result.elements && result.elements.length) {
    lines.push('', 'Interactive elements (use ref with browser_click / browser_type):');
    for (const item of result.elements) {
      lines.push(`[${item.ref}] ${item.tag}${item.type ? `:${item.type}` : ''} ${item.label ? `"${item.label}"` : ''}`.trim());
    }
  }
  return lines.join('\n');
}

async function settle(view) {
  await new Promise((resolve) => setTimeout(resolve, 350));
  await view.waitForLoad(10000);
}

/* -------------------------------- tools -------------------------------- */

export async function agentToolHandle(ctx, method, params, callerId) {
  const caller = store.findNode(callerId)?.node;
  if (!caller) throw new Error('your window is gone');

  switch (method) {
    case 'tool.canvas': {
      const page = store.pageOfNode(caller.id) || store.page;
      return {
        page: page.name,
        you: { id: caller.id, name: caller.callSign, team: caller.jointName || null, rank: caller.rank || null },
        windows: page.nodes.map((node) => ({
          id: node.id,
          kind: node.kind === 'terminal' ? (node.cli === 'claude' ? 'agent' : 'terminal') : node.kind,
          name: node.callSign,
          title: node.title || undefined,
          url: node.payload && node.payload.url ? node.payload.url : undefined,
          status: node.kind === 'terminal' ? node.status || 'idle' : undefined,
          team: node.jointName || undefined,
          owner: node.kind === 'terminal' ? undefined : ownerLabel(node, caller),
          canControl: node.kind === 'terminal' ? false : canDrive(caller, node),
          docked: node.parked || undefined,
          isYou: node.id === caller.id || undefined,
        })),
      };
    }

    case 'tool.browser_open': {
      const url = String(params.url || '').trim();
      if (!url) throw new Error('browser_open needs a url');
      const mine = store.allNodes().filter((node) => node.kind === 'browser' && node.payload?.ownerId === caller.id);
      if (mine.length >= MAX_OWN_BROWSERS) {
        throw new Error(
          `you already have ${MAX_OWN_BROWSERS} browsers (${mine.map((n) => n.callSign).join(', ')}) — navigate or close one`
        );
      }
      const node = openBrowser(ctx.canvas, url, { ownerId: caller.id, focus: false });
      const view = ctx.canvas.views.get(node.id);
      if (view?.waitForLoad) await view.waitForLoad(15000);
      return { opened: node.id, name: node.callSign, url: node.payload.url };
    }

    case 'tool.navigate': {
      const node = findWindow(params.window);
      requireBrowser(node);
      requireDrivable(caller, node);
      const view = viewOf(ctx, node);
      const url = String(params.url || '').trim();
      if (!url) throw new Error('navigate needs a url (or back / forward / reload)');
      if (/^(back|forward|reload)$/i.test(url)) view.history(url.toLowerCase());
      else view.navigate(url);
      await settle(view);
      return { window: node.callSign, url: node.payload?.url };
    }

    case 'tool.browser_read': {
      const node = findWindow(params.window);
      requireBrowser(node);
      const view = viewOf(ctx, node);
      await view.waitForLoad(10000);
      return { text: formatRead(await view.exec(READ_SCRIPT), node) };
    }

    case 'tool.browser_screenshot': {
      const node = findWindow(params.window);
      requireBrowser(node);
      const view = viewOf(ctx, node);
      await view.waitForLoad(10000);
      const id = view.webContentsId?.();
      if (!id) throw new Error(`${node.callSign} has not loaded yet`);
      const shot = await window.api.win.captureWeb({ id });
      if (shot && !shot.error) {
        return {
          image: { data: shot.data, mime: shot.mime },
          caption: `${node.callSign} — ${node.payload?.url || ''} (${shot.width}×${shot.height})`,
        };
      }
      // Fallback: grab that area of the app window, if it is on screen.
      const frame = view.el.querySelector('.browser-host') || view.el;
      const rect = frame.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      if (node.parked || right - left < 40 || bottom - top < 40) {
        throw new Error(`screenshot failed (${shot?.error || 'no image'}) and ${node.callSign} is not on screen`);
      }
      const dataUrl = await window.api.win.capture({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        maxWidth: 1280,
      });
      if (!dataUrl) throw new Error(`screenshot failed (${shot?.error || 'no image'})`);
      return {
        image: { data: dataUrl.replace(/^data:image\/\w+;base64,/, ''), mime: 'image/jpeg' },
        caption: `${node.callSign} — ${node.payload?.url || ''} (captured from the canvas)`,
      };
    }

    case 'tool.browser_click': {
      const node = findWindow(params.window);
      requireBrowser(node);
      requireDrivable(caller, node);
      const view = viewOf(ctx, node);
      const result = await view.exec(clickScript(params));
      if (result?.error) throw new Error(result.error);
      await settle(view);
      return { ...result, url: node.payload?.url };
    }

    case 'tool.browser_type': {
      const node = findWindow(params.window);
      requireBrowser(node);
      requireDrivable(caller, node);
      const view = viewOf(ctx, node);
      const result = await view.exec(typeScript(params, params.value, Boolean(params.submit)));
      if (result?.error) throw new Error(result.error);
      if (params.submit) await settle(view);
      return { ...result, url: node.payload?.url };
    }

    case 'tool.browser_eval': {
      const node = findWindow(params.window);
      requireBrowser(node);
      requireDrivable(caller, node);
      const view = viewOf(ctx, node);
      const code = String(params.code || '').trim();
      if (!code) throw new Error('browser_eval needs code');
      let value;
      try {
        value = await view.exec(code);
      } catch (error) {
        throw new Error(`page error: ${String(error?.message || error).slice(0, 400)}`);
      }
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        json = String(value);
      }
      return { text: truncate(json === undefined ? 'undefined' : json, 8000) };
    }

    case 'tool.note': {
      const text = String(params.text || '').trim();
      if (!text) throw new Error('note needs text');
      const node = ctx.canvas.createNode(
        {
          kind: 'note',
          w: 300,
          h: 220,
          callSign: `${caller.callSign}'s note`,
          payload: { text: truncate(text, 2000), ownerId: caller.id },
        },
        { focus: false }
      );
      return { pinned: node.id };
    }

    case 'tool.close': {
      const node = findWindow(params.window);
      if (node.kind === 'terminal') throw new Error('agents cannot close sessions — ask the user or the Director');
      requireDrivable(caller, node);
      ctx.canvas.removeNode(node.id);
      return { closed: node.callSign };
    }

    default:
      throw new Error(`unknown tool "${method}"`);
  }
}
