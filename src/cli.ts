import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET = join(HERE, "..", "assets", "statusline.mjs");

const CLAUDE_DIR = join(homedir(), ".claude");
const SCRIPT_DEST = join(CLAUDE_DIR, "cc-api-status-line.mjs");
const LEGACY_DEST = join(CLAUDE_DIR, "cc-api-status-line.sh"); // pre-Node shell renderer

// Path written into settings.json must use forward slashes: on Windows, Claude
// Code runs the statusLine command through Git Bash (or PowerShell), and Git Bash
// eats unquoted backslashes as escapes. Forward slashes work on every platform.
const toPosix = (p: string) => p.replace(/\\/g, "/");
const SCRIPT_POSIX = toPosix(SCRIPT_DEST);
const LEGACY_POSIX = toPosix(LEGACY_DEST);

// Pin the absolute path of the node that ran `init` into the settings command.
// A bare `node` only works while the render-time PATH happens to resolve it —
// on Windows the PATH of the installing terminal often never reaches GUI/
// freshly-spawned shells (portable node, per-shell PATH exports, version
// managers), so the statusline silently dies after reboot / in a new terminal.
// Quoted to survive spaces (e.g. C:/Program Files/nodejs/); POSIX paths +
// double quotes parse identically under Git Bash, PowerShell and cmd.
const BARE_NODE = "node";

// Paths that won't exist for long — resolveNodeRef falls back to bare `node`
// for these, since baking a path that's about to vanish is worse than no path:
//  - npx/bunx cache: `npm-cache/_npx/...`, `bunx-501/...` (package-extraction
//    caches; auto-cleaned by npm/bun, TTL unbounded on Windows)
//  - per-shell version-manager shims: fnm's `fnm_multishells/<rand>/node.exe`
//    and nvs's `nvs/default/...` are ephemeral per-session links — nvs's
//    `current/`, by contrast, is a stable dir link, so it's kept
//  - temp dirs: OS tmp or any `*/tmp/...` segment
// Deliberately NOT volatile: stable manager dirs (nvm/n/fnm node-versions/
// volta tools/nvs current), even though switching versions deletes them —
// the renderer only uses built-ins, so any surviving old node runs it fine,
// and showing the nudge on a working setup would be noise.
function isVolatileNodePath(posixPath: string): boolean {
  const p = posixPath.toLowerCase();
  const seg = p.split("/");
  if (p.startsWith(`${toPosix(tmpdir()).toLowerCase()}/`)) return true;
  if (seg.includes("tmp")) return true;
  if (p.includes("npm-cache/_npx/") || p.includes("_bunx/") || seg.some((s) => s.startsWith("bunx-"))) return true;
  if (p.includes("/fnm_multishells/") || p.includes("/nvs/default/")) return true;
  return false;
}

function resolveNodeRef(): { ref: string; pinned: boolean } {
  const execPosix = toPosix(process.execPath);
  // `bun run src/cli.ts` reports execPath as the bun binary — bun can't run the
  // renderer for end users, so fall back to bare `node` (dev installs use
  // `bun run dev init`; real users come through npx → node).
  if (basename(execPosix).replace(/\.exe$/i, "") === "bun") {
    return { ref: BARE_NODE, pinned: false };
  }
  if (isVolatileNodePath(execPosix)) return { ref: BARE_NODE, pinned: false };
  return { ref: `"${execPosix}"`, pinned: true };
}

const NODE_REF = resolveNodeRef();
const COMMAND = `${NODE_REF.ref} "${SCRIPT_POSIX}"`;

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// Does `node` resolve on PATH? The renderer is invoked as `node <script>`, so the
// shell that runs the statusline must find it. (We're running under Node now, but
// it may have been launched by absolute path — this checks PATH resolution.)
function hasNodeOnPath(): boolean {
  try {
    execSync("node --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Treat a settings command as ours if it references our managed script path
// (current .mjs or the legacy .sh), tolerant of path separator differences.
function isOurCommand(command: string | undefined): boolean {
  if (!command) return false;
  const norm = toPosix(command);
  return norm.includes(SCRIPT_POSIX) || norm.includes(LEGACY_POSIX);
}

const SETTINGS = join(CLAUDE_DIR, "settings.json");

function readSettings(): Record<string, unknown> {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8")) as Record<string, unknown>;
  } catch {
    console.error(
      C.red(`! ${SETTINGS} is not valid JSON. Fix it manually, then re-run.`),
    );
    process.exit(1);
  }
}

function writeSettings(obj: Record<string, unknown>): void {
  writeFileSync(SETTINGS, `${JSON.stringify(obj, null, 2)}\n`);
}

function init(): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });

  if (!NODE_REF.pinned && !hasNodeOnPath()) {
    console.error(
      C.yellow(
        "! `node` not found on PATH, and the Node running this installer lives in a\n" +
          "  volatile location (npx cache / temp), so its path can't be baked into the\n" +
          "  settings command. The statusline runs as `node <script>` — install Node.js\n" +
          "  system-wide (nodejs.org) so any future shell can resolve it.",
      ),
    );
  } else if (!NODE_REF.pinned) {
    console.log(
      C.dim(
        "· node lives in a volatile location (npx cache / temp) — using PATH-based\n" +
          "  `node` in the settings command. If the statusline disappears after a\n" +
          "  reboot/new terminal, install Node system-wide and re-run init.",
      ),
    );
  }

  copyFileSync(ASSET, SCRIPT_DEST);
  console.log(C.green("✓") + ` script installed → ${SCRIPT_DEST}`);

  // Clean up the legacy shell renderer if a previous version left one behind.
  if (existsSync(LEGACY_DEST)) {
    rmSync(LEGACY_DEST);
    console.log(C.dim(`  removed legacy ${LEGACY_DEST}`));
  }

  const settings = readSettings();
  const prev = settings.statusLine as { command?: string } | undefined;
  if (prev?.command && prev.command !== COMMAND) {
    console.log(
      C.dim(`  replacing existing statusLine.command: ${prev.command}`),
    );
  }
  settings.statusLine = { type: "command", command: COMMAND };
  writeSettings(settings);
  console.log(C.green("✓") + ` settings patched → ${SETTINGS}`);

  console.log(
    "\n" +
      C.cyan("Done.") +
      " Open a new Claude Code session (or restart) to see it.",
  );
}

function uninstall(): void {
  const settings = readSettings();
  const sl = settings.statusLine as { command?: string } | undefined;
  if (isOurCommand(sl?.command)) {
    delete settings.statusLine;
    writeSettings(settings);
    console.log(C.green("✓") + " removed statusLine from settings.json");
  } else {
    console.log(
      C.dim("· settings.json statusLine not ours (or absent) — left untouched"),
    );
  }
  for (const f of [SCRIPT_DEST, LEGACY_DEST]) {
    if (existsSync(f)) {
      rmSync(f);
      console.log(C.green("✓") + ` removed ${f}`);
    }
  }
  console.log("\n" + C.cyan("Uninstalled.") + " Restart Claude Code to apply.");
}

function help(): void {
  console.log(`cc-api-status-line — statusline for Claude Code

Usage:
  npx @rockshin/cc-api-status-line <command>

Commands:
  init        Install the script and wire it into ~/.claude/settings.json
  uninstall   Remove the script and unset statusLine (only if it's ours)
  help        Show this message

After init, start a new Claude Code session to see the statusline.
Zero external dependencies — needs only Node.js (already present via npx/bunx).`);
}

const cmd = process.argv[2];
switch (cmd) {
  case "init":
    init();
    break;
  case "uninstall":
    uninstall();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(C.red(`Unknown command: ${cmd}\n`));
    help();
    process.exit(1);
}
