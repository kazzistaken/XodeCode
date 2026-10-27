import { store } from './store.js';
import { spawnShell, spawnClaude } from './terminal.js';
import { openBrowser, looksLikeSite, KNOWN_SITES } from './browser.js';
import { openMusic } from './music.js';
import { setBackgroundPreset } from './backgrounds.js';

/**
 * Instant path for simple canvas actions.
 *
 * "Open a terminal" should not cost a model turn, so obvious app commands are
 * executed here directly — including several at once ("open youtube and
 * github", "close all browsers, then put them side by side"). Every part of a
 * compound request must be understood before anything runs; otherwise the
 * whole message goes to the Director untouched.
 *
 * The matcher is deliberately conservative: if a message could be more than
 * trivial app actions, it returns null and goes to the Director.
 */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const COUNT = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';

const THEME_ALIASES = { graphite: 'nightglass', slate: 'cupola', ash: 'ember' };

// If any of these appear, the message is real work, not a one-liner.
const COMPLEX_HINTS = [
  /\bclaude\b/, /\bagent/, /\bfix\b/, /\bbuild\b/, /\bwrite\b/, /\bimplement\b/,
  /\brefactor\b/, /\bdebug\b/, /\bresearch\b/, /\bplan\b/, /\breview\b/, /\bwhy\b/,
  /\bhow\b/, /\bexplain\b/, /\btest/, /\bdeploy\b/, /\boptimi/, /\bshould\b/,
  /\bcan you\b/, /\bjoint/, /\bteam\b/, /\bprompt\b/, /\btell\b/, /\bask\b/, /\?/,
];

const VERB = /^(open|launch|start|new|add|close|kill|remove|show me|show|go to|visit|focus|bring up)\b/;

const KIND_WORDS = {
  browser: 'browser', browsers: 'browser', tab: 'browser', tabs: 'browser',
  terminal: 'terminal', terminals: 'terminal', shell: 'terminal', shells: 'terminal',
  agent: 'agent', agents: 'agent', claude: 'agent', claudes: 'agent', sessions: 'agent',
  note: 'note', notes: 'note', music: 'music', players: 'music', player: 'music',
};

function countOf(text) {
  const digit = String(text || '').match(/\b(\d{1,2})\b/);
  if (digit) return Math.min(12, Math.max(1, Number(digit[1])));
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return value;
  }
  return 1;
}

function kindOf(node) {
  if (node.kind === 'terminal') return node.cli === 'claude' ? 'agent' : 'terminal';
  return node.kind;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function initQuick(ctx) {
  function findNode(name) {
    const wanted = String(name || '').trim().toLowerCase().replace(/^(the|my)\s+/, '');
    if (!wanted) return null;
    const nodes = store.page.nodes.concat(store.allNodes());
    return (
      nodes.find((node) => String(node.callSign || '').toLowerCase() === wanted) ||
      nodes.find((node) => String(node.title || '').toLowerCase() === wanted) ||
      nodes.find((node) => node.kind === 'browser' && String(node.payload?.url || '').toLowerCase().includes(wanted)) ||
      null
    );
  }

  /**
   * Understand one simple command. Returns a function that performs it (and
   * returns a short reply), or null. Nothing runs until every part of the
   * message is understood.
   */
  function plan(q) {
    let match;

    // Idle Claude terminals ("open claude", "open 2 claude terminals").
    match = q.match(
      new RegExp(
        `^(?:please\\s+)?(?:open|new|add|start|give me|i need)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+)?(?:${COUNT}\\s+)?(?:new\\s+)?claude(?:\\s+code)?(?:\\s+(?:terminals?|agents?|sessions?))?$`
      )
    );
    if (match) {
      const n = countOf(match[1] || q);
      return () => {
        for (let i = 0; i < n; i += 1) spawnClaude(ctx.canvas);
        return n === 1 ? 'Opened a Claude session' : `Opened ${n} Claude sessions`;
      };
    }

    if (COMPLEX_HINTS.some((re) => re.test(q))) return null;

    // Terminals
    match = q.match(
      new RegExp(
        `^(?:please\\s+)?(?:open|new|add|start|give me|i need)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+|another\\s+)?(?:${COUNT}\\s+)?(?:new\\s+|plain\\s+|more\\s+)?(?:terminals?|shells?|consoles?)$`
      )
    );
    if (match) {
      const n = countOf(match[1] || q);
      return () => {
        for (let i = 0; i < n; i += 1) spawnShell(ctx.canvas);
        return n === 1 ? 'Opened a terminal' : `Opened ${n} terminals`;
      };
    }

    // Browsers ("open a browser", "open 2 browser tabs")
    match = q.match(
      new RegExp(
        `^(?:open|launch|show|new|add)\\s+(?:the\\s+|a\\s+|an\\s+|another\\s+)?(?:${COUNT}\\s+)?(?:new\\s+)?(?:browsers?|browser tabs?|tabs?)$`
      )
    );
    if (match) {
      const n = countOf(match[1] || q);
      return () => {
        for (let i = 0; i < n; i += 1) openBrowser(ctx.canvas);
        return n === 1 ? 'Opened a browser' : `Opened ${n} browsers`;
      };
    }

    // Music
    if (/^(?:open|play|launch|start)\s+(?:the\s+|some\s+)?(?:music|radio|music player)$/.test(q)) {
      return () => {
        openMusic(ctx.canvas, {});
        return 'Opened the music player';
      };
    }

    // A site or URL ("open youtube", "go to github.com")
    match = q.match(/^(?:open|launch|go to|visit|show me|navigate to|load|pull up)\s+(?:up\s+)?(.+)$/);
    if (match) {
      const target = match[1].trim().replace(/^(?:the\s+)?/, '');
      const site = target.replace(/\s+(?:website|site|page)$/, '');
      if (looksLikeSite(site)) {
        return () => {
          openBrowser(ctx.canvas, site);
          return `Opened ${KNOWN_SITES[site] ? site[0].toUpperCase() + site.slice(1) : site}`;
        };
      }
    }

    // Note
    match =
      q.match(
        /^(?:add|create|make|new)\s+(?:a\s+)?(?:sticky\s+)?note(?:\s+(?:saying|that says|with|reading)\s+(.+))?$/
      ) || q.match(/^note:\s*(.+)$/);
    if (match) {
      const text = (match[1] || '').trim();
      return () => {
        ctx.canvas.createNode({ kind: 'note', w: 300, h: 220, callSign: 'Note', payload: { text } });
        return 'Added a note';
      };
    }

    // Clear = park everything in the dock (bottom-left); close = gone for good.
    if (/^(?:clear|clean|empty|reset)(?:\s+(?:the\s+|my\s+)?(?:canvas|page|screen|desktop|everything|it all|workspace))?(?:\s+up)?$/.test(q)) {
      return () => {
        const { parked } = ctx.clearPage() || {};
        return parked ? `Parked ${plural(parked, 'app')} in the dock` : 'The canvas is already clear';
      };
    }
    if (/^(?:restore|bring back|unpark|reopen)\s+(?:all|everything|them|all apps|the apps)$/.test(q)) {
      return () => {
        const nodes = store.page.nodes.filter((node) => node.parked);
        nodes.forEach((node) => ctx.canvas.restoreNode(node.id));
        return nodes.length ? `Brought back ${plural(nodes.length, 'app')}` : 'The dock is empty';
      };
    }
    match = q.match(/^(?:restore|bring back|unpark|reopen)\s+(.+)$/);
    if (match) {
      const node = findNode(match[1]);
      if (node && node.parked) {
        return () => {
          ctx.canvas.restoreNode(node.id);
          return `Brought back ${node.callSign}`;
        };
      }
    }

    // Close by kind ("close all browsers", "close the terminals", "close everything")
    if (/^(?:close|kill|remove)\s+(?:all|everything|all windows|every window)(?:\s+on\s+(?:this|the)\s+page)?$/.test(q)) {
      return () => {
        const { parked } = ctx.clearPage() || {};
        return parked ? `Closed ${plural(parked, 'window')} to the dock` : 'Nothing to close';
      };
    }
    match = q.match(/^(?:close|kill|remove)\s+(all\s+(?:the\s+|my\s+)?|the\s+|every\s+|my\s+)?([a-z]+)$/);
    if (match && KIND_WORDS[match[2]]) {
      const kind = KIND_WORDS[match[2]];
      const every = /^all|^every/.test(match[1] || '') || /s$/.test(match[2]);
      const count = store.page.nodes.filter((node) => kindOf(node) === kind && !node.parked).length;
      // "close the browser" is only unambiguous when there is exactly one.
      if (!every && count !== 1) return null;
      return () => {
        const nodes = store.page.nodes.filter((node) => kindOf(node) === kind && !node.parked);
        ctx.canvas.parkNodes(nodes);
        return nodes.length ? `Closed ${plural(nodes.length, kind)} to the dock` : `No ${kind}s to close`;
      };
    }

    // Arranging
    if (/^(?:put\s+|arrange\s+|lay\s+out\s+|show\s+)?(?:them\s+|everything\s+|the\s+windows\s+|windows\s+|all\s+)?(?:side\s+by\s+side|in\s+columns|as\s+columns|columns)$/.test(q)) {
      return () => {
        ctx.canvas.setLayout('columns');
        return 'Side by side';
      };
    }
    if (/^(?:stack|stacked|rows|in\s+rows|stack\s+(?:them|everything|the\s+windows|windows))(?:\s+vertically)?$/.test(q)) {
      return () => {
        ctx.canvas.setLayout('rows');
        return 'Stacked';
      };
    }
    if (/^(?:tidy|clean up|organize|arrange|tidy up|grid|tile|re-?tile|in a grid)(?:\s+(?:the\s+)?(?:canvas|page|windows|everything|them))?$/.test(q)) {
      return () => {
        if (store.state.settings.autoLayout === false) store.setSetting('autoLayout', true);
        ctx.canvas.setLayout('grid');
        return 'Tidied into a grid';
      };
    }
    match = q.match(/^(?:make\s+(.+?)\s+(?:big|bigger|the main (?:window|one)|main)|focus mode(?:\s+on\s+(.+))?|maximi[sz]e\s+(.+))$/);
    if (match) {
      const ref = match[1] || match[2] || match[3];
      const node = ref ? findNode(ref) : store.findNode(ctx.canvas.selectedId)?.node;
      if (node) {
        return () => {
          ctx.canvas.setLayout('focus', node.id);
          return `${node.callSign} is the main window`;
        };
      }
    }
    match = q.match(/^swap\s+(.+?)\s+(?:and|with)\s+(.+)$/);
    if (match) {
      const a = findNode(match[1]);
      const b = findNode(match[2]);
      if (a && b) {
        return () => {
          ctx.canvas.swapNodes(a.id, b.id);
          return `Swapped ${a.callSign} and ${b.callSign}`;
        };
      }
    }
    if (/^(?:fit|zoom to fit|show everything|fit (?:all|everything|to screen))$/.test(q)) {
      return () => {
        ctx.canvas.fitAll();
        return 'Fitted everything on screen';
      };
    }

    // Pages
    match =
      q.match(new RegExp(`^(?:go to|switch to|open|show|jump to)\\s+page\\s+${COUNT}$`)) ||
      q.match(/^page\s+(\d{1,2})$/);
    if (match) {
      const index = countOf(match[1]);
      if (index < 1 || index > store.pages.length) return null;
      return () => {
        store.setActivePage(index - 1);
        return `On page ${index}`;
      };
    }
    if (/^(?:add|new|open|create)\s+(?:a\s+)?(?:new\s+)?page$/.test(q)) {
      return () => {
        ctx.canvas.createPage();
        return 'Added a page';
      };
    }

    // Camera
    if (/^zoom\s+in$/.test(q)) {
      return () => {
        ctx.canvas.setZoom(store.page.viewport.scale * 1.25);
        return 'Zoomed in';
      };
    }
    if (/^zoom\s+out$/.test(q)) {
      return () => {
        ctx.canvas.setZoom(store.page.viewport.scale / 1.25);
        return 'Zoomed out';
      };
    }
    if (/^(?:reset|actual)\s+zoom$/.test(q)) {
      return () => {
        ctx.canvas.resetZoom();
        return 'Zoom reset';
      };
    }

    // Background
    match = q.match(
      /^(?:set|change|switch|use|make)\s+(?:the\s+)?(?:background|wallpaper)(?:\s+(?:to|as))?\s+(?:the\s+)?(sunset|sunset lake|aurora|northern lights|night sky|dots|dot grid|none|nothing|default)$/
    );
    if (match) {
      const word = match[1];
      const id = word.startsWith('sunset') ? 'sunset' : /aurora|northern|night/.test(word) ? 'aurora' : 'none';
      return () => {
        const preset = setBackgroundPreset(id);
        return preset ? `Background: ${preset.label}` : 'Background: dot grid';
      };
    }

    // Theme
    match = q.match(/^(?:switch|set|use|change)\s+(?:the\s+)?theme\s+to\s+(graphite|slate|ash)$/);
    if (match) {
      return () => {
        store.setTheme(THEME_ALIASES[match[1]]);
        return `Theme is ${match[1]}`;
      };
    }

    // App surfaces
    match = q.match(/^open\s+(?:the\s+)?(settings|map|director log)$/);
    if (match) {
      return () => {
        if (match[1] === 'settings') ctx.openSettings();
        else if (match[1] === 'map') ctx.openMap();
        else ctx.openDirectorLog();
        return `Opened ${match[1]}`;
      };
    }

    // Focus / close an existing window by name
    match = q.match(/^(?:focus(?:\s+on)?|show|bring up|open|go to|switch to)\s+(.+)$/);
    if (match) {
      const node = findNode(match[1]);
      if (node) {
        return () => {
          ctx.canvas.focusAgent(node.id);
          return `Focused ${node.callSign}`;
        };
      }
    }
    match = q.match(/^(?:close|kill|remove)\s+(.+)$/);
    if (match) {
      const node = findNode(match[1]);
      if (node) {
        return () => {
          ctx.canvas.closeNode(node.id);
          return `Closed ${node.callSign} to the dock`;
        };
      }
    }

    return null;
  }

  /** Split "open youtube and github, then close the terminals" into parts. */
  function splitParts(q) {
    const raw = q
      .split(/\s*(?:,\s*(?:and\s+)?(?:then\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+|\s*&\s*|\s*\+\s*|;\s*)/)
      .map((part) => part.trim())
      .filter(Boolean);
    // "open youtube and github" → the second part borrows "open".
    let verb = '';
    return raw.map((part) => {
      const found = part.match(VERB);
      if (found) {
        verb = found[1];
        return part;
      }
      return verb ? `${verb} ${part}` : part;
    });
  }

  function tryHandle(raw) {
    const text = String(raw || '').trim();
    const q = text
      .toLowerCase()
      .replace(/[.!]+$/, '')
      .replace(/^(?:please|pls|hey|ok|okay)\s+/, '')
      .replace(/\s+(?:please|pls|for me)$/, '')
      .trim();
    if (!q || q.length > 160) return null;

    const single = plan(q);
    if (single) return single();

    const parts = splitParts(q);
    if (parts.length < 2) return null;
    const steps = parts.map(plan);
    if (steps.some((step) => !step)) return null;

    // Run every part together: one re-tile, windows fan in at once.
    let replies = [];
    ctx.canvas.batch(() => {
      replies = steps.map((step) => step());
    });
    return replies.join(' · ');
  }

  return { tryHandle };
}
