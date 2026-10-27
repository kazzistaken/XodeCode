import { escapeHtml } from './util.js';

/**
 * A small, safe Markdown subset for chat transcripts: fenced code, inline
 * code, bold, italics, headings, bullet/numbered lists and paragraphs.
 * Everything is escaped first, so model output can never inject markup.
 */
export function renderRich(text) {
  const blocks = [];
  let src = escapeHtml(String(text || '')).replace(/\r\n/g, '\n');

  // Pull fenced code out first so nothing inside it is touched.
  src = src.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const label = lang ? `<span class="rt-lang">${lang}</span>` : '';
    blocks.push(`<pre class="rt-code">${label}<code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = (line) =>
    line
      .replace(/`([^`\n]+)`/g, '<code class="rt-inline">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const code = line.match(/^\u0000(\d+)\u0000$/);
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (code) {
      flushPara();
      flushList();
      out.push(blocks[Number(code[1])]);
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h${Math.min(4, heading[1].length + 2)} class="rt-h">${inline(heading[2])}</h${Math.min(4, heading[1].length + 2)}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  // Inline code fences that sat mid-paragraph.
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_match, index) => blocks[Number(index)]);
}
