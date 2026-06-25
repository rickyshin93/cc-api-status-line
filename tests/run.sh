#!/bin/sh
# TDD harness for assets/statusline.mjs. Runs the statusline under `node` with
# fixture JSON and asserts exit code + (ANSI-stripped) output substrings.
# Usage: sh tests/run.sh   (exits non-zero if any assertion fails)
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$DIR/../assets/statusline.mjs"
NODE=${TEST_NODE:-node}

pass=0
fail=0

strip() { sed 's/\x1b\[[0-9;]*m//g'; }

# run NAME JSON  -> sets $OUT (stripped), $RAW, $EC
run() {
  RAW=$(printf '%s' "$2" | "$NODE" "$SCRIPT" 2>/dev/null)
  EC=$?
  OUT=$(printf '%s' "$RAW" | strip)
}

# run_env NAME "VAR=val VAR2=val2" JSON  -> same, with env vars set
run_env() {
  RAW=$(printf '%s' "$3" | env $2 "$NODE" "$SCRIPT" 2>/dev/null)
  EC=$?
  OUT=$(printf '%s' "$RAW" | strip)
}

ok()   { pass=$((pass + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

assert_exit0()    { [ "$EC" -eq 0 ] && ok "$1: exit 0" || bad "$1: exit $EC (expected 0)"; }
assert_nonempty() { [ -n "$RAW" ] && ok "$1: non-empty" || bad "$1: empty output"; }
assert_has()      { case "$OUT" in *"$2"*) ok "$1: contains '$2'" ;; *) bad "$1: missing '$2' (got: $OUT)" ;; esac; }
assert_lacks()    { case "$OUT" in *"$2"*) bad "$1: should NOT contain '$2' (got: $OUT)" ;; *) ok "$1: lacks '$2'" ;; esac; }
assert_raw_has()  { case "$RAW" in *"$2"*) ok "$1: raw contains '$2'" ;; *) bad "$1: raw missing '$2'" ;; esac; }

# ---- fixtures ----
GITDIR=$(mktemp -d)
( cd "$GITDIR" && git init -q && git checkout -q -b feature/EXAMPLE-1234-long-descriptive-release-merge \
  && echo x > f && git add f && git -c user.email=a@b -c user.name=a commit -qm i && echo y >> f ) >/dev/null 2>&1

CLEANDIR=$(mktemp -d)
( cd "$CLEANDIR" && git init -q && git checkout -q -b main \
  && echo x > f && git add f && git -c user.email=a@b -c user.name=a commit -qm i ) >/dev/null 2>&1

TF_1H=$(mktemp)
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"assistant","timestamp":"%s","message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":500}}}}\n' "$NOW" > "$TF_1H"

TF_COLD=$(mktemp)
printf '{"type":"assistant","timestamp":"2000-01-01T00:00:00.000Z","message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":500}}}}\n' > "$TF_COLD"

echo "statusline tests (NODE=$NODE)"

# 1. full, no git/cache
echo "[case] full"
run full '{"model":{"display_name":"Opus 4.8 (1M context)"},"context_window":{"used_percentage":15},"cost":{"total_cost_usd":6.0761855,"total_duration_ms":1380000},"version":"2.1.181"}'
assert_exit0 full; assert_nonempty full
assert_has full "Opus 4.8 (1M context)"
assert_has full "15%"
assert_has full "\$ 6.0762"
assert_has full "23m"
assert_has full "v2.1.181"

# 2. empty model -> Claude fallback, no orphan leading separator
echo "[case] empty-model"
run empty '{"model":{"display_name":""},"context_window":{"used_percentage":85},"cost":{"total_cost_usd":1.5,"total_duration_ms":45000}}'
assert_exit0 empty; assert_nonempty empty
assert_has empty "Claude"
assert_has empty "85%"
# first segment is model (Claude fallback) — must not start with a separator/space
case "$OUT" in
  [Cc]laude*) ok "empty: starts with model, no leading separator" ;;
  *)          bad "empty: leading junk (got: $OUT)" ;;
esac

# 3. minimal (only context)
echo "[case] minimal"
run min '{"context_window":{"used_percentage":40}}'
assert_exit0 min; assert_nonempty min
assert_has min "40%"

# 3b. NO context field -> bar (bg-color track) still renders at 0%
echo "[case] no-context"
run noctx '{"model":{"display_name":"Opus"}}'
assert_exit0 noctx; assert_nonempty noctx
assert_has noctx "0%"
assert_raw_has noctx "[100m"   # empty-track background code present

# 4. git: long branch truncated + dirty
echo "[case] git-long-dirty"
run git "$(printf '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"%s"},"context_window":{"used_percentage":50}}' "$GITDIR")"
assert_exit0 git; assert_nonempty git
assert_has git "(..."             # truncation marker, inside opening paren
assert_has git "release-merge)"   # tail preserved, inside closing paren
assert_lacks git "feature/EXAMPLE"  # truncated-away head not shown
assert_lacks git "*"                   # dirty shown via color now, not an asterisk

# 5. git clean short branch (no dirty marker, no ellipsis)
echo "[case] git-clean"
run clean "$(printf '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"%s"},"context_window":{"used_percentage":50}}' "$CLEANDIR")"
assert_exit0 clean
assert_has clean "main"
assert_lacks clean "*"

# 6. cache 1h active
echo "[case] cache-1h"
run c1h "$(printf '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":10},"transcript_path":"%s"}' "$TF_1H")"
assert_exit0 c1h
assert_has c1h "cache"
assert_has c1h "(1h)"

# 7. cache cold
echo "[case] cache-cold"
run cold "$(printf '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":10},"transcript_path":"%s"}' "$TF_COLD")"
assert_exit0 cold
assert_has cold "COLD"

# 8. config: CCSL_HIDE removes segments
echo "[case] cfg-hide"
FULL='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":15},"cost":{"total_cost_usd":6.07,"total_duration_ms":1380000},"version":"2.1.181"}'
run_env hide "CCSL_HIDE=version,duration" "$FULL"
assert_exit0 hide
assert_has   hide "Opus"
assert_has   hide "\$ 6.0700"
assert_lacks hide "v2.1.181"
assert_lacks hide "23m"

# 9. config: CCSL_ORDER reorders (cost before model)
echo "[case] cfg-order"
run_env order "CCSL_ORDER=cost,model" "$FULL"
assert_exit0 order
case "$OUT" in '$'*) ok "order: cost is first" ;; *) bad "order: cost not first (got: $OUT)" ;; esac

# 10. config: CCSL_BAR_WIDTH changes bar length (wider => longer output)
echo "[case] cfg-bar-width"
run_env narrow "CCSL_BAR_WIDTH=4 CCSL_ORDER=ctx" '{"context_window":{"used_percentage":50}}'
ln=${#OUT}
run_env wide "CCSL_BAR_WIDTH=30 CCSL_ORDER=ctx" '{"context_window":{"used_percentage":50}}'
lw=${#OUT}
[ "$lw" -gt "$ln" ] && ok "bar-width: 30 wider than 4 ($lw>$ln)" || bad "bar-width: no effect ($lw vs $ln)"

# 11. config: invalid CCSL_BAR_WIDTH falls back, doesn't crash
echo "[case] cfg-bad-width"
run_env badw "CCSL_BAR_WIDTH=abc" "$FULL"
assert_exit0 badw; assert_nonempty badw

# 12. Windows-style cwd (backslashes) -> dir segment is the basename
echo "[case] win-path"
run win '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"C:\\Users\\foo\\my-app"},"context_window":{"used_percentage":10}}'
assert_exit0 win; assert_nonempty win
assert_has win "my-app"
assert_lacks win "Users"          # full path not leaked into the dir segment

# 13. bad JSON on stdin -> degrades, exits 0, still renders the bar
echo "[case] bad-json"
run bad 'not json {{{'
assert_exit0 bad; assert_nonempty bad
assert_has bad "0%"

# 14. empty stdin -> degrades, exits 0
echo "[case] empty-stdin"
run estdin ''
assert_exit0 estdin; assert_nonempty estdin
assert_has estdin "0%"

# ---- cleanup ----
rm -rf "$GITDIR" "$CLEANDIR" "$TF_1H" "$TF_COLD"

echo
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
