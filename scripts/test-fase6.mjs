// Test Fase 6 — condensatore: un tool call fallisce deliberatamente nel figlio
// di prova (comando inesistente). Il condensato deve riportare l'errore in
// bloccato_su, non nasconderlo né minimizzarlo, e non deve fingere che il
// comando fallito sia in fatto.
import crypto from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { creaFiglio, avviaFiglio, promptFiglio, attendiIdle, fermaFiglio } from "../src/spawner.mjs";
import { creaScriba } from "../src/scriba.mjs";
import { condensa } from "../src/condensatore.mjs";
import { SESSION_DIR, CWD_DIR, NOTE_DIR, TEST_PROVIDER, TEST_MODEL } from "./_paths.mjs";

fs.mkdirSync(CWD_DIR, { recursive: true });

const sessionId = crypto.randomUUID();
const notesFile = join(NOTE_DIR, `${sessionId}.jsonl`);
const OBIETTIVO = "Test condensatore: esegui un comando inesistente e osserva come il condensato riporta l'errore.";

const figlio = creaFiglio({
  cwd: CWD_DIR,
  nome: "fase6-condensatore-01",
  sessionId,
  sessionDir: SESSION_DIR,
  provider: TEST_PROVIDER,
  model: TEST_MODEL,
  timeoutMs: 120000,
});
const scriba = creaScriba(notesFile);
figlio.client.onEvent((e) => scriba.onEvent(e));

let exitCode = 0;
try {
  await avviaFiglio(figlio);
  await promptFiglio(
    figlio,
    "Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo né correggerlo: `comando_inesistente_superpi_test`. Poi rispondi con la parola FATTO.",
  );
  await attendiIdle(figlio, 120000);

  const condensato = condensa({ noteFile: notesFile, obiettivo: OBIETTIVO, settled: true });
  console.log(`[fase6] condensato: ${JSON.stringify(condensato, null, 2)}`);

  const bloccato = condensato.bloccato_su;
  console.log(`[fase6] bloccato_su: ${JSON.stringify(bloccato)}`);
  if (!bloccato) {
    console.error("FAIL: bloccato_su è null — l'errore è sparito");
    exitCode = 1;
  } else if (!/non trovato|not found|no such file|command not found|not a command/i.test(bloccato)) {
    console.error(`FAIL: bloccato_su non contiene l'errore atteso: ${bloccato}`);
    exitCode = 1;
  }

  if (condensato.fatto.some((f) => JSON.stringify(f.args ?? "").includes("comando_inesistente"))) {
    console.error("FAIL: il comando fallito compare in fatto — non è stato completato");
    exitCode = 1;
  }
  console.log(`[fase6] comando fallito assente da fatto: ${exitCode === 0 ? "SÌ" : "NO"}`);

  const eta = Date.now() - Date.parse(condensato.eta_ultimo_evento);
  console.log(`[fase6] eta_ultimo_evento: ${condensato.eta_ultimo_evento} (${(eta / 1000).toFixed(0)}s fa)`);
  if (!(eta >= 0 && eta < 300000)) {
    console.error("FAIL: eta_ultimo_evento non valido o troppo vecchio");
    exitCode = 1;
  }

  console.log(`\nRISULTATO FASE 6: ${exitCode === 0 ? "PASS" : "FAIL"}`);
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(`stderr del figlio: ${figlio.client.getStderr()}`);
  exitCode = 2;
} finally {
  await fermaFiglio(figlio);
}
process.exit(exitCode);
