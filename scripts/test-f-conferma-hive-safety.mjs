// Test F — confirmation broker with a real project safety extension in a
// disposable worktree. It is an opt-in system test because the extension and
// source repository are supplied by the operator, never by this repository.
//
// hive-safety.ts intercetta `rm -rf` (BLOCCO_CON_CONFERMA) e chiama
// ctx.ui.confirm SENZA timeout: il dialog arriva al client RPC, che risponde
// confermando → il comando viene eseguito per davvero.
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { creaFiglio, avviaFiglio, promptFiglio, conTimeout, fermaFiglio } from "../src/spawner.mjs";
import { SESSION_DIR, TEST_PROVIDER, TEST_MODEL } from "./_paths.mjs";

const HIVE = process.env.SUPERPI_TEST_HIVE?.trim();
if (!HIVE) {
  console.log("[testF] SKIP: imposta SUPERPI_TEST_HIVE con un repository che contiene l'estensione di sicurezza");
  process.exit(0);
}
const WORKTREE = join(tmpdir(), `superpi-hive-worktree-${process.pid}-${crypto.randomUUID()}`);
const BRANCH = `superpi-test-conferme-${process.pid}`;
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
console.log("[testF] setup worktree temporaneo (il repository sorgente resta intatto)");
try {
  execFileSync("git", ["-C", HIVE, "worktree", "add", WORKTREE, "-b", BRANCH], { stdio: "pipe" });
  fs.writeFileSync(FILE_DI_PROVA, "usa e getta — creato dal test F, può essere cancellato\n");
  console.log(`  worktree creato: ${WORKTREE} (branch ${BRANCH}), file di prova scritto`);
} catch (e) {
  console.error(`SETUP FALLITO: ${e.message}`);
  process.exit(3);
}

const figlio = creaFiglio({
  cwd: WORKTREE,
  nome: "testF-hive-safety-01",
  sessionId: crypto.randomUUID(),
  sessionDir: SESSION_DIR,
  provider: TEST_PROVIDER,
  model: TEST_MODEL,
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

  // rm -rf in RPC genera DUE dialog (scoperto dal vivo): il confirm di
  // hive-safety (estensione di progetto del worktree) e, subito dopo, il
  // select del permission-gate di @aliou/pi-guardrails (estensione globale,
  // "Dangerous command: recursive force delete" — Allow once/Allow for
  // session/Deny/Decline and stop; ctx.ui.custom in RPC ritorna undefined e
  // ripiega su select). Il test risponde a entrambi: confirm → true,
  // select → "Allow once". Il primo confirm viene catturato per le
  // asserzioni (è quello di hive-safety).
  let dialogHiveSafety = null;
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
      if (!dialogHiveSafety) dialogHiveSafety = e;
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
    "F: dialog confirm di hive-safety ricevuto (titolo e comando nel messaggio)",
    !!dialogHiveSafety &&
      dialogHiveSafety.title === "Comando pericoloso" &&
      String(dialogHiveSafety.message ?? "").includes("rm -rf"),
    JSON.stringify(dialogHiveSafety),
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
    execFileSync("git", ["-C", HIVE, "worktree", "remove", WORKTREE], { stdio: "pipe" });
    console.log("  worktree rimosso");
  } catch (e) {
    console.error(`  worktree remove fallito (provo --force): ${e.message.split("\n")[0]}`);
    execFileSync("git", ["-C", HIVE, "worktree", "remove", "--force", WORKTREE], { stdio: "pipe" });
    console.log("  worktree rimosso (--force)");
  }
  try {
    execFileSync("git", ["-C", HIVE, "branch", "-D", BRANCH], { stdio: "pipe" });
    console.log("  branch temporaneo cancellato");
  } catch {
    /* branch già sparito: ok */
  }
}
const lista = execFileSync("git", ["-C", HIVE, "worktree", "list"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
check("F: nessun worktree residuo", !lista.includes(WORKTREE), lista.trim().split("\n").join(" | "));

console.log(`\nRISULTATO TEST F: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
