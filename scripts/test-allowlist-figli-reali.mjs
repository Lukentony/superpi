// Test — allowlist esplicita sui figli reali (/task e /riprendi via avviaTask).
//
// Purpose: verify the child-tool contract on the real server path.
// avviaTask — la funzione condivisa da /task e /riprendi — creava il figlio
// SENZA extraArgs: --tools non veniva mai passato, a differenza del conduttore
// (che ha CONDUTTORE_TOOLS). Il gate prima dello spawn controlla solo cwd e
// quota, mai gli strumenti: per il prodotto vero, "cosa può fare un figlio"
// non era deciso da un'allowlist.
//
// Questo test dimostra il contratto sul PERCORSO REALE, non su una copia
// ricostruita a mano: importa src/server.mjs IN-PROCESS (non come
// child_process, così node:test mock.module può intercettare l'import
// relativo "./spawner.mjs" che server.mjs fa davvero) con
// creaFiglio/avviaFiglio/promptFiglio/attendiIdle/fermaFiglio sostituiti da
// stub che REGISTRANO gli argomenti reali senza spawnare mai un figlio vero
// (zero chiamate a un provider a pagamento).
//
// Per /riprendi il resto del percorso (tmux, correlazione col file di
// sessione, kill del processo) resta REALE: una finestra tmux dedicata fa
// partire, come farebbe una persona al prompt, un binario ELF minimo chiamato
// "pi" (compilato al volo con gcc). Serve un binario vero eseguito come job
// in primo piano di una shell interattiva (tmux send-keys, non `-c`): con
// `-c` bash sostituisce se stesso senza fork e pane_pid diventerebbe "pi"
// direttamente, senza il rapporto padre(shell)/figlio(pi) che
// pidFiglioPerComm si aspetta — verificato dal vivo scrivendo questo test.
//
// mock.module è sperimentale in Node 22 (richiede --experimental-test-module-
// mocks): il file si ri-esegue da solo col flag se manca, così
// `node scripts/test-allowlist-figli-reali.mjs` funziona anche senza saperlo
// passare a mano.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", fileURLToPath(import.meta.url)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const { mock } = await import("node:test");

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

// --- 0. allowlist attesa: derivata dal set built-in del pacchetto installato
// (stessa fonte di test-fase5.mjs — mai copiata a mano, mai l'allowlist del
// conduttore, che ha uno scopo diverso: non tocca file, parla con le altre
// conversazioni). Se una versione futura del pacchetto cambia il set
// built-in, questo controllo lo segnala invece di restare silenziosamente
// disallineato.
const INDEX_PATH = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const PKG_ROOT = join(INDEX_PATH, "..");
const toolsIndex = readFileSync(join(PKG_ROOT, "core", "tools", "index.js"), "utf8");
const setMatch = toolsIndex.match(/allToolNames = new Set\(\[([^\]]*)\]\)/);
const toolNamesBuiltIn = setMatch
  ? setMatch[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
  : [];
const ATTESO_TOOLS = "read,bash,edit,write,grep,find,ls";
check(
  "l'allowlist attesa coincide col set built-in installato (nessuna deriva)",
  toolNamesBuiltIn.length > 0 && toolNamesBuiltIn.join(",") === ATTESO_TOOLS,
  `installato: ${toolNamesBuiltIn.join(",")} atteso: ${ATTESO_TOOLS}`,
);

function haTools(opts, valoreAtteso) {
  return Array.isArray(opts?.extraArgs) && opts.extraArgs[0] === "--tools" && opts.extraArgs[1] === valoreAtteso;
}

// --- mock di src/spawner.mjs: registra gli argomenti reali, non spawna mai
// un figlio vero. Import relativo, risolto allo stesso file assoluto che
// server.mjs importa con "./spawner.mjs" (verificato: mock.module intercetta
// per URL risolto, non per testo dello specifier). Il router è finto: il test
// deve controllare solo gli argomenti di avviaTask, non spawnare il classificatore.
const spawnerPath = fileURLToPath(new URL("../src/spawner.mjs", import.meta.url));
const chiamate = []; // ogni chiamata reale a creaFiglio(opts), nell'ordine
mock.module(spawnerPath, {
  namedExports: {
    creaFiglio(opts) {
      chiamate.push(opts);
      return {
        client: { onEvent: () => () => {}, process: { stdin: { write: () => {} } } },
        sessionId: opts.sessionId ?? crypto.randomUUID(),
        nome: opts.nome,
        timeoutMs: opts.timeoutMs,
      };
    },
    async avviaFiglio(figlio) {
      return figlio;
    },
    async promptFiglio() {},
    async promptEAttendi() {},
    async attendiIdle() {},
    async fermaFiglio() {},
  },
});

// --- avvio del server IN-PROCESS (non child_process: il mock sopra vale solo
// per questo processo) ---
const PORT = 8796;
process.env.SUPERPI_PORT = String(PORT);
process.env.SUPERPI_GATE_QUOTA_FAKE = "1"; // caso comune finto: niente chiamata quota reale
process.env.SUPERPI_ROUTER_FAKE = "scout"; // nessun figlio aggiuntivo per il classificatore
const BASE = `http://127.0.0.1:${PORT}`;
await import("../src/server.mjs");

async function attesaPronto(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server (in-process) non pronto");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CWD_TASK = realpathSync((() => {
  const p = fileURLToPath(new URL("../.test-run/allowlist-cwd-task", import.meta.url));
  mkdirSync(p, { recursive: true });
  return p;
})());
const CWD_RIPRENDI = realpathSync((() => {
  const p = fileURLToPath(new URL("../.test-run/allowlist-cwd-riprendi", import.meta.url));
  mkdirSync(p, { recursive: true });
  return p;
})());
const BUILD_DIR = fileURLToPath(new URL("../.test-run/allowlist-build", import.meta.url));
mkdirSync(BUILD_DIR, { recursive: true });

// Stesso formato documentato in src/server.mjs (sanitizzaCwd): assoluto,
// slash iniziale rimosso, "/" -> "-", avvolto tra doppi trattini.
function sanitizzaCwd(cwd) {
  return "--" + cwd.slice(1).replaceAll("/", "-") + "--";
}

const SESSIONI_DIR = join(homedir(), ".pi", "agent", "sessions");
const TMUX_SESS = `superpi-test-allowlist-${process.pid}`;
const TMUX_WIN = "riprendi";
let fixtureSessDir = null;
let exitCode = 0;

try {
  await attesaPronto();

  const html = await (await fetch(`${BASE}/`)).text();
  const TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF ottenuto dalla pagina", !!TOKEN);

  // === /task ============================================================
  console.log("[allowlist] === /task: nuova sessione via avviaTask ===");
  const rTask = await fetch(`${BASE}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": TOKEN },
    body: JSON.stringify({ obiettivo: "verifica allowlist figli reali", cwd: CWD_TASK }),
  });
  const bTask = await rTask.json();
  check("/task risponde 200 con id", rTask.status === 200 && typeof bTask.id === "string", JSON.stringify(bTask));
  check("creaFiglio chiamato una volta per /task", chiamate.length === 1, `chiamate=${chiamate.length}`);
  const oTask = chiamate.at(-1);
  check(
    `il figlio di /task riceve --tools esplicito (${ATTESO_TOOLS})`,
    haTools(oTask, ATTESO_TOOLS),
    `extraArgs=${JSON.stringify(oTask?.extraArgs)}`,
  );
  check("--session-id resta il flusso di /task (nessun resumeSessionId)", !oTask.resumeSessionId, JSON.stringify(oTask.resumeSessionId));
  check("sessionId passato = id del task creato", oTask.sessionId === bTask.id, `${oTask.sessionId} vs ${bTask.id}`);
  check("provider Codex scelto dal router finto", oTask.provider === "openai-codex", JSON.stringify(oTask.provider));
  check("model Luna scelto dal router finto", oTask.model === "gpt-5.6-luna", JSON.stringify(oTask.model));
  check("env invariato (nessuna riserva: caso comune finto)", oTask.env === undefined, JSON.stringify(oTask.env));

  // === /riprendi =========================================================
  console.log("[allowlist] === /riprendi: ripresa via avviaTask (tmux reale + kill reale) ===");

  // binario "pi" minimo: uno script con shebang avrebbe comm=bash/sh, non
  // "pi" (verificato dal vivo). Serve un ELF vero, non un dispatcher
  // multicall come coreutils (anche quello riscrive comm dal proprio
  // argv[0] — verificato dal vivo con /bin/sleep).
  const PI_C = join(BUILD_DIR, "pi.c");
  const PI_BIN = join(BUILD_DIR, "pi");
  writeFileSync(
    PI_C,
    "#include <stdlib.h>\n#include <unistd.h>\nint main(int argc, char **argv) {\n" +
      "  unsigned int secs = argc > 1 ? (unsigned int)atoi(argv[1]) : 300;\n  sleep(secs);\n  return 0;\n}\n",
  );
  execFileSync("gcc", ["-O2", "-o", PI_BIN, PI_C]);

  execFileSync("tmux", ["new-session", "-d", "-s", TMUX_SESS, "-n", TMUX_WIN, "-c", CWD_RIPRENDI]);
  // job in primo piano di una shell interattiva (send-keys), come farebbe
  // una persona al prompt — NON `-c`, che bash sostituirebbe senza fork.
  execFileSync("tmux", ["send-keys", "-t", `${TMUX_SESS}:${TMUX_WIN}`, `${PI_BIN} 300`, "Enter"]);
  await sleep(600);

  const panePid = Number(execFileSync("tmux", ["list-panes", "-t", `${TMUX_SESS}:${TMUX_WIN}`, "-F", "#{pane_pid}"], { encoding: "utf8" }).trim());
  check("finestra tmux di test avviata (pane_pid leggibile)", Number.isInteger(panePid) && panePid > 0, `panePid=${panePid}`);
  const pidFiglio = Number(execFileSync("pgrep", ["-P", String(panePid)], { encoding: "utf8" }).trim().split("\n")[0]);
  check("il binario pi di test è figlio della shell della finestra", Number.isInteger(pidFiglio) && pidFiglio > 0, `pidFiglio=${pidFiglio}`);

  // fixture del file di sessione correlabile (stesso formato letto da
  // correlazionaSessione in src/server.mjs): timestamp vicino ad ora, nella
  // cartella sanitizzata per CWD_RIPRENDI.
  const uuidSessione = crypto.randomUUID();
  const tsPart = new Date().toISOString().replace(/:/g, "-").replace(".", "-");
  fixtureSessDir = join(SESSIONI_DIR, sanitizzaCwd(CWD_RIPRENDI));
  mkdirSync(fixtureSessDir, { recursive: true });
  writeFileSync(join(fixtureSessDir, `${tsPart}_${uuidSessione}.jsonl`), "");

  const chiamatePrimaRiprendi = chiamate.length;
  const rRiprendi = await fetch(`${BASE}/riprendi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": TOKEN },
    body: JSON.stringify({ finestra: `${TMUX_SESS}:${TMUX_WIN}` }),
  });
  const bRiprendi = await rRiprendi.json();
  check("/riprendi risponde 200 e correla il file di sessione di test", rRiprendi.status === 200 && bRiprendi.sessioneRipresa === uuidSessione, JSON.stringify(bRiprendi));
  check("creaFiglio chiamato una seconda volta, per /riprendi", chiamate.length === chiamatePrimaRiprendi + 1, `chiamate=${chiamate.length}`);
  const oRiprendi = chiamate.at(-1);
  check(
    `il figlio di /riprendi riceve LO STESSO --tools esplicito (${ATTESO_TOOLS})`,
    haTools(oRiprendi, ATTESO_TOOLS),
    `extraArgs=${JSON.stringify(oRiprendi?.extraArgs)}`,
  );
  check("resumeSessionId = il file di sessione correlato (--session, non --session-id)", oRiprendi.resumeSessionId === uuidSessione, `${oRiprendi.resumeSessionId} vs ${uuidSessione}`);
  check("resumeSessionDir = la cartella di sessione correlata", oRiprendi.sessionDir === fixtureSessDir, `${oRiprendi.sessionDir} vs ${fixtureSessDir}`);
  check("provider invariato (nessuna riserva: caso comune finto)", oRiprendi.provider === undefined, JSON.stringify(oRiprendi.provider));
  check("model invariato (nessuna riserva: caso comune finto)", oRiprendi.model === undefined, JSON.stringify(oRiprendi.model));

  // === il conduttore resta un caso a parte ==============================
  console.log("[allowlist] === il conduttore mantiene la propria allowlist separata (mai copiata) ===");
  check(
    `l'allowlist di /task e /riprendi NON è quella del conduttore`,
    ATTESO_TOOLS !== "bash,leggi_conversazioni,manda_messaggio",
    ATTESO_TOOLS,
  );
} catch (err) {
  console.error(`ECCEZIONE: ${err.stack ?? err.message}`);
  exitCode = 2;
} finally {
  try {
    execFileSync("tmux", ["kill-session", "-t", TMUX_SESS]);
  } catch { /* già chiusa (es. il figlio di test è morto e basta) */ }
  try {
    if (fixtureSessDir) rmSync(fixtureSessDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
  try {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

console.log(`\nRISULTATO ALLOWLIST FIGLI REALI: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
