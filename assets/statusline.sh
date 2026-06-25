#!/bin/sh
# Claude Code statusline. Deps: jq only.
# Layout (semantic groups joined by dim │):
#   model  bar %   │  dir ⎇branch  │  $cost  dur  │  vX.Y.Z  │  cache Xm Ys
# Visual hierarchy: context% / $cost / cache value are BOLD (the stars);
# dir/branch/duration/version are dim (background); model/bar are normal.
#
# NOTE: never name a variable GROUPS — it is a special bash array variable
# (the user's group IDs); assigning to it aborts the script under macOS
# /bin/sh (bash 3.2 in POSIX mode). We use OUT instead.
input=$(cat)

# ---- one jq call → shell assignments via @sh, then eval ----
# @sh shell-quotes each value safely (spaces, quotes, empties), avoiding the
# read/heredoc/IFS field-shift pitfalls of tab-delimited parsing.
eval "$(printf '%s' "$input" | jq -r '
  @sh "model=\((.model.display_name // "") | if . == "" then "Claude" else . end)",
  @sh "cwd=\(.workspace.current_dir // .cwd // "")",
  @sh "used=\((.context_window.used_percentage // "") | tostring)",
  @sh "cost=\((.cost.total_cost_usd // "") | tostring)",
  @sh "dur=\((.cost.total_duration_ms // "") | tostring)",
  @sh "version=\(.version // "")",
  @sh "transcript=\(.transcript_path // "")"
')"

# ---- config: env vars (optionally from ~/.claude/cc-api-status-line.rc) ----
# The rc file is the reliable channel — Claude Code may not inherit your
# interactive shell's exported vars. Put `CCSL_BAR_WIDTH=12` etc. in it.
[ -f "${HOME}/.claude/cc-api-status-line.rc" ] && . "${HOME}/.claude/cc-api-status-line.rc"
BAR_W=${CCSL_BAR_WIDTH:-18}
case "$BAR_W" in ''|*[!0-9]*) BAR_W=18 ;; esac          # guard: positive integer
ORDER=${CCSL_ORDER:-model,cost,ctx,cache,git,time}
ORDER=$(printf '%s' "$ORDER" | tr -d ' ')               # tolerate "a, b" spacing
HIDE=${CCSL_HIDE:-}
HIDE=$(printf '%s' "$HIDE" | tr -d ' ')
is_hidden() { case ",${HIDE}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ---- styles ----
ESC=$(printf '\033')
RST="${ESC}[0m"
DIM="${ESC}[2m"      # faint — separators only
GRAY="${ESC}[37m"    # light gray — secondary content (dir/branch/dur/ver/cache)
CYAN="${ESC}[36m"
GOLD="${ESC}[33m"     # plain yellow — cost "money meter". NOT bold/bright: some
                      # iTerm2 themes map bold(1;33) & bright(93) yellow to gray.
DOLLAR='$'

GSEP=" ${DIM}│${RST} "
ELL="..."

# ---- group assembly via global mutation ----
OUT=""
g=""
g_add() { # append segment $1 into current group g (two-space sep), skip empty
  [ -z "$1" ] && return
  if [ -z "$g" ]; then g="$1"; else g="$g  $1"; fi
}
g_flush() { # commit current group into OUT (│ sep), then reset
  if [ -n "$g" ]; then
    if [ -z "$OUT" ]; then OUT="$g"; else OUT="${OUT}${GSEP}${g}"; fi
  fi
  g=""
}

# ===== compute each segment into a variable =====

# model (cyan)
s_model=""
[ -n "$model" ] && s_model="${CYAN}${model}${RST}"

# context bar + % (BOLD, threshold) — always renders (absent context → 0%)
# bar = background-color spaces (no glyphs → identical on every font/terminal)
[ -z "$used" ] && used=0
used_int=$(printf '%.0f' "$used")
if [ "$used_int" -lt 50 ]; then cc=32
elif [ "$used_int" -lt 80 ]; then cc=33
else cc=31
fi
bar_filled=$((used_int * BAR_W / 100))
[ "$bar_filled" -gt "$BAR_W" ] && bar_filled="$BAR_W"
[ "$used_int" -gt 0 ] && [ "$bar_filled" -lt 1 ] && bar_filled=1
bar_empty=$((BAR_W - bar_filled))
fb=""; i=0; while [ "$i" -lt "$bar_filled" ]; do fb="$fb "; i=$((i + 1)); done
eb=""; i=0; while [ "$i" -lt "$bar_empty" ]; do eb="$eb "; i=$((i + 1)); done
# filled bg = threshold color + 10 (42/43/41); empty track bg = 100 (dark gray)
s_ctx="${ESC}[$((cc + 10))m${fb}${ESC}[100m${eb}${RST} ${ESC}[${cc}m${used_int}%${RST}"

# $cost (BOLD gold) — the money meter
s_cost=""
[ -n "$cost" ] && s_cost="${GOLD}${DOLLAR} $(printf '%.4f' "$cost")${RST}"

# dir (gray)
s_dir=""
[ -n "$cwd" ] && s_dir="${GRAY}${cwd##*/}${RST}"

# git branch (gray, * dirty in yellow)
s_branch=""
if [ -n "$cwd" ] && git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  [ -z "$branch" ] && branch=$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    n=${#branch}
    if [ "$n" -gt 24 ]; then
      start=$((n - 22))
      branch="${ELL}$(printf '%s' "$branch" | cut -c"$start"-)"
    fi
    bcol=37   # gray when clean
    if git -C "$cwd" status --porcelain 2>/dev/null | grep -q .; then
      bcol=33  # yellow when dirty (replaces the old * marker)
    fi
    s_branch="${ESC}[${bcol}m(${branch})${RST}"
  fi
fi

# duration (gray)
s_dur=""
if [ -n "$dur" ]; then
  secs=$(printf '%.0f' "$dur"); secs=$((secs / 1000))
  if [ "$secs" -ge 3600 ]; then
    dtxt=$(printf '%dh%02dm' $((secs / 3600)) $(((secs % 3600) / 60)))
  elif [ "$secs" -ge 60 ]; then
    dtxt=$(printf '%dm' $((secs / 60)))
  else
    dtxt="${secs}s"
  fi
  s_dur="${GRAY}${dtxt}${RST}"
fi

# version (gray)
s_ver=""
[ -n "$version" ] && s_ver="${GRAY}v${version}${RST}"

# cache TTL (label/tag gray, value BOLD)
s_cache=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  cd_raw=$(tail -c 327680 "$transcript" 2>/dev/null | jq -rRn '
    [ inputs | fromjson? | select(.type=="assistant" and .timestamp != null) ] as $rows
    | ($rows | last) as $r
    | if $r == null then empty
      else
        (($r.message.usage.cache_creation // {})) as $cc
        | (($cc.ephemeral_1h_input_tokens // 0) > 0) as $is1h
        | (if $is1h then 3600 else 300 end) as $ttl
        | ($r.timestamp | sub("\\.[0-9]+";"") | fromdateiso8601) as $t
        | "\((($ttl - (now - $t)) | floor))\t\(if $is1h then "1h" else "5m" end)"
      end' 2>/dev/null)
  if [ -n "$cd_raw" ]; then
    rem=$(printf '%s' "$cd_raw" | cut -f1)
    tag=$(printf '%s' "$cd_raw" | cut -f2)
    if [ "$rem" -le 0 ] 2>/dev/null; then
      s_cache="${GRAY}cache${RST} ${ESC}[31mCOLD${RST} ${GRAY}(${tag})${RST}"
    elif [ -n "$rem" ]; then
      if [ "$rem" -ge 3600 ]; then
        ctxt=$(printf '%dh%02dm' $((rem / 3600)) $(((rem % 3600) / 60)))
      elif [ "$rem" -ge 60 ]; then
        ctxt=$(printf '%dm%02ds' $((rem / 60)) $((rem % 60)))
      else
        ctxt="${rem}s"
      fi
      if [ "$rem" -lt 60 ]; then ccol=31; else ccol=32; fi
      s_cache="${GRAY}cache${RST} ${ESC}[${ccol}m${ctxt}${RST} ${GRAY}(${tag})${RST}"
    fi
  fi
fi

# ===== apply CCSL_HIDE (atoms; git=dir+branch, time=dur+ver) =====
is_hidden model    && s_model=""
is_hidden cost     && s_cost=""
is_hidden ctx      && s_ctx=""
is_hidden cache    && s_cache=""
is_hidden dir      && s_dir=""
is_hidden branch   && s_branch=""
is_hidden git      && { s_dir=""; s_branch=""; }
is_hidden duration && s_dur=""
is_hidden version  && s_ver=""
is_hidden time     && { s_dur=""; s_ver=""; }

# ===== assemble in CCSL_ORDER (unknown tokens ignored; empty segments skipped) =====
oldifs=$IFS; IFS=,
for tok in $ORDER; do
  case "$tok" in
    model) g_add "$s_model"; g_flush ;;
    cost)  g_add "$s_cost";  g_flush ;;
    ctx)   g_add "$s_ctx";   g_flush ;;
    cache) g_add "$s_cache"; g_flush ;;
    git)   g_add "$s_dir"; g_add "$s_branch"; g_flush ;;
    time)  g_add "$s_dur"; g_add "$s_ver";    g_flush ;;
  esac
done
IFS=$oldifs

printf '%s' "$OUT"
