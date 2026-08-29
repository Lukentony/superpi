// Test Fase 1 — spawner: prompt() di un compito reale → agent_settled entro il timeout.
// Verifica anche che l'identità sia davvero quella decisa dal chiamante
// (file di sessione con il sessionId scelto, nome -n passato al figlio).
import crypto from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  creaFiglio,
  avviaFiglio,
  promptFiglio,
  attendiIdle,
  fermaFiglio,
  diagnosticaTestoMancante,
} from "../src/spawner.mjs";
import { SESSION_DIR, CWD_DIR, TEST_PROVIDER, TEST_MODEL } from "./_paths.mjs";

// Regressione deterministica (nessun figlio, nessuna rete): un errore di
// provider (quota esaurita, rate limit, ...) e un vero bug del harness danno
// entrambi content vuoto sull'ultimo messaggio assistente — diagnosticaTestoMancante
// deve distinguerli. Fixture presa dalla risposta reale di opencode-go del
// 2026-08-20 (GoUsageLimitError, 429).
{
  const erroreProvider = [
    { role: "user", content: [{ type: "text", text: "ciao" }] },
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 3 days."}',
    },
  ];
  const diagnosi = diagnosticaTestoMancante(erroreProvider);
  assert.match(diagnosi, /errore del provider/, "un errore di provider non deve leggersi come bug generico");
  assert.match(diagnosi, /GoUsageLimitError/, "il motivo reale del provider deve comparire nella diagnosi");

  const nessunErrore = [
    { role: "user", content: [{ type: "text", text: "ciao" }] },
    { role: "assistant", content: [], stopReason: "end_turn" },
  ];
  assert.doesNotMatch(
    diagnosticaTestoMancante(nessunErrore),
    /errore del provider/,
    "senza stopReason error non va inventato un errore di provider",
  );
}

fs.mkdirSync(CWD_DIR, { recursive: true });

const sessionId = crypto.randomUUID();
const figlio = creaFiglio({
  cwd: CWD_DIR,
  nome: "fase1-spawner-01",
  sessionId,
  sessionDir: SESSION_DIR,
  provider: TEST_PROVIDER,
  model: TEST_MODEL,
  timeoutMs: 120000,
});

const events = [];
figlio.client.onEvent((e) => events.push(e.type));

let exitCode = 0;
try {
  await avviaFiglio(figlio);
  console.log(`[fase1] figlio avviato, sessionId=${sessionId}`);

  await promptFiglio(figlio, "Usa il tool bash per eseguire `date -u +%Y-%m-%d` e rispondi con l'output esatto.");
  await attendiIdle(figlio, 120000);

  const sessione = fs.readdirSync(SESSION_DIR).find((f) => f.includes(sessionId));
  console.log(`[fase1] file di sessione trovato: ${sessione ?? "MANCANTE"}`);
  if (!sessione) { console.error("FAIL: --session-id del chiamante non rispettato"); exitCode = 1; }

  const settled = events.includes("agent_settled");
  const last = await figlio.client.getLastAssistantText();
  console.log(`[fase1] agent_settled ricevuto: ${settled ? "SÌ" : "NO"}`);
  console.log(`[fase1] ultimo testo assistente: ${JSON.stringify(last)}`);
  if (!settled) { console.error("FAIL: agent_settled non ricevuto entro il timeout"); exitCode = 1; }
  if (!last) {
    const messaggi = await figlio.client.getMessages();
    console.error(`FAIL: ${diagnosticaTestoMancante(messaggi)}`);
    exitCode = 1;
  }

  console.log(`\nRISULTATO FASE 1: ${exitCode === 0 ? "PASS" : "FAIL"}`);
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(`stderr del figlio: ${figlio.client.getStderr()}`);
  console.error(`eventi ricevuti: ${events.join(", ")}`);
  exitCode = 2;
} finally {
  await fermaFiglio(figlio);
}
process.exit(exitCode);
