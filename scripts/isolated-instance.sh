#!/usr/bin/env bash
#
# A THROWAWAY, SAFE-TO-BOOT CloudCLI instance for verification work.
#
# WHY IT EXISTS. Verifying a UI/API change by hand used to mean copying the live auth.db and
# starting a second server on it. The resident-restore pass is ON by default, so that second
# server dutifully relaunched one `claude --resume` process per live session — on 2026-10-24,
# sixteen duplicate CLI processes for a copy of the live database. Restoring sessions is the
# right behaviour for a real restart and the wrong behaviour for an inspection copy.
#
# WHAT IT GUARANTEES, mechanically:
#   1. the database is a better-sqlite3 BACKUP copy, never the live file, and the copied users get
#      a fresh one-time password (never the operator's own credentials);
#   2. the settings file it points SERVER_SETTINGS_PATH at says `residentRestore.enabled: false`,
#      and the script re-reads that file before trusting the boot;
#   3. host-wide resident-scope SWEEPING is off for this server (`CLAUDE_SESSION_SCOPE_SWEEP=off`),
#      so booting a throwaway instance never reaps a live server's session scopes;
#   4. after boot it reads the server log: a `[resident-restore]` line with `started>0` means the
#      isolation did not hold, so it stops everything and exits non-zero instead of leaving the
#      duplicate processes behind;
#   5. `stop` addresses ONLY the scopes whose names embed THIS instance's server pid
#      (`claudecodeui-session-<pid>-*`), then terminates the server it started — never a
#      command-line text match, which would also kill the operator's real sessions.
#
# USAGE.
#   scripts/isolated-instance.sh start    # prints one JSON line; token file in the state dir
#   scripts/isolated-instance.sh status
#   scripts/isolated-instance.sh stop
#
# ENVIRONMENT (all optional; the defaults are the production-shaped ones):
#   ISOLATED_INSTANCE_STATE_DIR    state/log/db directory (default <repo>/tmp/isolated-instance)
#   ISOLATED_INSTANCE_SERVER_ENTRY server entrypoint (default <repo>/dist-server/server/index.js)
#   ISOLATED_INSTANCE_SOURCE_DB    database to copy (default ~/.cloudcli/auth.db)
#   ISOLATED_INSTANCE_USERNAME     existing user whose password is reset (default: first user)
#   ISOLATED_INSTANCE_PORT         fixed port (default: an OS-assigned free port)
#   ISOLATED_INSTANCE_START_TIMEOUT_MS  health-check budget (default 60000)
#   ISOLATED_INSTANCE_LOG_SETTLE_MS     wait before reading the restore line (default 3000)
#   SYSTEMCTL_BIN / NODE_BIN / CURL_BIN binaries used by the script (defaults: systemctl/node/curl)
#
# The overrides are what make this testable without booting the product: the criterion in
# `scripts/isolated-instance.test.mjs` points the script at a stub server and a stub systemctl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${ISOLATED_INSTANCE_STATE_DIR:-$REPO_ROOT/tmp/isolated-instance}"
SERVER_ENTRY="${ISOLATED_INSTANCE_SERVER_ENTRY:-$REPO_ROOT/dist-server/server/index.js}"
SOURCE_DB="${ISOLATED_INSTANCE_SOURCE_DB:-$HOME/.cloudcli/auth.db}"
REQUESTED_USER="${ISOLATED_INSTANCE_USERNAME:-}"
FIXED_PORT="${ISOLATED_INSTANCE_PORT:-}"
START_TIMEOUT_MS="${ISOLATED_INSTANCE_START_TIMEOUT_MS:-60000}"
LOG_SETTLE_MS="${ISOLATED_INSTANCE_LOG_SETTLE_MS:-3000}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
NODE_BIN="${NODE_BIN:-node}"
CURL_BIN="${CURL_BIN:-curl}"

PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
LOG_FILE="$STATE_DIR/server.log"
SETTINGS_FILE="$STATE_DIR/server.settings.json"
DB_FILE="$STATE_DIR/auth.db"
TOKEN_FILE="$STATE_DIR/auth-token"
USERNAME_FILE="$STATE_DIR/username"

log() { printf '[isolated-instance] %s\n' "$*" >&2; }

# Prints one JSON object derived from `II_OUT_*` environment variables. `node` owns the escaping,
# so a path with a quote cannot corrupt the line a caller parses.
json_out() {
  "$NODE_BIN" - <<'NODE'
const output = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('II_OUT_')) continue;
  const name = key.slice('II_OUT_'.length).toLowerCase();
  if (value === 'true' || value === 'false') output[name] = value === 'true';
  else if (value !== undefined && /^-?\d+$/.test(value)) output[name] = Number(value);
  else output[name] = value;
}
process.stdout.write(`${JSON.stringify(output)}\n`);
NODE
}

# Reads one field from a JSON body; empty when it is not valid JSON or lacks the field.
# The body is an argument (not stdin) because a function's heredoc owns stdin.
json_field() {
  "$NODE_BIN" - "$1" "$2" <<'NODE'
    try {
      const value = JSON.parse(process.argv[2])[process.argv[3]];
      if (value !== undefined && value !== null) process.stdout.write(String(value));
    } catch {
      // An unreadable body is the caller to handle; empty output is the honest reading.
    }
NODE
}

# Prints a free TCP port on the loopback interface, chosen by the OS.
pick_port() {
  "$NODE_BIN" -e '
    const server = require("node:net").createServer();
    server.on("error", () => process.exit(1));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(String(typeof address === "object" && address ? address.port : 0));
      server.close();
    });
  '
}

# A random one-time password. urlsafe so it survives a JSON body and a shell variable unchanged.
one_time_password() {
  "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))'
}

# Copied from the live database with better-sqlite3's online backup (WAL-safe), then the given
# user's password hash is replaced. Never opens the source read-write.
prepare_database() {
  local password="$1"
  if [[ ! -f "$SOURCE_DB" ]]; then
    log "no source database at $SOURCE_DB — the instance will create an empty one and register its own user"
    return 0
  fi
  (
    cd "$REPO_ROOT"
    II_SRC_DB="$SOURCE_DB" II_DEST_DB="$DB_FILE" II_PASSWORD="$password" II_USER="$REQUESTED_USER" \
      "$NODE_BIN" - <<'NODE'
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

(async () => {
  const source = new Database(process.env.II_SRC_DB, { readonly: true, fileMustExist: true });
  await source.backup(process.env.II_DEST_DB);
  source.close();

  const copy = new Database(process.env.II_DEST_DB);
  let user = process.env.II_USER || '';
  if (user === '') {
    try {
      const row = copy.prepare('SELECT username FROM users ORDER BY id LIMIT 1').get();
      user = typeof row?.username === 'string' ? row.username : '';
    } catch {
      user = '';
    }
  }
  if (user === '') {
    copy.close();
    process.stdout.write(JSON.stringify({ user: '', updated: false }));
    return;
  }
  const hash = await bcrypt.hash(process.env.II_PASSWORD, 10);
  const result = copy.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, user);
  copy.close();
  process.stdout.write(JSON.stringify({ user, updated: result.changes > 0 }));
})();
NODE
  )
}

# `systemctl --user list-units` restricted to the scope prefix that embeds `$1` (a server pid).
# Mirrors the server's own listing so the names this script stops are the names it created.
list_scopes() {
  local pid="$1"
  "$SYSTEMCTL_BIN" --user list-units "claudecodeui-session-$pid-*" --no-legend --plain 2>/dev/null \
    | awk '{ print $1 }' \
    | grep -E "^claudecodeui-session-$pid-[^[:space:]]+\.scope$" \
    || true
}

# Stops one scope the way the server's own shutdown does: stop, clear the failed record, and force
# a kill only if it is still listed. A missing systemd user manager is not fatal here.
stop_scope() {
  local pid="$1"
  local unit="$2"
  "$SYSTEMCTL_BIN" --user stop "$unit" >/dev/null 2>&1 || true
  "$SYSTEMCTL_BIN" --user reset-failed "$unit" >/dev/null 2>&1 || true
  if list_scopes "$pid" | grep -qx "$unit"; then
    "$SYSTEMCTL_BIN" --user kill --signal=SIGKILL "$unit" >/dev/null 2>&1 || true
    "$SYSTEMCTL_BIN" --user stop "$unit" >/dev/null 2>&1 || true
    "$SYSTEMCTL_BIN" --user reset-failed "$unit" >/dev/null 2>&1 || true
  fi
}

# Stops the scopes owned by this instance's server pid, then the server itself.
# Echoes a JSON line unless `$1` is `silent`.
stop_instance() {
  local silent="${1:-}"
  local pid=""
  local stopped_scopes=()
  local residual_scopes=()

  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi

  if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]]; then
    while IFS= read -r unit; do
      [[ -z "$unit" ]] && continue
      stop_scope "$pid" "$unit"
      stopped_scopes+=("$unit")
    done < <(list_scopes "$pid")

    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 100); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi

    while IFS= read -r unit; do
      [[ -z "$unit" ]] && continue
      residual_scopes+=("$unit")
    done < <(list_scopes "$pid")
    rm -f "$PID_FILE"
  fi

  local port=""
  if [[ -f "$PORT_FILE" ]]; then
    port="$(cat "$PORT_FILE" 2>/dev/null || true)"
  fi
  local port_still_serving=false
  if [[ -n "$port" ]] && "$CURL_BIN" -m 1 -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    port_still_serving=true
  fi

  if [[ "$silent" == "silent" ]]; then
    return 0
  fi

  local stopped_join=""
  if [[ ${#stopped_scopes[@]} -gt 0 ]]; then
    stopped_join="$(IFS=,; echo "${stopped_scopes[*]}")"
  fi
  local residual_join=""
  if [[ ${#residual_scopes[@]} -gt 0 ]]; then
    residual_join="$(IFS=,; echo "${residual_scopes[*]}")"
  fi

  II_OUT_OK="$([[ ${#residual_scopes[@]} -eq 0 && "$port_still_serving" == false ]] && echo true || echo false)" \
  II_OUT_PID="$pid" \
  II_OUT_PORT="$port" \
  II_OUT_STOPPED_SCOPES="$stopped_join" \
  II_OUT_RESIDUAL_SCOPES="$residual_join" \
  II_OUT_PORT_STILL_SERVING="$port_still_serving" \
  II_OUT_STATE_DIR="$STATE_DIR" \
    json_out

  [[ ${#residual_scopes[@]} -eq 0 && "$port_still_serving" == false ]]
}

# Fails a `start` after the server was spawned: tear the instance down, then report the reason.
die_start() {
  log "ERROR: $*"
  stop_instance silent
  II_OUT_OK=false II_OUT_ERROR="$*" II_OUT_STATE_DIR="$STATE_DIR" json_out >&2
  exit 1
}

start_instance() {
  mkdir -p "$STATE_DIR"

  if [[ -f "$PID_FILE" ]]; then
    local existing
    existing="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
      log "ERROR: an instance is already running (pid $existing); run \`$0 stop\` first"
      exit 1
    fi
    rm -f "$PID_FILE"
  fi

  if [[ ! -f "$SERVER_ENTRY" ]]; then
    log "ERROR: no server entrypoint at $SERVER_ENTRY — run \`npm run build:server\`, or set ISOLATED_INSTANCE_SERVER_ENTRY"
    exit 1
  fi

  local port="$FIXED_PORT"
  if [[ -z "$port" ]]; then
    port="$(pick_port)"
  fi
  if [[ -z "$port" || "$port" == "0" ]]; then
    log "ERROR: could not choose a free port"
    exit 1
  fi
  printf '%s' "$port" >"$PORT_FILE"

  # The isolation artifact itself: forced OFF, written before the server is spawned so there is no
  # window in which it could read a different value.
  umask 077
  cat >"$SETTINGS_FILE" <<'JSON'
{
  "residentRestore": {
    "enabled": false
  }
}
JSON

  local password
  password="$(one_time_password)"
  local user=""
  local db_prep=""
  db_prep="$(prepare_database "$password")"
  user="$(json_field "$db_prep" user)"
  if [[ -n "$user" ]]; then
    printf '%s' "$user" >"$USERNAME_FILE"
  fi

  log "starting $SERVER_ENTRY on 127.0.0.1:$port (residentRestore disabled, scope sweep off)"
  env \
    SERVER_PORT="$port" \
    HOST=127.0.0.1 \
    DATABASE_PATH="$DB_FILE" \
    SERVER_SETTINGS_PATH="$SETTINGS_FILE" \
    CLAUDE_SESSION_SCOPE_SWEEP=off \
    "$NODE_BIN" "$SERVER_ENTRY" >"$LOG_FILE" 2>&1 &
  local server_pid=$!
  printf '%s' "$server_pid" >"$PID_FILE"

  local deadline=$(( $(date +%s) + (START_TIMEOUT_MS / 1000) ))
  local healthy=false
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      die_start "the server exited before answering /health; last log lines: $(tail -n 5 "$LOG_FILE" 2>/dev/null | tr '\n' ' ')"
    fi
    if "$CURL_BIN" -m 1 -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 0.2
  done
  if [[ "$healthy" != true ]]; then
    die_start "the server did not answer /health within ${START_TIMEOUT_MS}ms"
  fi

  # The settings check is a reading of the file the server was given, not a restatement of intent.
  if ! "$NODE_BIN" -e '
      const fs = require("node:fs");
      const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(settings?.residentRestore?.enabled === false ? 0 : 1);
    ' "$SETTINGS_FILE"; then
    die_start "the settings file does not say residentRestore.enabled=false"
  fi

  # Give the (disabled) restore path its window, then read what actually happened.
  sleep "$(awk -v ms="$LOG_SETTLE_MS" 'BEGIN { printf "%.3f", ms / 1000 }')"
  local restore_started=0
  local restore_line=""
  if [[ -f "$LOG_FILE" ]]; then
    restore_line="$(grep -oE '\[resident-restore\].*' "$LOG_FILE" | tail -n 1 || true)"
    local highest
    highest="$(grep -oE 'started=[0-9]+' "$LOG_FILE" | cut -d= -f2 | sort -n | tail -n 1 || true)"
    if [[ -n "$highest" ]]; then
      restore_started="$highest"
    fi
  fi
  if [[ "$restore_started" -gt 0 ]]; then
    die_start "resident restore STARTED $restore_started session(s) despite the isolated settings (log: $restore_line)"
  fi
  log "resident-restore started=$restore_started (restore is disabled; a pass cannot run)"

  # Authenticate: the copied user's one-time password, or a user registered on the fresh DB.
  local token=""
  local login_user="$user"
  if [[ -n "$login_user" ]]; then
    local payload
    payload="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({ username: process.argv[1], password: process.argv[2] }))' "$login_user" "$password")"
    local response
    response="$("$CURL_BIN" -sS -X POST -H 'Content-Type: application/json' --data "$payload" "http://127.0.0.1:$port/api/auth/login" || true)"
    token="$(json_field "$response" token)"
  fi
  if [[ -z "$token" ]]; then
    login_user="isolated_$(one_time_password | cut -c1-8 | tr -- '-_' 'ab')"
    local payload
    payload="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({ username: process.argv[1], password: process.argv[2] }))' "$login_user" "$password")"
    local response
    response="$("$CURL_BIN" -sS -X POST -H 'Content-Type: application/json' --data "$payload" "http://127.0.0.1:$port/api/auth/register" || true)"
    token="$(json_field "$response" token)"
    if [[ -z "$token" ]]; then
      die_start "could not authenticate against the isolated instance (register response: $response)"
    fi
    printf '%s' "$login_user" >"$USERNAME_FILE"
  fi
  printf '%s' "$token" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true

  II_OUT_OK=true \
  II_OUT_BASE_URL="http://127.0.0.1:$port" \
  II_OUT_STATE_DIR="$STATE_DIR" \
  II_OUT_PID="$server_pid" \
  II_OUT_PORT="$port" \
  II_OUT_TOKEN_FILE="$TOKEN_FILE" \
  II_OUT_SETTINGS_FILE="$SETTINGS_FILE" \
  II_OUT_LOG_FILE="$LOG_FILE" \
  II_OUT_USERNAME="$login_user" \
  II_OUT_RESIDENT_RESTORE_STARTED="$restore_started" \
    json_out
}

status_instance() {
  local pid=""
  local running=false
  local port=""
  local healthy=false
  local scopes=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    running=true
  fi
  if [[ -f "$PORT_FILE" ]]; then
    port="$(cat "$PORT_FILE" 2>/dev/null || true)"
  fi
  if [[ "$running" == true && -n "$port" ]] && "$CURL_BIN" -m 1 -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    healthy=true
  fi
  if [[ -n "$pid" ]]; then
    scopes="$(list_scopes "$pid" | tr '\n' ',' || true)"
  fi
  II_OUT_RUNNING="$running" \
  II_OUT_HEALTHY="$healthy" \
  II_OUT_PID="$pid" \
  II_OUT_PORT="$port" \
  II_OUT_BASE_URL="$([[ -n "$port" ]] && echo "http://127.0.0.1:$port" || echo "")" \
  II_OUT_SCOPES="$scopes" \
  II_OUT_STATE_DIR="$STATE_DIR" \
  II_OUT_TOKEN_FILE="$TOKEN_FILE" \
  II_OUT_LOG_FILE="$LOG_FILE" \
    json_out
}

usage() {
  printf 'usage: %s start|stop|status\n' "$0" >&2
  exit 2
}

case "${1:-}" in
  start) start_instance ;;
  stop) stop_instance ;;
  status) status_instance ;;
  *) usage ;;
esac
