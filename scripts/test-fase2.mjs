// Test Fase 2 — scriba: compito con ≥3 tool call, poi kill -9 sul figlio a metà.
// Il file di note deve contenere esattamente le righe fino all'ultimo
// tool_execution_end ricevuto, non oltre e non meno.
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { creaFiglio, avviaFiglio, promptFiglio, conTimeout, fermaFiglio } from "../src/spawner.mjs";
import { creaScriba } from "../src/scriba.mjs";
import { SESSION_DIR, CWD_DIR, NOTE_DIR, TEST_PROVIDER, TEST_MODEL } from "./_paths.mjs";

fs.mkdirSync(CWD_DIR, { recursive: true });

const sessionId = crypto.randomUUID();
const notesFile = join(NOTE_DIR, `${sessionId}.jsonl`);

const figlio = creaFiglio({
  cwd: CWD_DIR,
  nome: "fase2-scriba-01",
  sessionId,
  sessionDir: SESSION_DIR,
  provider: TEST_PROVIDER,
  model: TEST_MODEL,
  timeoutMs: 120000,
});

const scriba = creaScriba(notesFile, (m) => console.log(m));
const eventi = [];
let toolEnd = 0;
let resolveTre;
const treChiusure = new Promise((r) => (resolveTre = r));
figlio.client.onEvent((e) => {
  eventi.push(e.type);
  scriba.onEvent(e);
  if (e.type === "tool_execution_end") {
    toolEnd++;
    if (toolEnd >= 3) resolveTre();
  }
});

let exitCode = 0;
try {
  await avviaFiglio(figlio);
  await promptFiglio(
    figlio,
    "Esegui ESATTAMENTE tre comandi bash, UNO PER CHIAMATA del tool, mai due nella stessa chiamata, in quest'ordine: 1) echo UNO 2) echo DUE 3) echo TRE. Poi rispondi con la sola parola FATTO.",
  );
  await conTimeout(treChiusure, 120000, "attesa di 3 tool_execution_end");
  console.log(`[fase2] ricevuti ${toolEnd} tool_execution_end — kill -9 sul processo figlio a metà compito`);

  // Il figlio pi è un processo figlio diretto di questo script (spawn di RpcClient).
  // Lo si trova per parentela + cmdline, e lo si uccide con process.kill: nessuna
  // shell nel mezzo, quindi nessun self-match del pattern (lezione: pkill -f col
  // sessionId nella cmdline uccide anche la propria shell sh -c).
  const out = execSync(`pgrep -P ${process.pid} -a`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const righePgrep = out ? out.split("\n") : [];
  // il figlio pi ha process.title = "pi" (cli.js fa process.title = APP_NAME):
  // la cmdline non è più "node dist/cli.js ...". Escludo la shell di pgrep stessa.
  const trovato = righePgrep.map((l) => l.split(/\s+/, 2)).find(([, cmd]) => !cmd.startsWith("/bin/sh") && !cmd.startsWith("pgrep"));
  if (!trovato) {
    console.error(`FAIL: figlio pi non trovato tra i processi figli (${JSON.stringify(righePgrep)})`);
    exitCode = 1;
  } else {
    const pidFiglio = parseInt(trovato[0], 10);
    console.log(`[fase2] kill -9 su pid ${pidFiglio}`);
    process.kill(pidFiglio, "SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
  }

  const testo = fs.readFileSync(notesFile, "utf8").trim();
  const righe = testo ? testo.split("\n") : [];
  console.log(`[fase2] righe nel file di note: ${righe.length} (tool_execution_end ricevuti: ${toolEnd})`);

  if (righe.length !== 3 || toolEnd !== 3) {
    console.error(`FAIL: attese 3 righe per 3 eventi, trovate ${righe.length} righe / ${toolEnd} eventi`);
    exitCode = 1;
  }

  let campiOk = true;
  for (const r of righe) {
    const o = JSON.parse(r);
    const ok = typeof o.ts === "string" && typeof o.toolName === "string" && "args" in o && "result" in o && typeof o.isError === "boolean";
    if (!ok) { console.error(`FAIL: campi mancanti in ${r}`); campiOk = false; }
  }
  console.log(`[fase2] campi {ts,toolName,args,result,isError} su ogni riga: ${campiOk ? "SÌ" : "NO"}`);
  if (!campiOk) exitCode = 1;

  const comandi = righe.map((r) => JSON.parse(r).args?.command ?? "");
  console.log(`[fase2] comandi nel grezzo: ${JSON.stringify(comandi)}`);
  const ordineOk = comandi.some((c) => c.includes("UNO")) && comandi.some((c) => c.includes("DUE")) && comandi.some((c) => c.includes("TRE"));
  if (!ordineOk) { console.error("FAIL: UNO/DUE/TRE non presenti nel grezzo nell'ordine del compito"); exitCode = 1; }

  console.log(`\nRISULTATO FASE 2: ${exitCode === 0 ? "PASS" : "FAIL"}`);
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(`stderr del figlio: ${figlio.client.getStderr()}`);
  console.error(`eventi ricevuti: ${eventi.join(", ")}`);
  exitCode = 2;
} finally {
  await fermaFiglio(figlio);
}
process.exit(exitCode);
