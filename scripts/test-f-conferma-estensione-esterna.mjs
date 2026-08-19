// Test F — broker delle conferme con un'estensione pi VERA che intercetta
// comandi pericolosi, in un worktree usa e getta di un repository esterno
// (mai nella cartella di lavoro vera: i figli di prova non devono mai avere
// cwd dentro quel repository, e il worktree va rimosso a fine test — MAI
// committato, MAI pushato).
//
// Questo test è specifico all'ambiente dell'autore: EXTERNAL_REPO_DIR deve
// puntare a un repository git reale che carica un'estensione pi capace di
// intercettare `rm -rf` con un dialogo di conferma (nel setup originale:
// hive-safety.ts, non incluso in questo repository). Senza quella variabile
// d'ambiente il test si salta da solo — non fa parte di `npm run verify`.
// L'estensione intercetta `rm -rf` (blocco con conferma) e chiama
// ctx.ui.confirm SENZA timeout: il dialog arriva al client RPC, che risponde
// confermando → il comando viene eseguito per davvero.
import crypto from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { creaFiglio, avviaFiglio, promptFiglio, conTimeout, fermaFiglio } from "../src/spawner.mjs";
import { SESSION_DIR } from "./_paths.mjs";

const EXTERNAL_REPO = process.env.EXTERNAL_REPO_DIR;
if (!EXTERNAL_REPO) {
  console.log("EXTERNAL_REPO_DIR non impostato: test specifico all'ambiente dell'autore, saltato.");
  process.exit(0);
}
const WORKTREE = "/tmp/external-repo-worktree-test";
const BRANCH = "superpi-test-conferme";
const FILE_DI_PROVA = join(WORKTREE, ".throwaway-conferme-f.txt");

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

// --- setup: worktree temporaneo con file usa e getta ---
console.log("[testF] setup worktree temporaneo (mai la cartella di lavoro vera del repository esterno)");
try {
  execSync(`git -C ${EXTERNAL_REPO} worktree add ${WORKTREE} -b ${BRANCH}`, { stdio: "pipe" });
  fs.writeFileSync(FILE_DI_PROVA, "usa e getta — creato dal test F, può essere cancellato\n");
  console.log(`  worktree creato: ${WORKTREE} (branch ${BRANCH}), file di prova scritto`);
} catch (e) {
  console.error(`SETUP FALLITO: ${e.message}`);
  process.exit(3);
}

const figlio = creaFiglio({
  cwd: WORKTREE,
  nome: "testF-conferme-esterne-01",
  sessionId: crypto.randomUUID(),
  sessionDir: SESSION_DIR,
  timeoutMs: 180000,
  // --approve: il worktree in /tmp non ha decisioni di trust salvate.
  extraArgs: ["--approve"],
});
const scribaRighe = [];
figlio.client.onEvent((e) => {
  if (e.type === "tool_execution_end") scribaRighe.push(e);
});

try {
  await avviaFiglio(figlio);

  // rm -rf in RPC genera DUE dialog (scoperto dal vivo): il confirm
  // dell'estensione esterna (caricata dal worktree) e, subito dopo, il
  // select del permission-gate di @aliou/pi-guardrails (estensione globale,
  // "Dangerous command: recursive force delete" — Allow once/Allow for
  // session/Deny/Decline and stop; ctx.ui.custom in RPC ritorna undefined e
  // ripiega su select). Il test risponde a entrambi: confirm → true,
  // select → "Allow once". Il primo confirm viene catturato per le
  // asserzioni (è quello dell'estensione esterna).
  let dialogEstensioneEsterna = null;
  const fine = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("TIMEOUT 150s: nessun agent_settled dopo le conferme")), 150000);
    figlio.client.onEvent((e) => {
      if (e.type === "agent_settled") {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const dialogsVisti = [];
  figlio.client.onEvent((e) => {
    if (e.type !== "extension_ui_request") return;
    if (e.method === "confirm") {
      dialogsVisti.push(`confirm:${e.title}`);
      if (!dialogEstensioneEsterna) dialogEstensioneEsterna = e;
      figlio.client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: e.id, confirmed: true }) + "\n");
    } else if (e.method === "select") {
      dialogsVisti.push(`select:${e.title}`);
      figlio.client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: e.id, value: "Allow once" }) + "\n");
    }
  });
  await promptFiglio(figlio, "Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo né aggiungere altro: `rm -rf " + FILE_DI_PROVA + "`");
  await conTimeout(fine, 155000, "attesa agent_settled (test F)");

  console.log(`  dialog visti: ${dialogsVisti.join(" | ")}`);
  check(
    "F: dialog confirm dell'estensione esterna ricevuto (titolo e comando nel messaggio)",
    !!dialogEstensioneEsterna &&
      dialogEstensioneEsterna.title === "Comando pericoloso" &&
      String(dialogEstensioneEsterna.message ?? "").includes("rm -rf"),
    JSON.stringify(dialogEstensioneEsterna),
  );
  check(
    "F: anche il select del permission-gate (pi-guardrails) è stato gestito",
    dialogsVisti.some((d) => d.startsWith("select:")),
    dialogsVisti.join(" | "),
  );
  check("F: il file è stato cancellato per davvero (rm -rf eseguito)", !fs.existsSync(FILE_DI_PROVA));
} catch (err) {
  console.error(`ECCEZIONE TEST F: ${err.message}`);
  console.error(`  dialog visti finora: ${dialogsVisti.join(" | ") || "nessuno"}`);
  exitCode = exitCode || 2;
} finally {
  await fermaFiglio(figlio);
  // --- cleanup: worktree SEMPRE rimosso, branch locale cancellato ---
  try {
    execSync(`git -C ${EXTERNAL_REPO} worktree remove ${WORKTREE}`, { stdio: "pipe" });
    console.log("  worktree rimosso");
  } catch (e) {
    console.error(`  worktree remove fallito (provo --force): ${e.message.split("\n")[0]}`);
    execSync(`git -C ${EXTERNAL_REPO} worktree remove --force ${WORKTREE}`, { stdio: "pipe" });
    console.log("  worktree rimosso (--force)");
  }
  try {
    execSync(`git -C ${EXTERNAL_REPO} branch -D ${BRANCH}`, { stdio: "pipe" });
    console.log("  branch temporaneo cancellato");
  } catch {
    /* branch già sparito: ok */
  }
}
const lista = execSync(`git -C ${EXTERNAL_REPO} worktree list`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
check("F: nessun worktree residuo nel repository esterno", !lista.includes("external-repo-worktree-test"), lista.trim().split("\n").join(" | "));

console.log(`\nRISULTATO TEST F: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
