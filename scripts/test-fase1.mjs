// Test Fase 1 — spawner: prompt() di un compito reale → agent_settled entro il timeout.
// Verifica anche che l'identità sia davvero quella decisa dal chiamante
// (file di sessione con il sessionId scelto, nome -n passato al figlio).
import crypto from "node:crypto";
import fs from "node:fs";
import { creaFiglio, avviaFiglio, promptFiglio, attendiIdle, fermaFiglio } from "../src/spawner.mjs";
import { SESSION_DIR, CWD_DIR } from "./_paths.mjs";

fs.mkdirSync(CWD_DIR, { recursive: true });

const sessionId = crypto.randomUUID();
const figlio = creaFiglio({
  cwd: CWD_DIR,
  nome: "fase1-spawner-01",
  sessionId,
  sessionDir: SESSION_DIR,
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
  if (!last) { console.error("FAIL: nessun testo assistente"); exitCode = 1; }

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
