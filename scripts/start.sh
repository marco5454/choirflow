#!/usr/bin/env bash
# ChoirFlow launcher (Linux / macOS).
#
# Starts the backend (ts-node, :3000) and the frontend (Vite, :5173) together,
# waits for both to be listening, opens the default browser, and forwards
# Ctrl+C / SIGTERM so both children exit cleanly.
#
# Assumes Node >= 20 and npm are already installed (`node --version`). For
# audio rendering, fluidsynth + ffmpeg must also be installed and on PATH
# — same prerequisites as `npm run dev`; this script just bundles startup.
#
# Usage:
#   ./scripts/start.sh                # run from anywhere; resolves repo paths.
#
# Override behaviour with env vars:
#   BACKEND_PORT=3000  FRONTEND_PORT=5173    # match vite.config.ts proxy
#   OPEN_BROWSER=0                            # skip the auto-open
#   SKIP_INSTALL=1                            # don't run npm install even if
#                                             # node_modules is missing

set -u  # error on undefined vars. We don't use `set -e` because we need to
        # keep running after non-fatal failures (e.g. opening the browser).

# Resolve the repo root from the script's own location so the launcher works
# no matter where you cd'd from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"

BACKEND_PORT="${BACKEND_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

# ----- terminal colours (skip if not a tty) -----
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""; CYAN=""
fi

log()  { printf "%s[choirflow]%s %s\n"   "$CYAN"   "$RESET" "$*"; }
warn() { printf "%s[choirflow]%s %s\n"   "$YELLOW" "$RESET" "$*" >&2; }
err()  { printf "%s[choirflow]%s %s\n"   "$RED"    "$RESET" "$*" >&2; }
ok()   { printf "%s[choirflow]%s %s\n"   "$GREEN"  "$RESET" "$*"; }

# ----- preflight: node / npm / directories present -----
if ! command -v node >/dev/null 2>&1; then
  err "node is not installed or not on PATH. Install Node >= 20: https://nodejs.org/"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed or not on PATH (ships with Node)."
  exit 1
fi
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Detected Node $(node --version); ChoirFlow targets Node >= 20. Things may break."
fi
for d in "$BACKEND_DIR" "$FRONTEND_DIR"; do
  if [ ! -d "$d" ]; then
    err "Expected directory not found: $d"
    err "Run this script from a ChoirFlow checkout (it auto-resolves repo root)."
    exit 1
  fi
done

# ----- install deps if either node_modules is missing -----
maybe_install() {
  local dir="$1" label="$2"
  if [ "$SKIP_INSTALL" = "1" ]; then return 0; fi
  if [ ! -d "$dir/node_modules" ]; then
    log "Installing $label dependencies (first run)..."
    (cd "$dir" && npm install) || { err "npm install failed in $label"; exit 1; }
  fi
}
maybe_install "$BACKEND_DIR"  "backend"
maybe_install "$FRONTEND_DIR" "frontend"

# ----- child process tracking + clean shutdown -----
# We capture each child's PID so we can kill them in our trap. Sending the
# signal to the *process group* would also kill ourselves, so we target PIDs.
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  # Re-entrancy guard: traps can fire more than once on rapid Ctrl+C.
  trap - INT TERM EXIT
  echo  # break out from any half-printed line
  log "Shutting down..."
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # Be polite first; the dev servers honour SIGTERM and tear down child
      # processes (e.g. vite's worker, ts-node's compiler) themselves.
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  # Give them a chance to exit gracefully, then escalate.
  for _ in 1 2 3 4 5; do
    sleep 0.3
    local alive=0
    for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    if [ "$alive" = "0" ]; then break; fi
  done
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  ok "Stopped."
}
trap cleanup INT TERM EXIT

# ----- start backend + frontend -----
# We use `npm run dev` rather than calling ts-node / vite directly so the
# scripts in package.json stay the single source of truth for how each side
# is launched.
log "Starting backend  (port $BACKEND_PORT) ..."
(
  cd "$BACKEND_DIR"
  # Make PORT available to the backend, matching server.ts's env override.
  PORT="$BACKEND_PORT" exec npm run --silent dev
) &
BACKEND_PID=$!

log "Starting frontend (port $FRONTEND_PORT) ..."
(
  cd "$FRONTEND_DIR"
  # Vite reads `--port` from CLI; we pass it via `npm run dev -- --port=...`
  # so vite.config.ts doesn't need to change.
  exec npm run --silent dev -- --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!

# ----- wait for both ports to start listening -----
# We poll TCP rather than parsing log output: more portable, no false positives
# from log lines, and works whether or not the servers are quiet.
wait_for_port() {
  local port="$1" label="$2" max_seconds="${3:-60}"
  local start_ts; start_ts=$(date +%s)
  while true; do
    # Prefer bash's /dev/tcp test (no extra deps). Fallback to nc / curl if
    # bash was built without net support (uncommon).
    if (echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
    if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$port" 2>/dev/null; then return 0; fi

    # Bail out if the corresponding child died early.
    case "$label" in
      backend)  if [ -n "$BACKEND_PID"  ] && ! kill -0 "$BACKEND_PID"  2>/dev/null; then return 2; fi ;;
      frontend) if [ -n "$FRONTEND_PID" ] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then return 2; fi ;;
    esac

    local now; now=$(date +%s)
    if [ $((now - start_ts)) -ge "$max_seconds" ]; then return 1; fi
    sleep 0.3
  done
}

log "Waiting for servers to be ready..."
if ! wait_for_port "$BACKEND_PORT" backend 60; then
  err "Backend did not start listening on :$BACKEND_PORT within 60s. See logs above."
  exit 1
fi
ok "Backend listening on http://localhost:$BACKEND_PORT"

if ! wait_for_port "$FRONTEND_PORT" frontend 60; then
  err "Frontend did not start listening on :$FRONTEND_PORT within 60s. See logs above."
  exit 1
fi
ok "Frontend listening on http://localhost:$FRONTEND_PORT"

# ----- open browser -----
open_browser() {
  local url="$1"
  if   command -v xdg-open >/dev/null 2>&1; then xdg-open  "$url" >/dev/null 2>&1 &
  elif command -v open      >/dev/null 2>&1; then open      "$url" >/dev/null 2>&1 &
  elif command -v wslview   >/dev/null 2>&1; then wslview   "$url" >/dev/null 2>&1 &
  else warn "Could not find xdg-open / open / wslview; open $url manually."
  fi
}
if [ "$OPEN_BROWSER" = "1" ]; then
  log "Opening browser..."
  open_browser "http://localhost:$FRONTEND_PORT"
fi

echo
ok  "ChoirFlow is up."
log "${BOLD}Frontend:${RESET} http://localhost:$FRONTEND_PORT"
log "${BOLD}Backend:${RESET}  http://localhost:$BACKEND_PORT"
log "${DIM}Press Ctrl+C to stop.${RESET}"
echo

# ----- block until either child exits, then trigger cleanup -----
# `wait -n` (bash 4.3+) returns when ANY child exits, which is what we want:
# if either side crashes, tear down the other and exit.
wait -n "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
EXIT_CODE=$?
# `cleanup` runs via the EXIT trap.
exit "$EXIT_CODE"
