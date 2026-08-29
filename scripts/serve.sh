#!/usr/bin/env bash
# superPi — avvia il server web e lo espone sul tailnet.
#
#   SUPERPI_HOSTNAME=nome-del-nodo SUPERPI_AUTH_USER=... SUPERPI_AUTH_PASSWORD=... npm run serve
#
# Il server ascolta SOLO su 127.0.0.1. SUPERPI_HOSTNAME non configura il
# server: serve solo per stampare un URL informativo non ambiguo.
set -euo pipefail

PORTA="${SUPERPI_PORT:-8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/.test-run"
STATE_FILE="$STATE_DIR/superpi-serve.state"
STATE_TMP=""
PID_FILE="$STATE_DIR/superpi-server.pid"
LOG_FILE="$STATE_DIR/superpi-server.log"
HOSTNAME_INFO="${SUPERPI_HOSTNAME:-}"

if [[ -z "${SUPERPI_AUTH_USER:-}" || -z "${SUPERPI_AUTH_PASSWORD:-}" ]]; then
  echo "FALLITO: npm run serve richiede SUPERPI_AUTH_USER e SUPERPI_AUTH_PASSWORD entrambi non vuoti" >&2
  exit 1
fi
if [[ -z "$HOSTNAME_INFO" ]]; then
  echo "FALLITO: npm run serve richiede SUPERPI_HOSTNAME esplicito per l'URL informativo" >&2
  exit 1
fi
if ! command -v tailscale >/dev/null 2>&1; then
  echo "FALLITO: npm run serve richiede il comando tailscale" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [[ -e "$STATE_FILE" ]]; then
  echo "FALLITO: esiste già lo stato di un server superPi; esegui npm run serve:stop" >&2
  exit 1
fi
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "FALLITO: server già avviato (pid $pid) — fermalo prima" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

SERVER_PID=""
AUTH_FILE=""
SNAPSHOT_FILE=""
SNAPSHOT_READY=0
OWNED=0

stop_server() {
  if [[ "$SERVER_PID" =~ ^[0-9]+$ ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
}

restore_snapshot() {
  (( SNAPSHOT_READY )) || return 0
  if node -e 'const c=require("fs").readFileSync(process.argv[1], "utf8"); const j=JSON.parse(c); process.exit(Object.keys(j).every(k => k === "version") ? 0 : 1)' "$SNAPSHOT_FILE" >/dev/null 2>&1; then
    tailscale serve reset >/dev/null 2>&1 || return 1
  elif ! tailscale serve set-config --all "$SNAPSHOT_FILE" >/dev/null 2>&1; then
    return 1
  fi
  if ! rm -f "$SNAPSHOT_FILE"; then
    return 1
  fi
  SNAPSHOT_FILE=""
  SNAPSHOT_READY=0
  return 0
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if (( OWNED )); then
    stop_server
  fi
  if (( SNAPSHOT_READY )); then
    if ! restore_snapshot; then
      echo "FALLITO: impossibile ripristinare la configurazione Tailscale; snapshot conservato in $SNAPSHOT_FILE" >&2
      status=1
    fi
  fi
  [[ -z "$AUTH_FILE" ]] || rm -f "$AUTH_FILE"
  [[ -z "$STATE_TMP" ]] || rm -f "$STATE_TMP"
  rm -f "$PID_FILE"
  rm -f "$STATE_FILE"
  exit "$status"
}
trap cleanup EXIT INT TERM

SNAPSHOT_FILE="$(mktemp "$STATE_DIR/superpi-tailscale-config.XXXXXX")"
chmod 600 "$SNAPSHOT_FILE"
if ! tailscale serve get-config --all >"$SNAPSHOT_FILE" 2>/dev/null; then
  echo "FALLITO: impossibile salvare la configurazione Tailscale Serve" >&2
  rm -f "$SNAPSHOT_FILE"
  SNAPSHOT_FILE=""
  exit 1
fi
chmod 600 "$SNAPSHOT_FILE"
SNAPSHOT_READY=1

AUTH_FILE="$(mktemp "$STATE_DIR/superpi-curl-auth.XXXXXX")"
chmod 600 "$AUTH_FILE"
printf 'user = "%s:%s"\n' "$SUPERPI_AUTH_USER" "$SUPERPI_AUTH_PASSWORD" >"$AUTH_FILE"

nohup node "$ROOT/src/server.mjs" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
OWNED=1
printf '%s\n' "$SERVER_PID" >"$PID_FILE"
chmod 600 "$PID_FILE"
echo "server avviato (pid $SERVER_PID), attendo che risponda su 127.0.0.1:$PORTA..."

pronto=0
for _ in $(seq 1 30); do
  if curl --config "$AUTH_FILE" -sf -m 2 "http://127.0.0.1:$PORTA/" >/dev/null 2>&1; then
    pronto=1
    break
  fi
  sleep 0.5
done
if (( ! pronto )); then
  echo "FALLITO: il server non risponde su 127.0.0.1:$PORTA — vedi $LOG_FILE" >&2
  exit 1
fi

if ! tailscale serve --bg --http "$PORTA" "$PORTA" >/dev/null 2>&1; then
  echo "FALLITO: configurazione Tailscale Serve non riuscita" >&2
  exit 1
fi

STATE_TMP="$(mktemp "$STATE_DIR/superpi-serve.state.XXXXXX")"
chmod 600 "$STATE_TMP"
printf 'version=1\npid=%s\nsnapshot=%s\n' "$SERVER_PID" "$SNAPSHOT_FILE" >"$STATE_TMP"
mv -f "$STATE_TMP" "$STATE_FILE"
STATE_TMP=""
chmod 600 "$STATE_FILE"

printf '\n'
printf 'pagina:        http://%s:%s/\n' "$HOSTNAME_INFO" "$PORTA"
printf 'log server:    %s\n' "$LOG_FILE"
printf 'ferma tutto:   npm run serve:stop\n'

rm -f "$AUTH_FILE"
AUTH_FILE=""
OWNED=0
trap - EXIT INT TERM
