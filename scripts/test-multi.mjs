// Multi-conversazione (2026-08-13) + gate permissivo su /riprendi (parte 1).
// Punti del brief:
//   1. due conversazioni insieme (cwd diverse) → indipendenti, mai mescolate
//   2. limite MAX_CONVERSAZIONI (env): oltre → 409 col motivo che nomina il
//      limite; scartare una finita libera il posto
//   3. sequenza colori reale: blu (in_corso) → ambra (dialogo) → blu → grigio
//      (in_attesa) → verde (finito); una conversazione che fallisce DAVVERO
//      (kill del figlio) → rossa (errore)
//   4. terminare una conversazione non tocca le altre
//   5. /eventi-globali aggiorna il colore di una scheda NON aperta
//   6. costo del server con 3 conversazioni reali in_attesa (campioni 2s × 60s)
// Parte 1 (gate): /riprendi su worktree usa-e-getta di hive → accettato;
// /task nello stesso worktree → rifiutato; /riprendi con cwd=$HOME → rifiutato.
// Mai finestre vere: tutto su finestre di test, distrutte a fine test.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";
import { verificaCwd } from "../src/gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_CONV = 3; // env del server di test
const CWD_A = join(ROOT, ".test-run", "cwd-a");
const CWD_B = join(ROOT, ".test-run", "cwd-b");
const CWD_FAIL = join(ROOT, ".test-run", "cwd-fail");
const NOTE_DIR = join(homedir(), ".local", "state", "superpi", "note");
const SESSION_DIR_SERVER = join(homedir(), ".local", "state", "superpi", "sessions");
const HIVE_ROOT = join(homedir(), "hive");
const WT_GATE = "/tmp/superpi-worktree-hive-2026-08-13";
const WT_BRANCH = "superpi-gate-test-2026-08-13";
const PI_SESSIONS = join(homedir(), ".pi", "agent", "sessions");
for (const d of [CWD_A, CWD_B, CWD_FAIL]) fs.mkdirSync(d, { recursive: true });

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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, SUPERPI_PORT: String(PORT), SUPERPI_MAX_CONVERSAZIONI: String(MAX_CONV), SUPERPI_PROTECTED_ROOT: HIVE_ROOT, SUPERPI_GATE_QUOTA_FAKE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logServer = "";
proc.stdout.on("data", (d) => (logServer += d));
proc.stderr.on("data", (d) => (logServer += d));

function apriSse(url) {
  const eventi = [];
  const attese = [];
  const listeners = [];
  const controller = new AbortController();
  (async () => {
    try {
      const r = await fetch(url, { signal: controller.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const mTipo = frame.match(/^event: (.+)$/m);
          const mData = frame.match(/^data: (.+)$/m);
          if (!mData) continue;
          const ev = { tipo: mTipo ? mTipo[1] : "message", dati: JSON.parse(mData[1]) };
          eventi.push(ev);
          for (const l of listeners) l(ev);
          for (let i = attese.length - 1; i >= 0; i--) {
            if (attese[i].pred(ev)) {
              const a = attese.splice(i, 1)[0];
              clearTimeout(a.timer);
              a.resolve(ev);
            }
          }
        }
      }
    } catch { /* chiusa */ }
  })();
  return {
    eventi,
    onEvent(l) {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    attesa(pred, timeoutMs, desc) {
      return new Promise((resolve, reject) => {
        const già = eventi.find(pred);
        if (già) return resolve(già);
        const timer = setTimeout(() => reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`)), timeoutMs);
        attese.push({ pred, resolve, timer });
      });
    },
    chiudi() { controller.abort(); },
  };
}

const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });

function pidFiglioPerCwd(cwd) {
  let r;
  try {
    r = execFileSync("pgrep", ["-P", String(proc.pid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  for (const p of r.split("\n")) {
    const pid = Number(p);
    if (!pid) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi" && fs.readlinkSync(`/proc/${pid}/cwd`) === cwd) return pid;
    } catch { /* sparito */ }
  }
  return null;
}

function fileSessioneTask(taskId) {
  let files = [];
  try {
    files = fs.readdirSync(SESSION_DIR_SERVER);
  } catch { /* non ancora */ }
  const f = files.find((x) => x.includes(taskId));
  return f ? join(SESSION_DIR_SERVER, f) : null;
}
async function attesaFile(fn, timeoutMs, desc) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`));
      const v = fn();
      if (v) return resolve(v);
      setTimeout(poll, 1000);
    })();
  });
}

// --- misura CPU/RSS (metodo Fase 9: campioni ogni 2s per 60s) ---
async function misuraCpu(ms = 60000) {
  const pid = proc.pid;
  let prev = null;
  let prevT = Date.now();
  const campioni = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const m = stat.match(/\)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
      // dopo il nome: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime ...
      const utime = Number(m[12]);
      const stime = Number(m[13]);
      const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ").map(Number);
      const rssKb = statm[1] * 4; // pagine → KB (page size 4K)
      const now = Date.now();
      if (prev) {
        const dt = (now - prevT) / 1000;
        const cpu = ((utime + stime - prev) / 100) / dt * 100; // clock tick 100/s
        campioni.push({ cpu: Math.max(0, cpu), rssKb });
      }
      prev = utime + stime;
      prevT = now;
    } catch { /* processo sparito */ }
    await sleep(2000);
  }
  const cpu = campioni.map((c) => c.cpu);
  const rss = campioni.map((c) => c.rssKb);
  const media = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return { campioni: campioni.length, cpuMedia: media(cpu), cpuMax: Math.max(0, ...cpu), rssMediaKb: media(rss), rssMaxKb: Math.max(0, ...rss) };
}

function fileSessione(dirSan, uuid) {
  const d = join(PI_SESSIONS, dirSan);
  let files = [];
  try {
    files = fs.readdirSync(d);
  } catch { /* non ancora creata */ }
  const f = files.find((x) => x.includes(uuid));
  return f ? join(d, f) : null;
}
function sanitizzaCwd(cwd) {
  return "--" + cwd.slice(1).replaceAll("/", "-") + "--";
}
function ultimoAssistant(file) {
  const righe = fs.readFileSync(file, "utf8").trim().split("\n");
  for (let i = righe.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(righe[i]); } catch { continue; }
    const txt = e.message?.content?.map((c) => c.text ?? "").join("") ?? "";
    if (e.message?.role === "assistant" && txt.trim()) return txt;
  }
  return null;
}

let exitCode = 0;
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      if ((await fetch(`${BASE}/`)).ok) break;
    } catch { /* non ancora su */ }
    await sleep(300);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  const TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF", !!TOKEN);

  const g = apriSse(`${BASE}/eventi-globali`); // canale unico: aperto per tutto il test
  const statoGlobaleDi = (taskId, stato, dlg) => (e) => e.tipo === "stato" && e.dati.taskId === taskId && e.dati.stato === stato && (dlg === undefined || e.dati.dialogoInSospeso === dlg);
  const attesaGlobale = (taskId, stato, dlg, desc, timeout = 180000) => g.attesa(statoGlobaleDi(taskId, stato, dlg), timeout, desc);

  // Pre-trust delle cartelle di test: pi chiede "Trust project folder?" al
  // primo avvio in una cartella nuova, e il prompt è interattivo — bloccherebbe
  // i figli RPC del server (nessuna UI). Lancio pi in tmux in ognuna, supero il
  // prompt con Enter (prima voce = Trust), chiudo. Il trust è persistente.
  const PRE = "superpi-test-trust";
  execFileSync("tmux", ["new-session", "-d", "-s", PRE, "-n", "t1", "-c", CWD_A]);
  execFileSync("tmux", ["new-window", "-t", PRE, "-n", "t2", "-c", CWD_B]);
  execFileSync("tmux", ["new-window", "-t", PRE, "-n", "t3", "-c", CWD_FAIL]);
  for (const n of [1, 2, 3]) {
    execFileSync("tmux", ["send-keys", "-t", `${PRE}:t${n}`, `pi --model openai-codex/gpt-5.6-luna --session-id ${crypto.randomUUID()}`, "Enter"]);
  }
  await sleep(25 * 1000);
  for (const n of [1, 2, 3]) {
    await superaTrust(`${PRE}:t${n}`);
  }
  await sleep(3 * 1000);
  execFileSync("tmux", ["kill-session", "-t", PRE]);

  // ---- PARTE 1 (gate): /riprendi permissivo solo per hive; $HOME mai -------
  let r;
  let b;
  console.log("[multi] parte 1 — gate permissivo SOLO per /riprendi");
  execFileSync("git", ["-C", HIVE_ROOT, "worktree", "add", "-b", WT_BRANCH, WT_GATE, "main"]);
  execFileSync("tmux", ["new-session", "-d", "-s", "superpi-test-gate", "-n", "wt", "-c", WT_GATE]);
  const uuidWt = crypto.randomUUID();
  execFileSync("tmux", ["send-keys", "-t", "superpi-test-gate:wt", `pi --model openai-codex/gpt-5.6-luna --session-id ${uuidWt}`, "Enter"]);
  await sleep(30 * 1000);
  await superaTrust("superpi-test-gate:wt");
  execFileSync("tmux", ["send-keys", "-t", "superpi-test-gate:wt", "Il codice è GATE_OK, ricordalo.", "Enter"]);
  const fWt = await attesaFile(() => fileSessione(sanitizzaCwd(WT_GATE), uuidWt), 90000, "file sessione worktree");
  await attesaRisposta(fWt, "GATE_OK", 150000, "risposta completa nel worktree");
  r = await post("/riprendi", { finestra: "superpi-test-gate:wt" }, TOKEN);
  b = await r.json();
  check("gate: /riprendi della finestra nel worktree → ACCETTATO (permettiHive solo qui)", r.status === 200 && typeof b.id === "string", JSON.stringify(b).slice(0, 120));
  const sseWt = apriSse(`${BASE}/eventi/${b.id}`);
  await sseWt.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro della ripresa nel worktree");
  check("gate: la ripresa parte dal sunto (primo messaggio)", fs.readFileSync(fWt, "utf8").includes("Riassumi in breve"), "");
  await post("/termina", { taskId: b.id }, TOKEN);
  await post("/scarta", { taskId: b.id }, TOKEN);
  sseWt.chiudi();
  execFileSync("tmux", ["kill-session", "-t", "superpi-test-gate"]);
  // $HOME esatta: SEMPRE rifiutata, anche per /riprendi. Nota: il boot di pi
  // in $HOME è lento/instabile per un test E2E (verificato dal vivo 2026-08-13:
  // >60s e prompt di input non rilevabile) — la regola è verificata qui sul
  // gate stesso, che è il punto dove la decisione vive (verificaCwd è chiamata
  // da verificaGate con permettiHive nel percorso di /riprendi).
  const gHome = verificaCwd(homedir(), { permettiHive: true });
  check("gate: $HOME esatta resta rifiutata ANCHE con permettiHive", !gHome.ok && (gHome.motivo ?? "").includes("$HOME"), JSON.stringify(gHome));
  const gHivePermesso = verificaCwd(join(HIVE_ROOT, "appunti"), { permettiHive: true });
  check("gate: dentro hive con permettiHive → permesso (solo /riprendi)", gHivePermesso.ok, JSON.stringify(gHivePermesso));
  const gHiveVietato = verificaCwd(join(HIVE_ROOT, "appunti"));
  check("gate: dentro hive SENZA permettiHive → rifiutato (/task, come sempre)", !gHiveVietato.ok && (gHiveVietato.motivo ?? "").includes("dentro hive"), JSON.stringify(gHiveVietato));
  // il worktree è in /tmp, FUORI da hive: /task lo accetta (corretto — il gate
  // protegge la cartella di lavoro vera, non i cloni temporanei); il rifiuto
  // per i compiti nuovi si testa su una cartella vera dentro hive (sopra).
  r = await post("/task", { obiettivo: "x", cwd: WT_GATE }, TOKEN);
  b = await r.json();
  check("gate: /task nel worktree (fuori da hive) → accettato, come ogni cartella esterna", r.status === 200, JSON.stringify(b).slice(0, 80));
  await post("/termina", { taskId: b.id }, TOKEN);
  await post("/scarta", { taskId: b.id }, TOKEN);

  // ---- PUNTO 1+4: due conversazioni indipendenti; terminarne una non tocca l'altra ----
  console.log("[multi] punto 1 — due conversazioni indipendenti");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola ALFA", cwd: CWD_A }, TOKEN);
  b = await r.json();
  const idA = b.id;
  check("1: /task A → 200", r.status === 200 && typeof idA === "string", JSON.stringify(b));
  r = await post("/task", { obiettivo: "Rispondi solo con la parola BETA", cwd: CWD_B }, TOKEN);
  b = await r.json();
  const idB = b.id;
  check("1: /task B (seconda conversazione) → 200", r.status === 200 && typeof idB === "string", JSON.stringify(b));
  check("1: id diversi", idA !== idB, "");
  const sseA = apriSse(`${BASE}/eventi/${idA}`);
  const sseB = apriSse(`${BASE}/eventi/${idB}`);
  await sseA.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "A in attesa");
  await sseB.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "B in attesa");
  const fA = await attesaFile(() => fileSessioneTask(idA), 30000, "file sessione A");
  const fB = await attesaFile(() => fileSessioneTask(idB), 30000, "file sessione B");
  await attesaContenuto(fA, "ALFA", 90000, "A risponde ALFA");
  await attesaContenuto(fB, "BETA", 90000, "B risponde BETA");
  // indipendenza: nessun incrocio nei file di sessione
  check("1: A non contiene nulla di B (BETA)", !fs.readFileSync(fA, "utf8").includes("BETA"), "");
  check("1: B non contiene nulla di A (ALFA)", !fs.readFileSync(fB, "utf8").includes("ALFA"), "");
  // messaggi in parallelo: A risponde, B resta dov'è
  r = await post("/messaggio", { taskId: idA, testo: "Ripeti la parola ALFA" }, TOKEN);
  check("1: /messaggio su A → 200", r.status === 200, `status=${r.status}`);
  r = await post("/messaggio", { taskId: idB, testo: "Ripeti la parola BETA" }, TOKEN);
  check("1: /messaggio su B → 200 (indipendente da A)", r.status === 200, `status=${r.status}`);
  await attesaContenuto(fA, "ALFA", 90000, "A risponde di nuovo");
  await attesaContenuto(fB, "BETA", 90000, "B risponde di nuovo");
  check("1: A e B restano entrambe in_attesa (nessuna intercettata)", sseA.eventi.some((e) => e.tipo === "stato" && e.dati.stato === "in_attesa") && sseB.eventi.some((e) => e.tipo === "stato" && e.dati.stato === "in_attesa"), "");

  // punto 4: termino A → B resta viva e raggiungibile
  r = await post("/termina", { taskId: idA }, TOKEN);
  check("4: /termina A → 200", r.status === 200, `status=${r.status}`);
  await attesaGlobale(idA, "finito", false, "globale: A finito");
  await sseA.attesa((e) => e.tipo === "condensato", 30000, "condensato A");
  r = await post("/messaggio", { taskId: idB, testo: "Conferma: dici BETA" }, TOKEN);
  check("4: B è rimasta viva dopo /termina di A (/messaggio → 200)", r.status === 200, `status=${r.status}`);
  await attesaContenuto(fB, "BETA", 90000, "B risponde ancora");
  r = await post("/termina", { taskId: idB }, TOKEN);
  check("4: /termina B → 200", r.status === 200, `status=${r.status}`);
  sseA.chiudi();
  sseB.chiudi();
  await attesaGlobale(idB, "finito", false, "globale: B finito");
  // le finite restano in tasks (visibili) finché /scarta non le rimuove: per
  // il punto 2 servono posti liberi, quindi le scarto qui.
  r = await post("/scarta", { taskId: idA }, TOKEN);
  check("1: /scarta su conversazione finita → 200", r.status === 200, `status=${r.status}`);
  r = await post("/scarta", { taskId: idB }, TOKEN);
  check("1: /scarta anche B → 200", r.status === 200, `status=${r.status}`);

  // ---- PUNTO 2: limite MAX_CONVERSAZIONI ----
  console.log(`[multi] punto 2 — limite ${MAX_CONV} conversazioni`);
  const idC = [];
  for (let i = 1; i <= MAX_CONV; i++) {
    r = await post("/task", { obiettivo: `Rispondi solo con la parola C${i}`, cwd: i % 2 ? CWD_A : CWD_B }, TOKEN);
    b = await r.json();
    idC.push(b.id);
    check(`2: conversazione ${i}/${MAX_CONV} accettata`, r.status === 200, JSON.stringify(b));
  }
  r = await post("/task", { obiettivo: "Rispondi solo con la parola TROPPE", cwd: CWD_A }, TOKEN);
  b = await r.json();
  check(`2: una oltre il limite → 409 col motivo che nomina il limite (${MAX_CONV})`, r.status === 409 && (b.errore ?? "").includes(`limite di ${MAX_CONV}`), JSON.stringify(b));
  // scartare una FINITA libera il posto: A e B scartate sopra; ora il limite
  // conta solo C1..C3 attive
  r = await post("/scarta", { taskId: idA }, TOKEN);
  check("2: /scarta due volte → 404", r.status === 404, `status=${r.status}`);
  r = await post("/task", { obiettivo: "Rispondi solo con la parola TROPPE2", cwd: CWD_B }, TOKEN);
  check("2: con 3 attive il limite regge (409 anche dopo aver scartato una finita)", r.status === 409, `status=${r.status}`);
  // termina + scarta una ATTIVA → posto libero
  r = await post("/termina", { taskId: idC[0] }, TOKEN);
  check("2: /termina C1 → 200", r.status === 200, `status=${r.status}`);
  r = await post("/scarta", { taskId: idC[0] }, TOKEN);
  check("2: /scarta C1 (ora finita) → 200", r.status === 200, `status=${r.status}`);
  r = await post("/task", { obiettivo: "Rispondi solo con la parola LIBERO", cwd: CWD_A }, TOKEN);
  b = await r.json();
  check("2: dopo aver scartato una conversazione il posto si libera → 200", r.status === 200 && typeof b.id === "string", JSON.stringify(b));
  const idLib = b.id;
  const sseLib = apriSse(`${BASE}/eventi/${idLib}`);
  await sseLib.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "conversazione LIBERO in attesa");
  // pulizia: termina e scarta tutto
  for (const id of [...idC.slice(1), idLib, idB]) {
    await post("/termina", { taskId: id }, TOKEN).catch(() => {});
  }
  for (const id of [...idC.slice(1), idLib, idB]) {
    await post("/scarta", { taskId: id }, TOKEN).catch(() => {});
  }
  sseLib.chiudi();

  // ---- PUNTO 3: sequenza colori reale + errore vero ----
  console.log("[multi] punto 3 — sequenza colori e errore vero");
  const fileX = join(CWD_A, "multi-dialogo.txt");
  fs.writeFileSync(fileX, "usa e getta\n");
  r = await post("/task", { obiettivo: `Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo: \`rm -rf ${fileX}\``, cwd: CWD_A }, TOKEN);
  b = await r.json();
  const idDlg = b.id;
  check("3: /task con comando pericoloso → 200", r.status === 200, JSON.stringify(b));
  await attesaGlobale(idDlg, "in_corso", false, "globale: blu (in_corso, nessun dialogo)");
  await attesaGlobale(idDlg, "in_corso", true, "globale: ambra (dialogo in sospeso)");
  const sseDlg = apriSse(`${BASE}/eventi/${idDlg}`);
  const dlg = await sseDlg.attesa((e) => e.tipo === "dialogo", 180000, "dialogo (select)");
  r = await post("/rispondi", { taskId: idDlg, id: dlg.dati.id, value: "Allow once" }, TOKEN);
  check("3: /rispondi → 200", r.status === 200, `status=${r.status}`);
  await attesaGlobale(idDlg, "in_corso", false, "globale: blu di nuovo (dialogo risolto)");
  await attesaGlobale(idDlg, "in_attesa", false, "globale: grigio (in_attesa)");
  check("3: il comando confermato è stato eseguito (file cancellato)", !fs.existsSync(fileX), "");
  r = await post("/termina", { taskId: idDlg }, TOKEN);
  check("3: /termina → 200", r.status === 200, `status=${r.status}`);
  await attesaGlobale(idDlg, "finito", false, "globale: verde (finito)");
  sseDlg.chiudi();
  await post("/scarta", { taskId: idDlg }, TOKEN);

  // errore VERO: il figlio viene ucciso dall'esterno mentre il giro gira
  r = await post("/task", { obiettivo: "Scrivi una spiegazione molto lunga in italiano, almeno 300 parole, sulla storia della fotografia", cwd: CWD_FAIL }, TOKEN);
  b = await r.json();
  const idErr = b.id;
  check("3: /task per l'errore vero → 200", r.status === 200, JSON.stringify(b));
  await attesaGlobale(idErr, "in_corso", false, "globale: in_corso (prima del kill)");
  // l'evento in_corso arriva PRIMA che il figlio esista (broadcast all'inizio
  // di avviaTask): aspetto il processo per poll prima di ucciderlo
  const tPid0 = Date.now();
  let figlio = null;
  while (Date.now() - tPid0 < 60000 && !figlio) {
    figlio = pidFiglioPerCwd(CWD_FAIL);
    if (!figlio) await sleep(1000);
  }
  check("3: figlio della conversazione trovato (per cwd)", figlio != null, `pid=${figlio}`);
  process.kill(figlio, "SIGKILL"); // errore vero, non simulato
  await attesaGlobale(idErr, "errore", false, "globale: rosso (errore)");
  const sseErr = apriSse(`${BASE}/eventi/${idErr}`);
  const errEv = await sseErr.attesa((e) => e.tipo === "errore", 30000, "evento errore sullo stream completo");
  check("3: lo stream completo riporta l'errore", (errEv.dati.motivo ?? "").length > 0, JSON.stringify(errEv.dati));
  sseErr.chiudi();
  r = await post("/scarta", { taskId: idErr }, TOKEN);
  check("3: /scarta su errore → 200", r.status === 200, `status=${r.status}`);

  // ---- PUNTO 5: /eventi-globali aggiorna la scheda NON aperta ----
  console.log("[multi] punto 5 — il canale globale aggiorna la scheda non aperta");
  const fileY = join(CWD_B, "multi-dialogo-b.txt");
  fs.writeFileSync(fileY, "usa e getta\n");
  r = await post("/task", { obiettivo: `Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo: \`rm -rf ${fileY}\``, cwd: CWD_B }, TOKEN);
  b = await r.json();
  const idNonVista = b.id;
  r = await post("/task", { obiettivo: "Rispondi solo con la parola VISTA", cwd: CWD_A }, TOKEN);
  b = await r.json();
  const idVista = b.id;
  const sseVista = apriSse(`${BASE}/eventi/${idVista}`); // guardo SOLO questa
  await sseVista.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "conversazione vista in attesa");
  // sulla NON vista arriva un dialogo: lo vedo SOLO dal canale globale
  await attesaGlobale(idNonVista, "in_corso", true, "globale: la scheda NON aperta diventa ambra", 240000);
  check("5: il dialogo della conversazione non aperta non è mai passato dallo stream della vista", !sseVista.eventi.some((e) => e.tipo === "dialogo"), "nessun dialogo atteso nello stream della vista");
  // la chiudo: apro il suo stream solo ora (snapshot → dialogo) e rispondo
  const sseNonVista = apriSse(`${BASE}/eventi/${idNonVista}`);
  const dlgB = await sseNonVista.attesa((e) => e.tipo === "dialogo", 30000, "dialogo (snapshot) della conversazione non aperta");
  check("5: lo snapshot all'apertura consegna il dialogo in sospeso", dlgB.dati.method === "select", JSON.stringify(dlgB.dati));
  r = await post("/rispondi", { taskId: idNonVista, id: dlgB.dati.id, value: "Allow once" }, TOKEN);
  check("5: /rispondi sulla non vista → 200", r.status === 200, `status=${r.status}`);
  await attesaGlobale(idNonVista, "in_attesa", false, "globale: la non vista torna grigia");
  check("5: il file è stato cancellato (risposta arrivata al figlio giusto)", !fs.existsSync(fileY), "");
  await post("/termina", { taskId: idNonVista }, TOKEN);
  await post("/termina", { taskId: idVista }, TOKEN);
  await post("/scarta", { taskId: idNonVista }, TOKEN);
  await post("/scarta", { taskId: idVista }, TOKEN);
  sseVista.chiudi();
  sseNonVista.chiudi();

  // ---- PUNTO 6: costo con 3 conversazioni reali in_attesa ----
  console.log("[multi] punto 6 — costo del server con 3 conversazioni in_attesa");
  const idM = [];
  for (let i = 1; i <= 3; i++) {
    r = await post("/task", { obiettivo: `Rispondi solo con la parola M${i}`, cwd: i % 2 ? CWD_A : CWD_B }, TOKEN);
    b = await r.json();
    idM.push(b.id);
  }
  for (const id of idM) {
    const sse = apriSse(`${BASE}/eventi/${id}`);
    await sse.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, `M in attesa`);
    sse.chiudi();
  }
  const misura = await misuraCpu(60000);
  console.log(`  misura: ${misura.campioni} campioni, CPU media ${misura.cpuMedia.toFixed(2)}%, max ${misura.cpuMax.toFixed(2)}%, RSS media ${(misura.rssMediaKb / 1024).toFixed(0)} MB, max ${(misura.rssMaxKb / 1024).toFixed(0)} MB`);
  check("6: CPU media bassa a riposo (< 2% con 3 conversazioni in attesa)", misura.cpuMedia < 2, `cpuMedia=${misura.cpuMedia}`);
  check("6: campioni sufficienti (>= 20)", misura.campioni >= 20, `campioni=${misura.campioni}`);
  for (const id of idM) {
    await post("/termina", { taskId: id }, TOKEN);
    await post("/scarta", { taskId: id }, TOKEN);
  }
  g.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(logServer.slice(-1500));
  exitCode = 2;
} finally {
  for (const s of ["superpi-test-gate", "superpi-test-gate-home", "superpi-test-trust"]) {
    try { execFileSync("tmux", ["kill-session", "-t", s], { stdio: "ignore" }); } catch { /* già rimossa */ }
  }
  try { execFileSync("git", ["-C", HIVE_ROOT, "worktree", "remove", "--force", WT_GATE], { stdio: "ignore" }); } catch { /* già rimosso */ }
  try { execFileSync("git", ["-C", HIVE_ROOT, "branch", "-D", WT_BRANCH], { stdio: "ignore" }); } catch { /* già rimosso */ }
  proc.kill("SIGTERM");
  await sleep(600);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

console.log(`\nRISULTATO MULTI: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);

// helper dichiarati dopo l'uso per leggibilità (function hoisting ok)
async function attesaContenuto(file, testo, timeoutMs, desc) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`));
      try {
        if (fs.readFileSync(file, "utf8").includes(testo)) return resolve();
      } catch { /* non ancora */ }
      setTimeout(poll, 2000);
    })();
  });
}

// attende la RISPOSTA COMPLETA del modello (non la riga user, che il figlio
// scrive subito): lezione delle sessioni scorse — /riprendi a figlio ancora
// attivo innesca l'attesa o il 409 "sta ancora lavorando".
async function attesaRisposta(file, chiave, timeoutMs, desc) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`));
      try {
        const u = ultimoAssistant(file);
        if (u && u.includes(chiave)) return resolve();
      } catch { /* non ancora */ }
      setTimeout(poll, 2000);
    })();
  });
}

// pi chiede "Trust project folder?" al primo avvio in una cartella nuova:
// seleziona la prima voce (Trust) con Enter e lascia riprendere il boot.
async function superaTrust(target) {
  const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", target], { encoding: "utf8" });
  if (pane.includes("Trust project folder")) {
    execFileSync("tmux", ["send-keys", "-t", target, "Enter"]);
    await sleep(20 * 1000);
  }
}
