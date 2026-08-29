#!/usr/bin/env bash
# superPi — ferma solo il server registrato da scripts/serve.sh e ripristina
# la configurazione Tailscale salvata da quella stessa istanza.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/.test-run"
STATE_FILE="$STATE_DIR/superpi-serve.state"
PID_FILE="$STATE_DIR/superpi-server.pid"

if [[ ! -e "$STATE_FILE" ]]; then
  echo "nessun server superPi registrato"
  exit 0
fi
if [[ -L "$STATE_FILE" || ! -f "$STATE_FILE" ]]; then
  echo "FALLITO: stato superPi non valido" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$STATE_FILE" 2>/dev/null || true)" != "600" ]]; then
  echo "FALLITO: stato superPi non protetto (atteso modo 0600)" >&2
  exit 1
fi

version=""
server_pid=""
snapshot_file=""
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  case "$key" in
    version) version="$value" ;;
    pid) server_pid="$value" ;;
    snapshot) snapshot_file="$value" ;;
    *)
      echo "FALLITO: stato superPi non valido" >&2
      exit 1
      ;;
  esac
done <"$STATE_FILE"

if [[ "$version" != "1" || ! "$server_pid" =~ ^[1-9][0-9]*$ || -z "$snapshot_file" ]]; then
  echo "FALLITO: stato superPi non valido" >&2
  exit 1
fi
if [[ -L "$PID_FILE" || ! -f "$PID_FILE" || "$(stat -c '%a' "$PID_FILE" 2>/dev/null || true)" != "600" ]]; then
  echo "FALLITO: PID superPi non valido" >&2
  exit 1
fi
if [[ "$(cat "$PID_FILE")" != "$server_pid" ]]; then
  echo "FALLITO: PID superPi non corrisponde allo stato" >&2
  exit 1
fi
if [[ "$snapshot_file" != "$STATE_DIR"/superpi-tailscale-config.* || -L "$snapshot_file" || ! -f "$snapshot_file" ]]; then
  echo "FALLITO: snapshot Tailscale non valido" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$snapshot_file" 2>/dev/null || true)" != "600" ]]; then
  echo "FALLITO: snapshot Tailscale non protetto (atteso modo 0600)" >&2
  exit 1
fi
if [[ "$(stat -c '%u' "$snapshot_file" 2>/dev/null || true)" != "$(id -u)" ]]; then
  echo "FALLITO: snapshot Tailscale non appartiene all'utente corrente" >&2
  exit 1
fi
if ! command -v tailscale >/dev/null 2>&1; then
  echo "FALLITO: il comando tailscale non è disponibile; stato conservato" >&2
  exit 1
fi

if kill -0 "$server_pid" 2>/dev/null; then
  cmdline="$(tr '\0' ' ' <"/proc/$server_pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmdline" != *"$ROOT/src/server.mjs"* ]]; then
    echo "FALLITO: il PID registrato non appartiene al server superPi; stato conservato" >&2
    exit 1
  fi
  kill "$server_pid" 2>/dev/null || {
    echo "FALLITO: impossibile fermare il server superPi; stato conservato" >&2
    exit 1
  }
  for _ in $(seq 1 10); do
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$server_pid" 2>/dev/null; then
    kill -KILL "$server_pid" 2>/dev/null || {
      echo "FALLITO: impossibile fermare il server superPi; stato conservato" >&2
      exit 1
    }
  fi
fi

restore_ok=0
if node -e 'const c=require("fs").readFileSync(process.argv[1], "utf8"); const j=JSON.parse(c); process.exit(Object.keys(j).every(k => k === "version") ? 0 : 1)' "$snapshot_file" >/dev/null 2>&1; then
  tailscale serve reset >/dev/null 2>&1 && restore_ok=1
else
  tailscale serve set-config --all "$snapshot_file" >/dev/null 2>&1 && restore_ok=1
fi
if (( ! restore_ok )); then
  echo "FALLITO: impossibile ripristinare la configurazione Tailscale; stato conservato" >&2
  exit 1
fi

rm -f "$snapshot_file" "$PID_FILE" "$STATE_FILE"
echo "server superPi fermato e configurazione Tailscale ripristinata"
