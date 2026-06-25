import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
const COMMAND = `node "${SCRIPT_POSIX}"`;

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

  if (!hasNodeOnPath()) {
    console.error(
      C.yellow(
        "! `node` not found on PATH. The statusline runs as `node <script>`.\n" +
          "  Ensure Node.js is installed and on PATH (it is for anyone using npx/bunx),\n" +
          "  otherwise the statusline won't render.",
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
