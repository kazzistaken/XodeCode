# XodeCode

A spatial canvas for commanding AI coding agents — an Electron desktop app in the spirit of [CNVS](https://cnvs.dev). Instead of one linear chat thread, agents, terminals, notes and sketches live as windows on an infinite, multi-page canvas.

Built on **Electron + xterm.js + node-pty**. Terminals are real PTYs, and they run **Claude Code**.

## Run

```bash
npm install
npm start
```

Requires [Claude Code](https://www.anthropic.com/claude-code) on your `PATH` (`claude --version`).

### Desktop shortcut

```bash
npm run shortcut
```

Generates `assets/xodecode.ico` and places a **XodeCode** shortcut on your Desktop that launches the bundled Electron runtime against this folder — no terminal window involved. To also add it to the Start Menu:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1 -StartMenu
```

The shortcut stores an absolute path, so re-run it if you move the project folder.

---

## The Director

The prompt bubble at the bottom talks to the **Director**: a persistent, headless Claude Code
session whose job is to open, close and arrange apps, and to start or prompt Claude sessions —
single agents or jointed teams — when you ask. It never acts on its own initiative.

**Fast by design.**

- Simple commands never reach a model. *open youtube and github*, *close all browsers*,
  *put them side by side*, *clear the canvas*, *zoom to fit*, *swap Skye and Orion* … run instantly,
  including several at once.
- Everything else goes to the Director, which runs on **Sonnet 5.5 at low effort** by default
  (change it under **Settings → Director**). It is one long-lived `claude -p --input-format
  stream-json` process, so there is no start-up cost per request.
- It has a tiny custom system prompt and exactly two native tools — `canvas` (read the canvas) and
  `run` (do things) — served by `bin/xode-mcp.js`. No shell, no file tools, no plugins or hooks.
- Every prompt carries a snapshot of the canvas (pages, windows in tile order, focus, the dock), so
  the Director can act in a single turn. `run` takes a **list of actions that execute at the same
  time** and land in one smooth re-tile — "open two browsers" is one call, not two.

The panel in the bottom-right shows the conversation as a compact chat and folds away when idle.
`Ctrl` `Shift` `D` opens the full conversation, styled like Claude Desktop, with its own
composer. The transcript is saved, so it survives restarts.

### What `run` can do

| Op | Effect |
| --- | --- |
| `terminal` / `browser` / `navigate` / `music` / `board` / `note` | Open windows |
| `close` (`node`, `kind` or `all`; `forever: true` to skip the dock) | Close to the dock |
| `clear` / `restore` | Park every window in the dock / bring one (or all) back |
| `focus` | Bring a window into view |
| `arrange` (`grid` \| `columns` \| `rows` \| `focus` + `main`) | Change the tiling |
| `swap` / `order` | Reorder tiled windows |
| `move` / `resize` / `tile` | Free placement / back to auto-tiling |
| `zoom` (`in` \| `out` \| `reset` \| `fit`) | Glide the camera |
| `agent` / `send` / `model` / `effort` | Start, prompt and tune Claude sessions |
| `joint` / `joint_add` / `joint_brief` | Jointed teams |
| `page` / `workspace` / `theme` / `background` / `context` / `notify` / `undo` / `redo` | App |

The older `xode` CLI (`node bin/xode.js <command>`) still drives the same bridge and is handy for
scripting and tests.

### JointedAgents

A **joint** is a team of Claude Code agents that work as one unit. They all run in the same folder and
share **one brief** (`%APPDATA%\xodecode\joints\<id>.md`) that every member reads first and keeps
current — that is their shared context.

You prompt the **Director**, not the agents. It splits your request into independent workstreams,
writes each member's prompt, and routes by difficulty: hard, logical, architectural work goes to
**Opus at high effort**; simple, mechanical or UI work goes to **Sonnet at low/medium**. Up to **5**
members per joint. Members are outlined in the joint's colour, badged with its name, and linked by a
dashed spine on the canvas.

```bash
xode joint new --name "checkout"
xode joint context set --joint "checkout" --text "goal · the split · who owns which files"
xode joint spawn --joint "checkout" --role "api" --model claude-opus-5-5   --effort high --prompt "…"
xode joint spawn --joint "checkout" --role "ui"  --model claude-sonnet-5-5 --effort low  --prompt "…"
```

### Model policy

- **Defaults.** `claude-sonnet-5-5` for normal, mechanical or UI work; `claude-opus-5-5` for hard, logical, architectural or risky work. The Director picks per agent (and per joint member).
- **Explicit requests.** If you name a model — `haiku`, `fable`, `opus`, `sonnet`, or a full id — the Director uses exactly that (`spawn --model haiku …`, `model --agent X --model fable`). It **never** switches to a non-default model on its own.
- Effort is `low`, `medium`, `high` (plus `xhigh`/`max`), default `medium`.

Aliases resolve to `claude-haiku-5-5` and `claude-fable-5-1`; any other model id is passed through unchanged. Only empty/garbage values fall back to Sonnet 5.5.

### Shared context

Every agent starts with the same picture via a shared context file:

```
%APPDATA%\xodecode\fleet-context.md
```

Each agent is launched with an appended system prompt telling it to read that file first. The Director keeps it current (`context append …`), so decisions, file ownership and open questions are inherited instead of rediscovered. You can read and edit it under **Settings → Director**.

The Director's own instructions live at `%APPDATA%\xodecode\director.md` and are rewritten on every launch.

### Permissions

The Director needs no permission bypass: its only tools are `canvas` and `run`, which are allowed explicitly, and it has no shell or file access at all.

**Agent terminals and GUI-chat agents also run with `--permission-mode bypassPermissions` by default**, so they never stop to ask before editing files or running commands. This is controlled by **Settings → Agents → Permissions → Full permissions** (on by default). Turn it off if you want agents to prompt you instead — they will then raise "needs you" prompts on the canvas. Changing the setting only affects terminals spawned afterwards; restart an agent's terminal to apply it.

The GUI-chat mode needs this even more than terminals do: it runs `claude -p` (print mode), which has no way to answer a permission prompt, so without bypass its tools would simply be denied.

---

## Canvas

- Infinite canvas with a dot grid — drag empty canvas (or use the middle mouse button) to pan. **The scroll wheel zooms** (no modifier needed); scroll over a terminal, note or chat to scroll that instead. Dragging inside a window never pans the canvas.
- Freeform windows: drag by the title bar, resize from the bottom-right grip.
- **New terminals snap into a tidy grid** — the first free cell, origin-anchored, instead of stacking at random.
- The **×** in a window's title bar closes it and kills its PTY.
- Pages are browser-style tabs at the top: click to switch, double-click to rename, the **×** closes one, and **+** adds a new page. `Ctrl` `1`…`9` jumps straight to a page.
- **Each tab has its own workspace folder.** When you add a tab it asks you to pick a folder; every terminal and agent you open on that tab starts there, and the tab is named after the folder. Change it any time from the empty-canvas button or **Settings → Canvas**.
- A **File / Edit / View / Help** menu bar in the title bar holds the app commands: new terminals, workspace folder, new/close page, settings, map, director log, zoom and themes.
- Terminals support copy and paste: `Ctrl` `C` / `Ctrl` `Insert` copies a selection, `Ctrl` `V` / `Shift` `Insert` pastes.
- **Music player** windows (`File ▸ New music player`, or ask the Director to `music`): a **Radio** tab that searches and plays internet radio (free Radio Browser API, no key) and a **Spotify** tab that embeds the official player for any track/album/playlist link you paste.
- **In-app browser** windows render real pages on the canvas (back / forward / reload / address bar). Open one from **File ▸ New browser**, or ask the Director to `browser --url "…"`. Pages stay inside the app — never the system browser.
- The mic button at the left of the prompt dictates into it. It uses the modern Windows speech engine (the one behind Windows voice typing) for accurate, punctuated dictation — turn on **Settings → Privacy & security → Speech → Online speech recognition** in Windows for it. Without that it falls back to the offline engine, listening continuously so no words are lost between phrases. Click the mic again to stop.
- No tool rail: the canvas always grabs. Rectangle, diamond, ellipse, arrow, line, freehand draw, text and sticky note are on keyboard shortcuts (`R` `D` `O` `A` `L` `P` `T` `N`), and `V` returns to grabbing. Drop an image file anywhere to place it.
- **The dock.** Closing a window — its ×, asking the Director, or *clear the canvas* — sends it to the **dock** in the bottom-left instead of killing it; it keeps running there. Windows of the same kind **stack** into one rounded logo tile (site icons for browsers). Hover a stack and its tiles **slide out**; hover a tile to see a **preview** of the window as it was (a snapshot of its contents) and a ghost outline of where it sat. Click to bring it back; the small **×** on a tile closes it for good. Ask for "permanently" / "for good" and the Director closes outright.
- **Text follows the window.** Make a window bigger and its text grows with it; make it smaller and the text shrinks (terminals, chats, browsers, notes, boards and the music player).
- **A framed canvas.** Tiled windows keep a generous border from the screen edges instead of running edge to edge.
- **Drag to reorder.** Dragging a tiled window slides its neighbours out of the way and drops it into the slot under the pointer. Re-tiles, camera moves and window entrances all glide.
- **Auto-arranged windows**: every app window tiles itself side by side and resizes to fill the screen, reflowing whenever one opens or closes or the window resizes. Turn it off in **Settings → Canvas → Layout** to place windows freely, or run `layout` to re-tile on demand.
- **Undo / redo** (`Ctrl` `Z` / `Ctrl` `Shift` `Z`) for adds, closes, moves and resizes.
- **Multi-select**: `Shift`-click to add, `Shift`-drag on empty canvas to marquee, `Ctrl` `A` for all, drag to move the group, `Ctrl` `D` to duplicate, `Delete` to remove.
- **Task board** node (`File ▸ New task board`, or `board`): a kanban the Director keeps updated as workstreams move from *todo* to *doing* to *done*.
- **Spend tracking + budget cap**: GUI-chat runs record their cost; set a cap in **Settings → Director** and the Director checks `budget` before big spends.
- Layout, pages, notes and themes persist in local storage.
- **Claude GUI mode** (off by default): turn it on in **Settings → Canvas** and Claude agents render as Claude Desktop's chat view — transcript, composer, **model** + **effort** pickers — instead of a terminal. It talks to `claude -p --output-format stream-json` and resumes the same session for every message. **Chats are saved** (`%APPDATA%\xodecode\chats`), survive restarts, and the history button reopens any earlier one.
- Terminals render supersampled (1.5×) so text stays crisp.
- **Backgrounds**: pick **Northern lights** (an original night-sky scene), **Sunset lake** (pixel art, drawn crisp) or your own picture in **Settings → Canvas**, with a true-to-screen preview. Pictures are never stretched. The background lives on the canvas itself: it **zooms and pans with your windows**, sized to the whole canvas, and fades softly at its edges when you zoom far out.

## Attention

- When an agent you cannot see finishes or asks a question, a notification tile appears above the command bar with its own words and options; a "N agents waiting" chip folds the stack away.
- The waiting chip and notification stack sit above the command bar, so they never cover the prompt.

## Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl` `K` | Focus the Director prompt |
| `Ctrl` `Shift` `D` | Open the Director log |
| `Ctrl` `Shift` `M` | Start or stop dictation |
| `Ctrl` `N` | New Claude agent terminal |
| `Ctrl` `Shift` `N` | New plain terminal |
| `Ctrl` `1`…`9` | Jump to a page |
| `Ctrl` `Shift` `O` | Open the map |
| `Ctrl` `,` | Settings |
| `Ctrl` `0` | Reset zoom |
| `Ctrl` `+` / `-` | Zoom |
| Drag empty canvas | Pan |
| `Esc` | Back to the select tool |
| `Delete` | Remove the focused window |
| `V R D O A L P T N` | Tool shortcuts |
| `I` | Place an image |
| `F5` | Reload the app (dev) |

## Architecture

```
bin/xode-mcp.js        the Director's tools (canvas, run) over MCP
bin/xode.js            control CLI for scripting and tests
src/main/
  main.js              window, app:// protocol, PTY bridge, files, dialogs
  control.js           localhost JSON-RPC bridge → renderer
  preload.js           contextBridge API (no node access in the renderer)
  smoke.js             dev smoke test (XODECODE_SMOKE=shot.png)
src/renderer/
  index.html
  styles.css           design tokens, themes, all component styles
  js/
    app.js             bootstrap, shortcuts, window chrome
    director.js        headless Director session, transcript
    directorpanel.js   Director chat panel + full conversation sheet
    dock.js            parked-app dock (bottom-left)
    backgrounds.js     built-in canvas backgrounds
    richtext.js        safe Markdown for chat transcripts
    control.js         RPC methods → app actions, model policy
    canvas.js          viewport, grid placement, drag/resize, shapes
    terminal.js        xterm + PTY node
    shapes.js          shape / note / text / image nodes
    commandbar.js      Director prompt
    quick.js           instant fast-path for simple app commands
    browser.js         in-app browser node
    music.js           music player node
    claudechat.js      Claude GUI mode (chat)
    menubar.js         File / Edit / View / Help menus
    voice.js           mic button + dictation wiring
    notifications.js   notification tiles and waiting chip
    settings.js        settings sheet
    pages.js           top tab strip + map overlay
    store.js           persisted state + event bus
    overlay.js         modal host
    icons.js           inline SVG set
    util.js            DOM + text helpers
```

The renderer is plain ES modules served over a privileged `app://` protocol — no bundler. Node access lives entirely in the main process; the renderer talks to it through a narrow `contextBridge` API.

## Known limits

- Windows-first (the shell/PTY path is tuned for `pwsh`/`cmd`).
- "Shared context" is a shared brief file every agent reads — not one live conversation. Separate Claude processes cannot share a single session.
- Restored sessions start fresh Claude processes; saved prompts are not replayed.
- The Director needs Claude Code and a working subscription; weekly limits apply to everything it dispatches.
- Browser-window nodes and iPhone/Pocket pairing are not implemented.
