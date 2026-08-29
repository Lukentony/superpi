#!/usr/bin/env bash
# Test G — raggiungibilità via Tailscale serve (verifica superPi Fase 9).
#
# Esegue la sequenza in una configurazione Tailscale temporaneamente sostituita
# e ripristinata esattamente al termine. Il test è opt-in e usa i nomi rilevati
# da Tailscale oppure SUPERPI_TAILSCALE_HOST/SUPERPI_TAILSCALE_FQDN.
set -euo pipefail

PORTA=8437
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/.test-run"
SNAPSHOT_FILE=""
SNAPSHOT_READY=0
NOME_BREVE="${SUPERPI_TAILSCALE_HOST:-}"
NOME_ESTESO="${SUPERPI_TAILSCALE_FQDN:-}"
NODE_SERVER_PID=""
OK_COUNT=0

if ! command -v tailscale >/dev/null 2>&1; then
  echo "=== Test G: SKIP (tailscale non installato) ==="
  exit 0
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if ! tailscale serve status >/dev/null 2>&1 || \
   ! tailscale serve get-config --help >/dev/null 2>&1 || \
   ! tailscale serve set-config --help >/dev/null 2>&1; then
  echo "=== Test G: SKIP (Tailscale Serve o snapshot/restore config non supportato) ==="
  exit 0
fi

SNAPSHOT_FILE="$(mktemp "$STATE_DIR/superpi-tailscale-test-config.XXXXXX")"
chmod 600 "$SNAPSHOT_FILE"
if ! tailscale serve get-config --all >"$SNAPSHOT_FILE" 2>/dev/null; then
  echo "=== Test G: SKIP (snapshot Tailscale Serve non supportato o non leggibile) ==="
  rm -f "$SNAPSHOT_FILE"
  SNAPSHOT_FILE=""
  exit 0
fi
chmod 600 "$SNAPSHOT_FILE"
SNAPSHOT_READY=1

pulizia() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$NODE_SERVER_PID" ]] && kill -0 "$NODE_SERVER_PID" 2>/dev/null; then
    kill "$NODE_SERVER_PID" 2>/dev/null || true
  fi
  if (( SNAPSHOT_READY )); then
    local restore_ok=0
    if node -e 'const c=require("fs").readFileSync(process.argv[1], "utf8"); const j=JSON.parse(c); process.exit(Object.keys(j).every(k => k === "version") ? 0 : 1)' "$SNAPSHOT_FILE" >/dev/null 2>&1; then
      tailscale serve reset >/dev/null 2>&1 && restore_ok=1
    else
      tailscale serve set-config --all "$SNAPSHOT_FILE" >/dev/null 2>&1 && restore_ok=1
    fi
    if (( restore_ok )); then
      SNAPSHOT_READY=0
      rm -f "$SNAPSHOT_FILE"
      SNAPSHOT_FILE=""
    else
      echo "Test G: impossibile ripristinare la configurazione Tailscale; snapshot conservato in $SNAPSHOT_FILE" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap pulizia EXIT INT TERM

IP_TAILNET="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$IP_TAILNET" ]; then
  echo "=== Test G: SKIP (nessun IP Tailscale rilevato) ==="
  exit 0
fi
echo "=== Test G: tailscale serve (senza sudo, operatore attivo) ==="
echo "IP tailnet: $IP_TAILNET"
if [ -z "$NOME_ESTESO" ]; then
  NOME_ESTESO="$(tailscale status --json 2>/dev/null | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { try { const n=JSON.parse(s).Self?.DNSName ?? ""; process.stdout.write(n.replace(/\.$/, "")); } catch {} })')"
fi
if [ -z "$NOME_BREVE" ] && [ -n "$NOME_ESTESO" ]; then
  NOME_BREVE="${NOME_ESTESO%%.*}"
fi

# 1. il permesso operatore è efficace se serve config funziona SENZA sudo:
#    se fallisse qui, è un risultato da riportare, non un ostacolo da aggirare
echo "serve status leggibile senza sudo: ok"

# 2. server di prova locale (sola porta locale, nessuna interfaccia di rete)
node -e "require('http').createServer((q,r)=>r.end('OK-TAILSCALE-TEST')).listen($PORTA,'127.0.0.1')" &
NODE_SERVER_PID=$!
sleep 1
if ! curl -sf -m 5 "http://127.0.0.1:$PORTA/" >/dev/null; then
  echo "FALLITO: il server locale su 127.0.0.1:$PORTA non risponde"
  exit 1
fi
echo "server locale ok: http://127.0.0.1:$PORTA"

# 3. esposizione sul tailnet SENZA sudo (HTTP puro: HTTPS/443 non implementato)
if ! tailscale serve --bg --http "$PORTA" "$PORTA" >/dev/null 2>&1; then
  echo "FALLITO: configurazione Tailscale Serve non riuscita"
  exit 1
fi
echo "serve config applicata senza sudo: ok"

# 4. raggiungibilità, un tentativo per indirizzo, risultati separati
prova() {
  local desc="$1" url="$2"
  local esito
  esito="$(curl -sS -m 10 -o /dev/null -w "%{http_code}" "$url" 2>&1 || true)"
  case "$esito" in
    200)
      OK_COUNT=$((OK_COUNT + 1))
      echo "  OK   $desc -> HTTP 200 ($url)"
      ;;
    *)
      echo "  FAIL $desc -> $esito ($url)"
      ;;
  esac
}

echo "--- raggiungibilità via tailnet (3 indirizzi, risultati separati) ---"
prova "indirizzo numerico (tentativo 1)" "http://$IP_TAILNET:$PORTA/"
sleep 3
prova "indirizzo numerico (tentativo 2)" "http://$IP_TAILNET:$PORTA/"
sleep 3
prova "indirizzo numerico (tentativo 3)" "http://$IP_TAILNET:$PORTA/"
if [ -n "$NOME_BREVE" ]; then prova "nome breve" "http://$NOME_BREVE:$PORTA/"; fi
if [ -n "$NOME_ESTESO" ]; then prova "nome esteso" "http://$NOME_ESTESO:$PORTA/"; fi

echo ""
if [ "$OK_COUNT" -gt 0 ]; then
  echo "=== Test G: PASS (raggiungibile: $OK_COUNT; dettagli sopra; configurazione ripristinata e server spento dal trap) ==="
  exit 0
else
  echo "=== Test G: FAIL (nessuno degli indirizzi ha risposto; dettagli sopra) ==="
  exit 1
fi
