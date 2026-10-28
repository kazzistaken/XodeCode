# XodeCode

A spatial canvas for commanding AI coding agents — an Electron desktop app in the spirit of [CNVS](https://cnvs.dev). Instead of one linear chat thread, agents, terminals, notes and sketches live as windows on an infinite, multi-page canvas.

Built on **Electron + xterm.js + node-pty**. Terminals are real PTYs, and they run **Claude Code**.

## Install

XodeCode runs on **Windows** (dictation and the desktop shortcut are Windows-only; the rest is plain Electron). You need:

- [Node.js](https://nodejs.org) 20 or newer, and [Git](https://git-scm.com)
- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) and a Claude account — agents run on your own plan

```bash
git clone https://github.com/kazzistaken/XodeCode.git
cd XodeCode
npm install
npm start
```

The first time it opens, a short setup lets you pick a background and checks that Claude Code is installed and signed in (it can install it or open the sign-in for you). A guided tour then walks through the interface; replay either one from **Help**.

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
members per joint.

### Agent canvas & browser tools

Every Claude agent (standalone or in a team) gets its own `xode` MCP server with a token that
identifies its window:

| Tool | What it does | Who it works on |
|---|---|---|
| `canvas` | List the windows on the agent's page, who owns each, which it can control | everything |
| `browser_read` | Page url, title, visible text and numbered links/buttons/inputs | any browser |
| `browser_screenshot` | The page as an image the model can see | any browser |
| `browser_open` | Open a browser on the canvas (max 3 per agent), without stealing focus | — |
| `navigate` | Go to a URL, or back / forward / reload | own windows |
| `browser_click` / `browser_type` | Click or fill an element (by ref, CSS selector or text) | own windows |
| `browser_eval` | Run JavaScript in the page, get JSON back | own windows |
| `note` / `close_window` | Pin a note; close a window it opened | own windows |

Windows an agent opens are tagged with it ("opened by Rook" in the Director's snapshot). A team
lead may also drive its team's windows. The user's and the Director's windows are never an
agent's to change, and an agent token cannot reach the Director's tools.

### Team hierarchy

Every joint is a ranked team: **you > the Director (the app's AI agent) > one lead > its workers**.
Standalone sessions are outside the hierarchy.

- **On the canvas** each member has a `LEAD | team` or `WORKER | team` chip in its team colour,
  and curved lines run from the lead to its workers. The Director sheet lists the teams as a tree.
- **Team tools.** Each member gets its own MCP server (`team`) with a token that identifies its
  window. Everyone has `team` (see the team) and `report` (done / blocked / question / progress);
  the lead also has `spawn_worker` (max 4), `prompt_worker` and `brief`. The app checks rank and
  team on every call, and an agent token can never reach the Director's tools.
- **Reports flow up.** A worker's report lands in its lead's input; a lead's report goes to the
  Director, which may act within that team's goal but never starts new work. Messages wait for an
  agent's current turn instead of interrupting it.
- **Tasks and budgets.** Work handed to a member becomes a `doing` card on the team's task list and
  moves to `done` when it reports done (open a live board with `{op:"board", joint}`). Each team
  tracks its own spend (Claude look only); `{op:"team_budget", joint, usd}` caps it.
- **Hierarchy view** (`Ctrl+Shift+H`, View → Hierarchy, or "show hierarchy"): an org chart with
  each agent's status, current task and latest report. Click a card to jump to the window.
- **Live test:** `XODECODE_TEAMTEST=<dir> XODECODE_USERDATA=<dir>/profile npx electron .` runs a
  small Haiku team through every step in a throwaway profile (`src/main/teamtest.js`). Add
  `XODECODE_TEST_KIND=agent` to test the agent canvas/browser tools instead.
- **Stress test:** `XODECODE_TEST_KIND=stress` (same two variables) opens 24 browsers, 8 shells and
  6 notes and prints frame rates for pan/zoom, busy terminals, memory and CPU
  (`src/main/stresstest.js`; counts via `XODECODE_STRESS=browsers=40,terms=12`, breakdowns via
  `XODECODE_STRESS_DIAG=1`). It never starts Claude: the Director, chats and `claude` are blocked
  for the whole run.

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

- Infinite canvas over an animated pixel-art scene (or a plain dot grid) — drag empty canvas (or use the middle mouse button) to pan. **The scroll wheel zooms** (no modifier needed); scroll over a terminal, note or chat to scroll that instead. Dragging inside a window never pans the canvas.
- Freeform windows: drag by the title bar, resize from the bottom-right grip.
- **New terminals snap into a tidy grid** — the first free cell, origin-anchored, instead of stacking at random.
- The **×** in a window's title bar closes it and kills its PTY.
- **The page bar** stays hidden until you want it: point at the small arrow at the top centre (or the top edge), or press `Alt`, and it slides down with your pages, the menus and the window buttons. Click a page to switch, double-click to rename, **×** closes one and **+** adds one; `Ctrl` `1`…`9` jumps straight to a page. **View ▸ Always show the page bar** (or Settings ▸ Appearance) keeps it down.
- **Each tab has its own workspace folder.** When you add a tab it asks you to pick a folder; every terminal and agent you open on that tab starts there, and the tab is named after the folder. Change it any time from the empty-canvas button or **Settings → Canvas**.
- **File / Edit / View / Help** menus in the page bar hold the app commands: new terminals, workspace folder, new/close page, settings, map, director log and zoom.
- Terminals support copy and paste: `Ctrl` `C` / `Ctrl` `Insert` copies a selection, `Ctrl` `V` / `Shift` `Insert` pastes.
- **Music player** windows (`File ▸ New music player`, or ask the Director to `music`): a **Radio** tab that searches and plays internet radio (free Radio Browser API, no key) and a **Spotify** tab that embeds the official player for any track/album/playlist link you paste.
- **In-app browser** windows render real pages on the canvas (back / forward / reload / address bar). Open one from **File ▸ New browser**, or ask the Director to `browser --url "…"`. Pages stay inside the app — never the system browser.
- The mic button at the left of the prompt (or `Ctrl` `Shift` `M`) dictates into the prompt box you were last using — the Director bar, an agent's chat, or the Director sheet. By default it uses Windows' own speech engine inside XodeCode, with your words appearing live in the box and no Windows pop-up; **Settings ▸ Director ▸ Dictation** can switch to the Windows voice typing panel (Win+H) instead.
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
- Layout, pages, notes and settings persist in local storage.
- **Claude GUI mode** (off by default): turn it on in **Settings → Canvas** and Claude agents look exactly like the Claude Code terminal UI — the welcome box, `>` prompts, `⏺` bullets, tool calls such as `Bash(npm test)` with their `⎿` results (long output folds behind *+N lines*), red/green diffs for edits, todo checklists, the `✻` spinner, the bordered input box and slash commands (`/model`, `/effort`, `/clear`, `/resume`, `/cost`, `/help`) — but drawn as crisp HTML that scales with the window. It talks to `claude -p --output-format stream-json` and resumes the same session for every message. **Chats are saved** (`%APPDATA%\xodecode\chats`) and survive restarts.
- Terminals render supersampled (1.5×) so text stays crisp.
- **Animated backgrounds**: six original pixel-art scenes, all drawn from code: **Lantern harbour** (lanterns, moored boats, a lighthouse sweeping its beam), **Moonlit lake** (mountains, a glittering moon path, fireflies), **Sunset lake**, **Rain canal** (lit windows, rain, rings on the water), **Waterfall glen** and **Reef shallows** (caustics, kelp, fish). Water moves, lights flicker, weather drifts. Each scene pixel covers a whole number of screen pixels, so it stays crisp at any window size; it fills the screen and stays put however far you zoom or pan. The animation runs in a worker at 12 frames a second, holds still while you pan or zoom, pauses when XodeCode is minimized, and stops for reduced motion or **Settings ▸ Appearance ▸ Animate the scene**. You can also use the dot grid or your own picture.

## Attention

- Everything that wants your attention appears in one place, the **top-right corner**: short one-line notes (they fade after a few seconds; hover to keep one) and, below them, a compact row for each agent you cannot see that finished or needs you.
- Hover an agent that is asking a numbered question to answer it right there; click the row to jump to the agent. More than three fold into "N more waiting".
- A small dot on the page bar's arrow (and on the page's tab) shows that an agent on another page is waiting.

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
  styles.css           design tokens and all component styles
  js/
    app.js             bootstrap, shortcuts, window chrome
    director.js        headless Director session, transcript
    directorpanel.js   Director chat panel + full conversation sheet
    dock.js            parked-app dock (bottom-left)
    backgrounds.js     built-in backgrounds (scene list and names)
    scenes/            animated pixel-art scenes, their toolkit and render worker
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
    notifications.js   top-right notification stack
    settings.js        settings sheet
    pages.js           page tabs + map overlay
    topbar.js          page bar that hides until you reach for it
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

## License

[MIT](LICENSE) © 2026 diddy. The built-in scenes are original and drawn from code in this project; `node scripts/render-scenes.mjs out` renders them to PNG. The interface font is [Instrument Sans](https://github.com/Instrument/instrument-sans) (SIL Open Font License, see `assets/fonts/OFL-InstrumentSans.txt`).
