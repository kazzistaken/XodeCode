import { el } from './util.js';
import { store } from './store.js';
import { buildNodeChrome } from './node-chrome.js';
import { registerNodeType } from './canvas.js';

function buildShapeSvg(payload, width, height) {
  const stroke = payload.color || '#f2764b';
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  const style = `fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
  const parts = [];

  switch (payload.shape) {
    case 'rect':
      parts.push(
        `<rect x="1.2" y="1.2" width="${Math.max(0, W - 2.4)}" height="${Math.max(
          0,
          H - 2.4
        )}" rx="5" ${style} />`
      );
      break;
    case 'ellipse':
      parts.push(
        `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${Math.max(0, W / 2 - 1.2)}" ry="${Math.max(
          0,
          H / 2 - 1.2
        )}" ${style} />`
      );
      break;
    case 'diamond':
      parts.push(
        `<polygon points="${W / 2},1.5 ${W - 1.5},${H / 2} ${W / 2},${H - 1.5} 1.5,${
          H / 2
        }" ${style} />`
      );
      break;
    case 'line':
    case 'arrow': {
      const [ax, ay] = payload.a || [0, 0];
      const x1 = ax * W;
      const y1 = ay * H;
      const x2 = (1 - ax) * W;
      const y2 = (1 - ay) * H;
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${style} />`);
      if (payload.shape === 'arrow') {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const len = 14;
        const spread = 0.44;
        const p1 = `${x2 - len * Math.cos(angle - spread)},${y2 - len * Math.sin(angle - spread)}`;
        const p2 = `${x2 - len * Math.cos(angle + spread)},${y2 - len * Math.sin(angle + spread)}`;
        parts.push(`<polygon points="${x2},${y2} ${p1} ${p2}" fill="${stroke}" />`);
      }
      break;
    }
    case 'draw': {
      const points = (payload.points || [])
        .map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`)
        .join(' ');
      parts.push(`<polyline points="${points}" ${style} />`);
      break;
    }
    default:
      break;
  }

  parts.push(
    `<rect class="shape-outline" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" />`
  );

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">${parts.join('')}</svg>`;
}

function createShapeView(meta, canvas) {
  const chrome = buildNodeChrome(meta, {
    chrome: false,
    actions: [
      { icon: 'x', title: 'Delete shape', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.root.append(chrome.actionsEl);

  const host = el('div', { class: 'shape-host' });
  chrome.body.append(host);

  const render = () => {
    host.innerHTML = buildShapeSvg(meta.payload || {}, meta.w, meta.h);
  };
  render();

  return {
    el: chrome.root,
    redraw: render,
    resize: render,
    destroy: () => {},
  };
}

function createEditableView(meta, canvas, { brand, iconName, placeholder }) {
  const chrome = buildNodeChrome(meta, {
    brand,
    iconName,
    actions: [
      { icon: 'x', title: 'Delete', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = meta.title || '';

  const body = chrome.body;
  body.setAttribute('contenteditable', 'plaintext-only');
  body.dataset.placeholder = placeholder;
  body.textContent = meta.payload?.text || '';

  const sync = () => {
    meta.payload = meta.payload || {};
    meta.payload.text = body.innerText.replace(/\n$/, '');
    store.save();
  };
  body.addEventListener('input', sync);
  body.addEventListener('blur', sync);
  body.addEventListener('pointerdown', (event) => event.stopPropagation());

  return {
    el: chrome.root,
    focus: () => {
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    destroy: () => {},
  };
}

function createImageView(meta, canvas) {
  const chrome = buildNodeChrome(meta, {
    brand: 'image',
    iconName: 'image',
    actions: [
      { icon: 'x', title: 'Delete image', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = 'Image';
  chrome.body.append(
    el('img', { src: meta.payload?.src || '', alt: meta.callSign, draggable: 'false' })
  );

  return {
    el: chrome.root,
    destroy: () => {},
  };
}

registerNodeType('shape', createShapeView);
registerNodeType('note', (meta, canvas) =>
  createEditableView(meta, canvas, { brand: 'note', iconName: 'note', placeholder: 'Write something…' })
);
registerNodeType('text', (meta, canvas) =>
  createEditableView(meta, canvas, { brand: 'text', iconName: 'text', placeholder: 'Text' })
);
registerNodeType('image', createImageView);
