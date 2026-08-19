#!/usr/bin/env bash
# superPi — avvia il server web e lo espone sul tailnet (Fase 9, passo 9.6).
#
#   npm run serve
#
# Il server ascolta SOLO su 127.0.0.1 (sicurezza, guida §8); l'esposizione è
# via `tailscale serve --bg --http`, che richiede il permesso operatore
# (niente sudo). La pagina è raggiungibile SOLO dal nome MagicDNS esteso della
# tua macchina — verificato dal vivo che IP nudo e nome breve non funzionano
# (routing per-host di `tailscale serve` e /etc/hosts):
#   http://<TAILSCALE_HOSTNAME>:<porta>/
# Imposta TAILSCALE_HOSTNAME al nome MagicDNS esteso della tua macchina
# (es. tuo-pc.tuo-tailnet.ts.net) prima di lanciare questo script.
#
# Stato a fine script: server attivo in background + config serve attiva.
# Per fermare: kill $(cat "$PID_FILE") && tailscale serve reset
set -euo pipefail

if [ -z "${TAILSCALE_HOSTNAME:-}" ]; then
  echo "TAILSCALE_HOSTNAME non impostato — es. export TAILSCALE_HOSTNAME=tuo-pc.tuo-tailnet.ts.net" >&2
  exit 1
fi

PORTA="${SUPERPI_PORT:-8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.test-run/superpi-server.pid"
LOG_FILE="$ROOT/.test-run/superpi-server.log"
URL="http://$TAILSCALE_HOSTNAME:$PORTA/"

mkdir -p "$ROOT/.test-run"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "server già avviato (pid $(cat "$PID_FILE")) — fermalo prima: kill \$(cat $PID_FILE)"
  exit 1
fi

nohup node "$ROOT/src/server.mjs" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
echo "server avviato (pid $(cat "$PID_FILE")), attendo che risponda su 127.0.0.1:$PORTA..."

for _ in $(seq 1 30); do
  if curl -sf -m 2 "http://127.0.0.1:$PORTA/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! curl -sf -m 2 "http://127.0.0.1:$PORTA/" >/dev/null 2>&1; then
  echo "FALLITO: il server non risponde su 127.0.0.1:$PORTA — vedi $LOG_FILE"
  exit 1
fi

tailscale serve --bg --http "$PORTA" "$PORTA"
echo ""
echo "pagina:        $URL"
echo "log server:    $LOG_FILE"
echo "ferma tutto:   kill \$(cat $PID_FILE) && tailscale serve reset"
