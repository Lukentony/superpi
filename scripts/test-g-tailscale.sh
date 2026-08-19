#!/usr/bin/env bash
# Test G — raggiungibilità via Tailscale serve (verifica superPi Fase 9).
#
# Richiede il permesso operatore concesso in anticipo
# (`sudo tailscale set --operator=<tuo-utente>`), altrimenti `tailscale serve`
# chiede sudo ad ogni chiamata. Esegue l'intera sequenza con un comando solo:
#   bash scripts/test-g-tailscale.sh
#
# Cosa fa: avvia un server HTTP di prova su 127.0.0.1:8437, lo espone con
# `tailscale serve --bg --http 8437 8437` (su alcuni tailnet HTTPS/443 non è
# disponibile senza una configurazione dedicata — verificalo dal vivo, non
# darlo per scontato), verifica la config con `tailscale serve status` e prova
# la raggiungibilità in tre modi separati — indirizzo numerico del tailnet,
# nome breve (hostname della macchina), nome MagicDNS esteso (quello che
# `serve status` di solito consiglia) — ripetendo l'indirizzo numerico 3 volte
# a distanza di secondi (un run reale ha mostrato un fallimento intermittente
# solo lì: ipotesi di self-access da confermare, non da assumere). Poi fa
# reset della config e spegne il server (trap). L'ultimo output dice l'esito
# di CIASCUN indirizzo.
set -euo pipefail

PORTA=8437
NOME_BREVE="$(hostname -s)"
NOME_ESTESO="${TAILSCALE_HOSTNAME:?imposta TAILSCALE_HOSTNAME al nome MagicDNS esteso della tua macchina}"
IP_TAILNET="$(tailscale ip -4 | head -1)"
NODE_SERVER_PID=""
OK_COUNT=0

pulizia() {
  # nessun residuo: serve config via, server di prova spento
  tailscale serve reset >/dev/null 2>&1 || true
  if [ -n "$NODE_SERVER_PID" ] && kill -0 "$NODE_SERVER_PID" 2>/dev/null; then
    kill "$NODE_SERVER_PID" 2>/dev/null || true
  fi
}
trap pulizia EXIT

echo "=== Test G: tailscale serve (senza sudo, operatore attivo) ==="
echo "IP tailnet: $IP_TAILNET"

# 1. il permesso operatore è efficace se serve config funziona SENZA sudo:
#    se fallisse qui, è un risultato da riportare, non un ostacolo da aggirare
tailscale serve status >/dev/null
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
tailscale serve --bg --http "$PORTA" "$PORTA"
echo "serve config applicata senza sudo: ok"
tailscale serve status

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
prova "nome breve" "http://$NOME_BREVE:$PORTA/"
prova "nome esteso (consigliato da serve status)" "http://$NOME_ESTESO:$PORTA/"

echo ""
if [ "$OK_COUNT" -gt 0 ]; then
  echo "=== Test G: PASS (raggiungibile: $OK_COUNT/5; dettagli sopra; serve config rimossa e server spento dal trap) ==="
  exit 0
else
  echo "=== Test G: FAIL (nessuno dei 3 indirizzi ha risposto; dettagli sopra) ==="
  exit 1
fi
