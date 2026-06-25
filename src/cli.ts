import { execSync } from "node:child_process";
import {
  chmodSync,
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
const ASSET = join(HERE, "..", "assets", "statusline.sh");

const CLAUDE_DIR = join(homedir(), ".claude");
const SCRIPT_DEST = join(CLAUDE_DIR, "cc-api-status-line.sh");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const COMMAND = `sh ${SCRIPT_DEST}`;

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function hasJq(): boolean {
  try {
    execSync("jq --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

  if (!hasJq()) {
    console.error(
      C.yellow(
        "! jq not found on PATH. The statusline needs it.\n" +
          "  macOS:  brew install jq\n" +
          "  Debian: sudo apt-get install jq\n" +
          "  Continuing setup anyway — install jq before it will render.",
      ),
    );
  }

  copyFileSync(ASSET, SCRIPT_DEST);
  chmodSync(SCRIPT_DEST, 0o755);
  console.log(C.green("✓") + ` script installed → ${SCRIPT_DEST}`);

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
  if (sl?.command === COMMAND) {
    delete settings.statusLine;
    writeSettings(settings);
    console.log(C.green("✓") + " removed statusLine from settings.json");
  } else {
    console.log(
      C.dim("· settings.json statusLine not ours (or absent) — left untouched"),
    );
  }
  if (existsSync(SCRIPT_DEST)) {
    rmSync(SCRIPT_DEST);
    console.log(C.green("✓") + ` removed ${SCRIPT_DEST}`);
  }
  console.log("\n" + C.cyan("Uninstalled.") + " Restart Claude Code to apply.");
}

function help(): void {
  console.log(`cc-api-status-line — statusline for Claude Code

Usage:
  npx cc-api-status-line <command>

Commands:
  init        Install the script and wire it into ~/.claude/settings.json
  uninstall   Remove the script and unset statusLine (only if it's ours)
  help        Show this message

After init, start a new Claude Code session to see the statusline.
Requires: jq on PATH.`);
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
