# cc-api-status-line

A fast, **zero-dependency** [statusline](https://docs.claude.com/en/docs/claude-code/statusline) for **Claude Code** — model, cost, context, prompt-cache TTL, git, and session info, with a clean visual hierarchy and zero special-glyph dependencies. Works natively on **macOS, Linux, and Windows**.

![cc-api-status-line](https://raw.githubusercontent.com/rickyshin93/cc-api-status-line/main/docs/screenshot.png)

```
Opus 4.8 (1M context) │ $ 4.0488 │ ███████░░░░░░░░░░░ 42% │ cache 59m59s (1h) │ my-app (develop) │ 11m  v2.1.181
```

- **Zero dependencies** — a single Node script (no `jq`, no shell tricks). If you can run `npx`, you can run this. Native on macOS, Linux, and Windows.
- **Solid bar, no glyphs** — the context bar is rendered with ANSI background colors (not `█`/`░`), so it looks identical on every terminal and font.
- **Readable hierarchy** — color marks the things you watch (cost, context %, cache); everything else is calm gray.
- **Robust** — one short-lived Node process per render; faster than the old `sh + jq` pipeline. Degrades gracefully when there's no git repo, no cache, or missing fields.
- **Configurable** — width, segment order, and visibility via env vars. No need to edit the script.

## Segments

| segment | shows | color |
| --- | --- | --- |
| model | active model display name | cyan |
| cost | session cost in USD (`$ 0.0000`) | yellow |
| ctx | context-window usage bar + % | green `<50%` · yellow `<80%` · red above |
| cache | prompt-cache TTL countdown (`COLD` when expired) | green, red when expiring |
| git | current dir + `(branch)` — branch turns **yellow when dirty** | gray |
| time | session duration + Claude Code version | gray |

## Requirements

Just **Node.js** on your `PATH` — which you already have if you use `npx`/`bunx`. No `jq`, no Git Bash, nothing else to install. (`git` is used for the branch segment when present; it's optional and degrades gracefully.)

## Install

```sh
npx @rockshin/cc-api-status-line init
# or with bun:
bunx @rockshin/cc-api-status-line init
```

Then start a new Claude Code session. `init` copies the script to
`~/.claude/cc-api-status-line.mjs` and points `statusLine.command` at
`node "~/.claude/cc-api-status-line.mjs"` in `~/.claude/settings.json`.

On Windows this works whether Claude Code routes the status line through Git Bash
or PowerShell — the command is just `node <script>`, and the path uses forward
slashes so Git Bash doesn't mangle it.

## Configuration

Set any of these environment variables. Because Claude Code may not inherit your
interactive shell's exported vars, the **reliable** way is to put them in
`~/.claude/cc-api-status-line.rc` (simple `KEY=value` lines, one per line — the
script reads it on every render; values there override the process env):

```sh
# ~/.claude/cc-api-status-line.rc
CCSL_BAR_WIDTH=12
CCSL_ORDER="model,cost,ctx,cache,git,time"
CCSL_HIDE="version,duration"
```

| variable | default | meaning |
| --- | --- | --- |
| `CCSL_BAR_WIDTH` | `18` | width of the context bar, in cells |
| `CCSL_ORDER` | `model,cost,ctx,cache,git,time` | order of `│`-separated groups; omit a token to drop that whole group; unknown tokens are ignored |
| `CCSL_HIDE` | *(empty)* | comma list of parts to hide |

**`CCSL_ORDER` tokens:** `model`, `cost`, `ctx`, `cache`, `git` (dir + branch), `time` (duration + version).

**`CCSL_HIDE` tokens:** the order tokens above, plus the finer-grained `dir`, `branch`, `duration`, `version`. Hiding `git` hides both dir and branch; hiding `time` hides both duration and version.

### Examples

```sh
# Minimal: just model, cost, context
CCSL_ORDER="model,cost,ctx"

# Drop version and duration, keep everything else
CCSL_HIDE="version,duration"

# Put cost first, narrower bar
CCSL_ORDER="cost,model,ctx,cache,git,time"
CCSL_BAR_WIDTH=10
```

## Uninstall

```sh
npx @rockshin/cc-api-status-line uninstall
```

Removes `~/.claude/cc-api-status-line.sh` and unsets `statusLine` in
`~/.claude/settings.json` (only if it points at this tool). Your `.rc` file is
left in place.

## Troubleshooting

- **Statusline doesn't appear / is blank** — make sure `node` is on your `PATH` (`node --version`). Start a fresh Claude Code session after `init`.
- **A color shows as gray/white** — your terminal theme has remapped that ANSI color (commonly the *bright* palette). This tool deliberately uses plain `30–37` colors, not bold/bright, to avoid that. If a color still looks off, it's your theme's 16-color palette.
- **Config changes don't take effect** — put them in `~/.claude/cc-api-status-line.rc` rather than relying on exported shell vars; Claude Code may not inherit your shell environment.
- **A managed settings file overrides it** — if `/Library/Application Support/ClaudeCode/managed-settings.json` defines a `statusLine`, it wins over `~/.claude/settings.json`. Point that file at `node "~/.claude/cc-api-status-line.mjs"`, or remove its `statusLine` key, to let the user setting apply.

## How it works

Claude Code pipes a JSON blob to the command on every render. The script reads it
from stdin, parses it with `JSON.parse`, shells out to `git` for the branch
segment (optional — skipped if absent), assembles the line, and prints it. It's a
single short-lived Node process with no third-party imports, so it's instant and
runs identically on macOS, Linux, and Windows. The CLI runs only once, at install.

The canonical script is [`assets/statusline.mjs`](assets/statusline.mjs).

## Develop

```sh
bun install
bun run dev init        # run the CLI from source
bun run test            # run the test suite (tests/run.sh drives node)
bun run build           # produce bin/cli.js (node-compatible, shebang added)
```

Render-path changes go in `assets/statusline.mjs`; cover them in `tests/run.sh`.
The suite pipes fixture JSON into `node assets/statusline.mjs` and asserts output.

## License

MIT
