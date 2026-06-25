#!/usr/bin/env node
// Claude Code statusline. Zero external deps — pure Node built-ins, cross-platform.
// Layout (semantic groups joined by dim │):
//   model  bar %   │  dir (branch)  │  $cost  dur  │  vX.Y.Z  │  cache Xm Ys
// Visual hierarchy: context% / $cost / cache value are colored (the stars);
// dir/branch/duration/version are dim gray (background); model/bar are normal.
//
// Replaces the old assets/statusline.sh (shell + jq): a single Node process is
// faster than the old sh+jq+git multi-spawn pipeline and needs no jq / Git Bash,
// so it works the same on macOS, Linux, and Windows. Only assumption: `node` on PATH.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- read session JSON from stdin (fd 0); empty/bad input degrades, never throws ----
let input = {};
try {
  const raw = readFileSync(0, "utf8");
  if (raw.trim()) input = JSON.parse(raw);
} catch {
  input = {};
}

const model =
  (input.model && input.model.display_name) ? input.model.display_name : "Claude";
const cwd =
  (input.workspace && input.workspace.current_dir) || input.cwd || "";
const usedRaw = input.context_window && input.context_window.used_percentage;
const costRaw = input.cost && input.cost.total_cost_usd;
const durRaw = input.cost && input.cost.total_duration_ms;
const version = input.version || "";
const transcript = input.transcript_path || "";

// ---- config: env vars, optionally from ~/.claude/cc-api-status-line.rc ----
// The rc file is the reliable channel — Claude Code may not inherit your
// interactive shell's exported vars. Put `CCSL_BAR_WIDTH=12` etc. in it.
// (The old shell renderer `source`d this file; here we parse simple KEY=value
// lines — covers all documented usage. rc values win over the process env,
// matching the old `. rc` then `${VAR:-default}` precedence.)
function parseRc(path) {
  const out = {};
  if (!existsSync(path)) return out;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(CCSL_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}
const rc = parseRc(join(homedir(), ".claude", "cc-api-status-line.rc"));
const cfg = (k) => (rc[k] !== undefined ? rc[k] : process.env[k]);

let BAR_W = cfg("CCSL_BAR_WIDTH");
BAR_W = BAR_W && /^[0-9]+$/.test(BAR_W) ? Number(BAR_W) : 18; // guard: non-neg int
const ORDER = (cfg("CCSL_ORDER") || "model,cost,ctx,cache,git,time").replace(
  /\s/g,
  "",
);
const HIDE = (cfg("CCSL_HIDE") || "").replace(/\s/g, "");
const hidden = new Set(HIDE ? HIDE.split(",") : []);
const isHidden = (k) => hidden.has(k);

// ---- styles ----
const ESC = "\x1b";
const RST = `${ESC}[0m`;
const DIM = `${ESC}[2m`; // faint — separators only
const GRAY = `${ESC}[37m`; // light gray — secondary content (dir/branch/dur/ver/cache)
const CYAN = `${ESC}[36m`;
const GOLD = `${ESC}[33m`; // plain yellow — cost "money meter". NOT bold/bright: some
//                            iTerm2 themes map bold(1;33) & bright(93) yellow to gray.
const GSEP = ` ${DIM}│${RST} `;
const ELL = "...";

// small helpers
const pad2 = (n) => String(n).padStart(2, "0");
function git(args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// ===== compute each segment =====

// model (cyan) — always at least "Claude"
let s_model = model ? `${CYAN}${model}${RST}` : "";

// context bar + % — always renders (absent context → 0%)
// bar = background-color spaces (no glyphs → identical on every font/terminal)
let used = Number(usedRaw);
if (!Number.isFinite(used)) used = 0;
const used_int = Math.round(used);
const cc = used_int < 50 ? 32 : used_int < 80 ? 33 : 31;
let bar_filled = Math.floor((used_int * BAR_W) / 100);
if (bar_filled > BAR_W) bar_filled = BAR_W;
if (used_int > 0 && bar_filled < 1) bar_filled = 1;
const bar_empty = BAR_W - bar_filled;
// filled bg = threshold color + 10 (42/43/41); empty track bg = 100 (dark gray)
let s_ctx =
  `${ESC}[${cc + 10}m${" ".repeat(bar_filled)}${ESC}[100m${" ".repeat(bar_empty)}${RST}` +
  ` ${ESC}[${cc}m${used_int}%${RST}`;

// $cost (gold) — the money meter
const cost = Number(costRaw);
let s_cost = Number.isFinite(cost) && costRaw !== "" && costRaw != null
  ? `${GOLD}$ ${cost.toFixed(4)}${RST}`
  : "";

// dir (gray) — basename, tolerant of both / and \ separators (Windows paths)
const base = cwd ? cwd.split(/[\\/]/).pop() : "";
let s_dir = base ? `${GRAY}${base}${RST}` : "";

// git branch (gray, yellow when dirty) — degrades to "" with no git / not a repo
let s_branch = "";
if (cwd && git(["rev-parse", "--git-dir"]) !== null) {
  let branch = (git(["branch", "--show-current"]) || "").trim();
  if (!branch) branch = (git(["rev-parse", "--short", "HEAD"]) || "").trim();
  if (branch) {
    if (branch.length > 24) branch = ELL + branch.slice(branch.length - 23);
    const st = git(["status", "--porcelain"]);
    const bcol = st && st.trim().length > 0 ? 33 : 37; // yellow dirty / gray clean
    s_branch = `${ESC}[${bcol}m(${branch})${RST}`;
  }
}

// duration (gray)
let s_dur = "";
const dur = Number(durRaw);
if (Number.isFinite(dur) && durRaw !== "" && durRaw != null) {
  const secs = Math.floor(Math.round(dur) / 1000);
  let dtxt;
  if (secs >= 3600) dtxt = `${Math.floor(secs / 3600)}h${pad2(Math.floor((secs % 3600) / 60))}m`;
  else if (secs >= 60) dtxt = `${Math.floor(secs / 60)}m`;
  else dtxt = `${secs}s`;
  s_dur = `${GRAY}${dtxt}${RST}`;
}

// version (gray)
let s_ver = version ? `${GRAY}v${version}${RST}` : "";

// cache TTL (label/tag gray, value colored)
let s_cache = "";
if (transcript && existsSync(transcript)) {
  const row = lastCacheRow(transcript);
  if (row) {
    const { remaining, tag } = row;
    if (remaining <= 0) {
      s_cache = `${GRAY}cache${RST} ${ESC}[31mCOLD${RST} ${GRAY}(${tag})${RST}`;
    } else {
      let ctxt;
      if (remaining >= 3600)
        ctxt = `${Math.floor(remaining / 3600)}h${pad2(Math.floor((remaining % 3600) / 60))}m`;
      else if (remaining >= 60)
        ctxt = `${Math.floor(remaining / 60)}m${pad2(remaining % 60)}s`;
      else ctxt = `${remaining}s`;
      const ccol = remaining < 60 ? 31 : 32;
      s_cache = `${GRAY}cache${RST} ${ESC}[${ccol}m${ctxt}${RST} ${GRAY}(${tag})${RST}`;
    }
  }
}

// Read the tail (~320KB) of the transcript, find the last assistant row with a
// timestamp, and compute the prompt-cache TTL remaining. Returns null if none.
function lastCacheRow(path) {
  let text;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const want = 327680;
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line); // partial first line / non-JSON → skip
    } catch {
      continue;
    }
    if (row && row.type === "assistant" && row.timestamp != null) last = row;
  }
  if (!last) return null;
  const t = Date.parse(last.timestamp);
  if (Number.isNaN(t)) return null;
  const ccreate = (last.message && last.message.usage && last.message.usage.cache_creation) || {};
  const is1h = Number(ccreate.ephemeral_1h_input_tokens || 0) > 0;
  const ttl = is1h ? 3600 : 300;
  const remaining = Math.floor(ttl - (Date.now() / 1000 - t / 1000));
  return { remaining, tag: is1h ? "1h" : "5m" };
}

// ===== apply CCSL_HIDE (atoms; git=dir+branch, time=dur+ver) =====
if (isHidden("model")) s_model = "";
if (isHidden("cost")) s_cost = "";
if (isHidden("ctx")) s_ctx = "";
if (isHidden("cache")) s_cache = "";
if (isHidden("dir")) s_dir = "";
if (isHidden("branch")) s_branch = "";
if (isHidden("git")) {
  s_dir = "";
  s_branch = "";
}
if (isHidden("duration")) s_dur = "";
if (isHidden("version")) s_ver = "";
if (isHidden("time")) {
  s_dur = "";
  s_ver = "";
}

// ===== assemble in CCSL_ORDER (unknown tokens ignored; empty segments skipped) =====
const segMap = {
  model: [s_model],
  cost: [s_cost],
  ctx: [s_ctx],
  cache: [s_cache],
  git: [s_dir, s_branch],
  time: [s_dur, s_ver],
};
const groups = [];
for (const tok of ORDER.split(",")) {
  const segs = segMap[tok];
  if (!segs) continue;
  const g = segs.filter((x) => x).join("  ");
  if (g) groups.push(g);
}

process.stdout.write(groups.join(GSEP));
