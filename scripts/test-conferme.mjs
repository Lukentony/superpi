// Test A-E — broker delle conferme via RPC: può superPi rispondere a una
// domanda di conferma che un'estensione del figlio (ctx.ui.confirm, SENZA
// timeout — stesso comportamento di hive-safety.ts) pone mentre il figlio
// lavora? Nessun codice della pagina web (Fase 9): solo verifica.
//
// Estensione usa e getta (creata dallo script se manca, .test-run/ è in
// .gitignore): intercetta la PRIMA chiamata al tool bash, chiede conferma e si
// comporta in modo riconoscibile: confermato → il comando prosegue; rifiutato
// → blocco con reason "RIFIUTATO".
//
// Nota sul canale di risposta: client.send() NON è usabile per le risposte UI
// — sovrascrive l'id del payload con un req_N autogenerato (rpc-client.js,
// `const fullCommand = { ...command, id }`) e il figlio non risponde mai alle
// extension_ui_response (rpc-mode.js le gestisce e ritorna senza output). La
// risposta si scrive direttamente sullo stdin del figlio, framing JSONL
// identico a serializeJsonLine (JSON + "\n"). Il test B lo dimostra dal vivo.
import crypto from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { creaFiglio, avviaFiglio, promptFiglio, fermaFiglio, conTimeout } from "../src/spawner.mjs";
import { creaScriba } from "../src/scriba.mjs";
import { SESSION_DIR, NOTE_DIR, TEST_RUN_DIR } from "./_paths.mjs";

const EST_DIR = join(TEST_RUN_DIR, "estensione-test");
const EST_FILE = join(EST_DIR, ".pi", "extensions", "test-conferma.ts");
fs.mkdirSync(join(EST_DIR, ".pi", "extensions"), { recursive: true });
// Riscritto a ogni run: è un fixture usa e getta, e la versione su disco
// potrebbe essere quella di un run precedente.
fs.writeFileSync(
    EST_FILE,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Estensione usa e getta (test-conferme.mjs): chiede conferma su OGNI chiamata
// al tool bash con ctx.ui.confirm SENZA timeout (stesso comportamento di
// hive-safety.ts sui comandi pericolosi). Confermato → il comando prosegue.
// Rifiutato → blocco con reason "RIFIUTATO".
//
// Nota: la prima stesura intercettava solo la PRIMA chiamata bash — verificato
// dal vivo che il modello, rifiutato, riprova con una nuova chiamata e la
// seconda passa senza conferma. Intercettare ogni chiamata (come fa
// hive-safety) rende il rifiuto non aggirabile con una riprova: è la proprietà
// che il test C verifica.
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const ok = await ctx.ui.confirm("test", "conferma?");
    if (!ok) {
      return { block: true, reason: "RIFIUTATO" };
    }
  });
}
`,
);

// Risposta a un dialog: scrittura diretta sullo stdin del figlio. client.send()
// sovrascrive l'id (req_N) e il figlio non risponde alle extension_ui_response
// — quindi il promise di send() scadrebbe a 30s senza effetto (test B).
function rispondi(figlio, id, payload) {
  const riga = JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n";
  figlio.client.process.stdin.write(riga);
}

// Risposta automatica ai dialog di conferma: saltaPrimo lascia il PRIMO dialog
// al test (che lo gestisce a mano), poi risponde a tutti gli altri con lo
// stesso payload. Serve perché con l'intercettazione su ogni chiamata bash il
// modello può generare dialog successivi (es. una verifica dopo il comando).
function autoRispondi(figlio, payload, { saltaPrimo = false } = {}) {
  let primo = true;
  let conteggio = 0;
  figlio.client.onEvent((e) => {
    if (e.type === "extension_ui_request" && e.method === "confirm") {
      if (saltaPrimo && primo) {
        primo = false;
        return;
      }
      conteggio++;
      rispondi(figlio, e.id, { ...payload });
    }
  });
  return { conteggio: () => conteggio };
}

// Attesa di una domanda confirm: risolve col primo extension_ui_request con
// method "confirm" (le altre richieste UI — notify/setStatus — si ignorano).
function attesaDialogo(figlio, timeoutMs = 60000, desc = "confirm") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`TIMEOUT ${timeoutMs}ms: nessuna extension_ui_request ${desc}`)),
      timeoutMs,
    );
    figlio.client.onEvent((e) => {
      if (e.type === "extension_ui_request" && e.method === "confirm") {
        clearTimeout(t);
        resolve(e);
      }
    });
  });
}

// Attesa dell'agent_settled con raccolta dei tool_execution_end. Da registrare
// PRIMA di inviare la risposta al dialog: agent_settled arriva una volta sola,
// una waitForIdle successiva resterebbe appesa fino al suo timeout interno
// (visto dal vivo: crash del primo run di questo script).
function attendiSettled(figlio, timeoutMs = 90000) {
  const toolEnd = [];
  const fine = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`TIMEOUT ${timeoutMs}ms: nessun agent_settled`)), timeoutMs);
    figlio.client.onEvent((e) => {
      if (e.type === "tool_execution_end") toolEnd.push(e);
      if (e.type === "agent_settled") {
        clearTimeout(t);
        resolve();
      }
    });
  });
  return { toolEnd, fine };
}

function figlioDiProva(nome) {
  return creaFiglio({
    cwd: EST_DIR,
    nome,
    sessionId: crypto.randomUUID(),
    sessionDir: SESSION_DIR,
    timeoutMs: 180000,
    // --approve: .test-run/ non ha decisioni di trust salvate e le modalità
    // non interattive senza trust "ask" NON caricano le estensioni di progetto
    // (docs/security.md) — senza questo flag il Test A fallirebbe subito.
    extraArgs: ["--approve"],
  });
}

const PROMPT = "Esegui il comando `echo CIAO` nel tool bash e rispondi con l'output esatto.";

let exitCode = 0;
let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) {
    nPass++;
    console.log(`  OK ${nome}`);
  } else {
    nFail++;
    console.error(`  FAIL ${nome} ${dettaglio}`);
  }
}
const esitoTool = (e) => JSON.stringify(e.result ?? "");
const haEseguitoCIAO = (righe) => righe.some((r) => esitoTool(r).includes("CIAO"));

// ============================================================ TEST A — la domanda arriva
console.log("[conferme] TEST A — la domanda di conferma arriva davvero");
let figlio = figlioDiProva("testA-conferma-01");
const scribaA = creaScriba(join(NOTE_DIR, `${figlio.sessionId}.jsonl`));
figlio.client.onEvent((e) => scribaA.onEvent(e));
let dialogA;
try {
  await avviaFiglio(figlio);
  const attesa = attesaDialogo(figlio);
  await promptFiglio(figlio, PROMPT);
  dialogA = await conTimeout(attesa, 60000, "attesa dialog conferma (test A)");
  console.log(`  dialog ricevuto: id=${dialogA.id} title=${JSON.stringify(dialogA.title)} message=${JSON.stringify(dialogA.message)}`);
  check("extension_ui_request con method confirm", dialogA.method === "confirm", JSON.stringify(dialogA));
  check("id presente", typeof dialogA.id === "string" && dialogA.id.length > 0, JSON.stringify(dialogA.id));
  check("nessun timeout nel dialog (campo assente)", dialogA.timeout === undefined, `timeout=${dialogA.timeout}`);
} catch (err) {
  console.error(`ECCEZIONE TEST A: ${err.message}`);
  exitCode = 2;
}

// ============================================================ TEST B — rispondere sì sblocca
try {
  console.log("[conferme] TEST B — rispondere sì sblocca davvero");
  if (!dialogA) throw new Error("dialog del test A non disponibile");
  // 1. strada indicata nel brief: client.send(...) — atteso: l'id viene
  //    sovrascritto con req_N, il figlio ignora la risposta, il promise scade.
  console.log("  B1: tentativo con client.send({...confirmed:true}) — atteso esito a sorpresa");
  let esitoSend = "ok";
  try {
    await conTimeout(figlio.client.send({ type: "extension_ui_response", id: dialogA.id, confirmed: true }), 35000, "client.send extension_ui_response");
  } catch (e) {
    esitoSend = `rifiutato/scaduto: ${e.message}`;
  }
  console.log(`  B1: client.send -> ${esitoSend}`);
  check("B1: send() non risolve il dialog (id sovrascritto da req_N)", esitoSend !== "ok", esitoSend);

  // 2. canale che funziona: scrittura diretta su stdin col framing JSONL.
  console.log("  B2: risposta con l'id giusto via stdin diretto");
  const { toolEnd: righeA, fine: fineA } = attendiSettled(figlio);
  autoRispondi(figlio, { confirmed: true }); // eventuali dialog successivi: sì
  rispondi(figlio, dialogA.id, { confirmed: true });
  await conTimeout(fineA, 90000, "attesa esecuzione comando + agent_settled (test B)");
  check("B2: il comando bash originale è stato eseguito (echo CIAO)", haEseguitoCIAO(righeA), JSON.stringify(righeA.map(esitoTool)));
  check("B2: agent_settled raggiunto senza restare bloccato", true);
} catch (err) {
  console.error(`ECCEZIONE TEST B: ${err.message}`);
  exitCode = exitCode || 2;
}
await fermaFiglio(figlio);

// ============================================================ TEST C — rispondere no blocca davvero
console.log("[conferme] TEST C — rispondere no blocca davvero, non a metà");
figlio = figlioDiProva("testC-conferma-01");
const scribaC = creaScriba(join(NOTE_DIR, `${figlio.sessionId}.jsonl`));
const toolEndC = [];
figlio.client.onEvent((e) => {
  scribaC.onEvent(e);
  if (e.type === "tool_execution_end") toolEndC.push(e);
});
try {
  await avviaFiglio(figlio);
  // Ogni chiamata bash genera un dialog: auto-risposta NO a tutti. Se il
  // modello riprova (visto dal vivo nel primo run: con l'estensione che
  // intercettava solo la prima chiamata, la riprova passava), ogni riprova
  // viene bloccata a sua volta: è la proprietà che il test C verifica.
  const { toolEnd: toolEndC, fine: fineC } = attendiSettled(figlio);
  const rifiuti = autoRispondi(figlio, { confirmed: false });
  await promptFiglio(figlio, PROMPT);
  await conTimeout(fineC, 120000, "attesa agent_settled (test C)");
  console.log(`  dialog rifiutati: ${rifiuti.conteggio()}`);
  check("C: il comando NON è stato eseguito MAI (nessun output CIAO)", !haEseguitoCIAO(toolEndC), JSON.stringify(toolEndC.map(esitoTool)));
  check(
    "C: blocco riconoscibile con reason RIFIUTATO (non un errore generico)",
    toolEndC.some((e) => e.isError && esitoTool(e).includes("RIFIUTATO")),
    JSON.stringify(toolEndC.map(esitoTool)),
  );
  check("C: il figlio arriva comunque a agent_settled", true);
} catch (err) {
  console.error(`ECCEZIONE TEST C: ${err.message}`);
  exitCode = exitCode || 2;
}
await fermaFiglio(figlio);

// ============================================================ TEST D — nessuno risponde
console.log("[conferme] TEST D — nessuno risponde per 30s, poi risposta tardiva");
figlio = figlioDiProva("testD-conferma-01");
const scribaD = creaScriba(join(NOTE_DIR, `${figlio.sessionId}.jsonl`));
const eventiD = [];
figlio.client.onEvent((e) => {
  scribaD.onEvent(e);
  eventiD.push(e.type);
});
try {
  await avviaFiglio(figlio);
  const attesa = attesaDialogo(figlio);
  await promptFiglio(figlio, PROMPT);
  const dialogD = await conTimeout(attesa, 60000, "attesa dialog conferma (test D)");
  console.log("  dialog ricevuto, attendo 30s SENZA rispondere...");
  await new Promise((r) => setTimeout(r, 30000));
  const vivo = figlio.client.process.exitCode === null;
  check("D: il figlio è ancora vivo dopo 30s (non è crashato)", vivo);
  check(
    "D: nessun tool eseguito e nessun evento nuovo nel frattempo",
    !eventiD.includes("tool_execution_end") && !eventiD.includes("agent_settled") && !eventiD.includes("agent_end"),
    eventiD.slice(-5).join(", "),
  );
  console.log("  risposta TARDIVA (confirmed:true) dopo 30s...");
  const { toolEnd: toolEndD, fine: fineD } = attendiSettled(figlio);
  autoRispondi(figlio, { confirmed: true }); // eventuali dialog successivi: sì
  rispondi(figlio, dialogD.id, { confirmed: true });
  await conTimeout(fineD, 90000, "attesa esecuzione + settled dopo risposta tardiva (test D)");
  check("D: la risposta tardiva funziona (comando eseguito)", haEseguitoCIAO(toolEndD), JSON.stringify(toolEndD.map(esitoTool)));
} catch (err) {
  console.error(`ECCEZIONE TEST D: ${err.message}`);
  exitCode = exitCode || 2;
}
await fermaFiglio(figlio);

// ============================================================ TEST E — id sbagliato
console.log("[conferme] TEST E — risposta con id sbagliato, poi id giusto");
figlio = figlioDiProva("testE-conferma-01");
const scribaE = creaScriba(join(NOTE_DIR, `${figlio.sessionId}.jsonl`));
const eventiE = [];
figlio.client.onEvent((e) => {
  scribaE.onEvent(e);
  eventiE.push(e.type);
});
try {
  await avviaFiglio(figlio);
  const attesa = attesaDialogo(figlio);
  await promptFiglio(figlio, PROMPT);
  const dialogE = await conTimeout(attesa, 60000, "attesa dialog conferma (test E)");
  console.log(`  dialog vero: id=${dialogE.id}`);
  console.log("  invio risposta con id inventato...");
  rispondi(figlio, "id-inventato-a-caso", { confirmed: true });
  await new Promise((r) => setTimeout(r, 4000));
  check("E: nessun errore né crash (la risposta con id errato è ignorata in silenzio)", figlio.client.process.exitCode === null);
  check("E: il dialog vero resta in sospeso (nessun tool eseguito)", !eventiE.includes("tool_execution_end"), eventiE.slice(-5).join(", "));
  console.log("  invio risposta con l'id GIUSTO...");
  const { toolEnd: toolEndE, fine: fineE } = attendiSettled(figlio);
  autoRispondi(figlio, { confirmed: true }); // eventuali dialog successivi: sì
  rispondi(figlio, dialogE.id, { confirmed: true });
  await conTimeout(fineE, 90000, "attesa esecuzione + settled dopo id giusto (test E)");
  check("E: con l'id giusto la risposta funziona (comando eseguito)", haEseguitoCIAO(toolEndE), JSON.stringify(toolEndE.map(esitoTool)));
} catch (err) {
  console.error(`ECCEZIONE TEST E: ${err.message}`);
  exitCode = exitCode || 2;
}
await fermaFiglio(figlio);

console.log(`\nRISULTATO TEST A-E: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
