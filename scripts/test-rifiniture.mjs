// Rifiniture 2026-08-13 (punti 1-3 del brief):
//   1.  alla ripresa il PRIMO messaggio è sempre il sunto; l'obiettivo della
//       richiesta va in coda come messaggio SUCCESSIVO (meccanismo codaMessaggi)
//   1b. stesso, ma con obiettivo presente → ordine [sunto, obiettivo] nel file
//   2a. /riprendi mentre la finestra genera: attesa (non kill immediato), poi
//       ripresa normale quando si ferma — e il resume scrive davvero
//   2b. /riprendi con finestra che lavora oltre il limite (server con
//       SUPERPI_RIPRESA_ATTESA_MAX_MS=6000): 409 chiaro, processo NON ucciso;
//       a generazione finita la ripresa procede subito
//   3.  menù separato: struttura pagina (nav/viste, il cambio vista non tocca
//       lo stream) + E2E: task in_attesa → GET /sessioni → task ancora attivo
//
// Lezioni del primo run (2026-08-13, documentate qui perché costano care):
//   - la correlazione finestra↔file è TEMPORALE e AMBIGUA se due finestre
//     condividono la cwd: t1 e t2 nella stessa cartella → la ripresa di t2 ha
//     aperto il file di t1 (distanza 28s vs 30s). OGNI finestra di test ha ora
//     la sua cwd.
//   - il file di sessione NON esiste al boot: pi lo crea al primo messaggio.
//     Prima di /riprendi ogni finestra fa uno scambio e attende la RISPOSTA
//     (ultimoAssistant contiene la parola chiave) — non basta la riga user.
//   - l'ordine [sunto, obiettivo] era invertito nel server (codaIniziale
//     pushatta prima del primoMessaggio): fix in server.mjs.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT_A = 8793; // attesa max 120s (caso normale)
const PORT_B = 8792; // attesa max 6s (case limite)
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const CWD = join(ROOT, ".test-run", "cwd");
const SCRATCH_BASE = "/tmp/superpi-verifica-rif-2026-08-13"; // ogni finestra ha la SUA sottocartella
const SESS = "superpi-test-rif";
const PI_SESSIONS = join(homedir(), ".pi", "agent", "sessions");
fs.mkdirSync(CWD, { recursive: true });

function sanitizzaCwd(cwd) {
  return "--" + cwd.slice(1).replaceAll("/", "-") + "--";
}

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

function avviaServer(porta, attesaMax) {
  const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, SUPERPI_PORT: String(porta), SUPERPI_RIPRESA_ATTESA_MAX_MS: String(attesaMax) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logServer = "";
  proc.stdout.on("data", (d) => (logServer += d));
  proc.stderr.on("data", (d) => (logServer += d));
  return { proc, logServer };
}

async function attesaServer(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      if ((await fetch(`${base}/`)).ok) break;
    } catch { /* non ancora su */ }
    await sleep(300);
  }
  const html = await (await fetch(`${base}/`)).text();
  const token = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  if (!token) throw new Error(`token CSRF non trovato su ${base}`);
  return token;
}

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

const post = (base, path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });

function pidPiFinestra(target) {
  const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{session_name}:#{window_name}|#{pane_pid}|#{pane_current_command}"], { encoding: "utf8" });
  const riga = out.split("\n").find((l) => l.startsWith(target + "|"));
  if (!riga) return null;
  const panePid = Number(riga.split("|")[1]);
  if (!panePid) return null;
  try {
    if (fs.readFileSync(`/proc/${panePid}/comm`, "utf8").trim() === "pi") return panePid;
  } catch { /* sparito */ }
  let figli;
  try {
    figli = execFileSync("pgrep", ["-P", String(panePid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  for (const p of figli.split("\n")) {
    const pid = Number(p);
    if (!pid) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi") return pid;
    } catch { /* sparito */ }
  }
  return null;
}

function hashPane(target) {
  return execFileSync("tmux", ["capture-pane", "-p", "-t", target], { encoding: "utf8" });
}
async function paneVivo(target) {
  const a = hashPane(target);
  await sleep(1500);
  return hashPane(target) !== a;
}
async function attesaPaneVivo(target, timeoutMs, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await paneVivo(target)) return true;
    await sleep(2000);
  }
  throw new Error(`TIMEOUT ${timeoutMs}ms: pane mai vivo (${desc})`);
}
async function attesaPaneFermo(target, timeoutMs, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const a = hashPane(target);
    await sleep(1500);
    const b = hashPane(target);
    await sleep(1500);
    const c = hashPane(target);
    if (a === b && b === c) return true;
    await sleep(2000);
  }
  throw new Error(`TIMEOUT ${timeoutMs}ms: pane mai fermo (${desc})`);
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
function righeUser(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.message?.role === "user")
    .map((e) => (e.message.content ?? []).map((c) => c.text ?? "").join(""));
}

// attende che pi abbia completato il boot nella finestra (riga di status con
// il modello) PRIMA di inviare input che altrimenti si perderebbero; il trust
// prompt, se compare, viene superato con Enter.
async function attendiBootPronto(target, timeoutMs, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", target], { encoding: "utf8" });
    if (pane.includes("Trust project folder")) {
      execFileSync("tmux", ["send-keys", "-t", target, "Enter"]);
      await sleep(3000);
    }
    const righe = pane.split("\n").map((l) => l.trim()).filter(Boolean);
    const ult = righe[righe.length - 1] ?? "";
    if (ult.includes("deepseek") || ult.includes("→") || /^>/.test(ult)) {
      // la status bar appare PRIMA che il prompt di input sia attivo: un input
      // mandato subito si perde (verificato 2026-08-17). Margine di sicurezza.
      await sleep(8000);
      return true;
    }
    await sleep(2000);
  }
  throw new Error(`TIMEOUT ${timeoutMs}ms: boot non completo (${desc})`);
}
// attende che la RISPOSTA del modello contenga la parola chiave (non basta la
// riga user: il figlio scrive il messaggio subito, la risposta arriva dopo)
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

let exitCode = 0;
let serverA = null;
let serverB = null;
try {
  // --- setup: due server di test e 4 finestre tmux di TEST (cwd separata) ---
  serverA = avviaServer(PORT_A, 120000);
  serverB = avviaServer(PORT_B, 6000);
  const TOKEN_A = await attesaServer(BASE_A);
  const TOKEN_B = await attesaServer(BASE_B);
  console.log("server A (attesa 120s) e B (attesa 6s) su");
  // le cartelle DEVONO esistere prima di creare le finestre: tmux -c con dir
  // inesistente cade su $HOME (verificato: i file di sessione finivano in
  // --home-luca--), e lì la correlazione e il gate sarebbero sbagliati.
  for (const n of [1, 2, 3, 4]) {
    fs.mkdirSync(join(SCRATCH_BASE, `t${n}`), { recursive: true });
  }
  execFileSync("tmux", ["new-session", "-d", "-s", SESS, "-n", "t1", "-c", join(SCRATCH_BASE, "t1")]);
  execFileSync("tmux", ["new-window", "-t", SESS, "-n", "t2", "-c", join(SCRATCH_BASE, "t2")]);
  execFileSync("tmux", ["new-window", "-t", SESS, "-n", "t3", "-c", join(SCRATCH_BASE, "t3")]);
  execFileSync("tmux", ["new-window", "-t", SESS, "-n", "t4", "-c", join(SCRATCH_BASE, "t4")]);
  const u = { 1: crypto.randomUUID(), 2: crypto.randomUUID(), 3: crypto.randomUUID(), 4: crypto.randomUUID() };
  for (const n of [1, 2, 3, 4]) {
    execFileSync("tmux", ["send-keys", "-t", `${SESS}:t${n}`, `pi --session-id ${u[n]}`, "Enter"]);
  }
  // boot: NON uno sleep fisso — il send-keys dello scambio può perdersi se la
  // finestra non è pronta (verificato 2026-08-17: boot parallelo oltre 30s
  // sotto carico -> il testo cadeva nella shell e il file non nasceva).
  for (const n of [1, 2, 3, 4]) await attendiBootPronto(`${SESS}:t${n}`, 90000, `boot t${n}`);
  const dirSan = { 1: sanitizzaCwd(join(SCRATCH_BASE, "t1")), 2: sanitizzaCwd(join(SCRATCH_BASE, "t2")), 3: sanitizzaCwd(join(SCRATCH_BASE, "t3")), 4: sanitizzaCwd(join(SCRATCH_BASE, "t4")) };
  // scambio iniziale in OGNI finestra: fa esistere il file e dà contenuto alla sessione
  execFileSync("tmux", ["send-keys", "-t", `${SESS}:t1`, "Esegui il comando bash: echo passoSunto1, poi rispondi esattamente SUNTO_1", "Enter"]);
  execFileSync("tmux", ["send-keys", "-t", `${SESS}:t2`, "Il codice è QUEUE_77, ricordalo.", "Enter"]);
  execFileSync("tmux", ["send-keys", "-t", `${SESS}:t3`, "Rispondi solo con la parola PRONTO3", "Enter"]);
  execFileSync("tmux", ["send-keys", "-t", `${SESS}:t4`, "Rispondi solo con la parola PRONTO4", "Enter"]);
  const f = {};
  for (const n of [1, 2, 3, 4]) {
    f[n] = await attesaFile(() => fileSessione(dirSan[n], u[n]), 90000, `file sessione t${n}`);
  }
  await attesaRisposta(f[1], "SUNTO_1", 120000, "t1 risposta (SUNTO_1)");
  await attesaRisposta(f[2], "QUEUE_77", 120000, "t2 risposta (QUEUE_77)");
  await attesaRisposta(f[3], "PRONTO3", 120000, "t3 risposta (PRONTO3)");
  await attesaRisposta(f[4], "PRONTO4", 120000, "t4 risposta (PRONTO4)");
  console.log("scambi iniziali completati: 4 file di sessione presenti, risposte ricevute");

  // ---- PUNTO 1: sunto alla ripresa (finestra ferma, nessun obiettivo) ----
  console.log("[rifiniture] punto 1 — sunto alla ripresa");
  let r = await post(BASE_A, "/riprendi", { finestra: `${SESS}:t1` }, TOKEN_A);
  let b = await r.json();
  check("1: /riprendi senza obiettivo → 200", r.status === 200 && typeof b.id === "string", JSON.stringify(b));
  const sse1 = apriSse(`${BASE_A}/eventi/${b.id}`);
  await sse1.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro 1 (sunto) chiuso");
  const txt1 = fs.readFileSync(f[1], "utf8");
  check("1: il PRIMO messaggio della chat ripresa è la richiesta di sunto", /Riassumi in breve/.test(txt1), "");
  check("1: il vecchio messaggio generico NON compare più", !txt1.includes("da dove era rimasta"), "");
  check("1: nessun incrocio con altre finestre (niente QUEUE_77 nel file di t1)", !txt1.includes("QUEUE_77"), "");
  const sunto1 = ultimoAssistant(f[1]) ?? "";
  console.log(`  sunto: ${JSON.stringify(sunto1.slice(0, 160))}`);
  check("1: il sunto è coerente con i passi fatti prima della ripresa", /SUNTO_1|passoSunto/.test(sunto1), sunto1.slice(0, 120));
  await post(BASE_A, "/termina", { taskId: b.id }, TOKEN_A);
  sse1.chiudi();

  // ---- PUNTO 1b: con obiettivo → ordine [sunto, obiettivo] ----
  console.log("[rifiniture] punto 1b — obiettivo in coda dopo il sunto");
  r = await post(BASE_A, "/riprendi", { finestra: `${SESS}:t2`, obiettivo: "Rispondi solo con la parola READY" }, TOKEN_A);
  b = await r.json();
  check("1b: /riprendi con obiettivo → 200", r.status === 200 && typeof b.id === "string", JSON.stringify(b));
  const sse2 = apriSse(`${BASE_A}/eventi/${b.id}`);
  await sse2.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro 1 (sunto)");
  await sse2.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro 2 (obiettivo in coda)");
  const ultimi2 = righeUser(f[2]).slice(-2);
  check("1b: ordine dei messaggi: prima il sunto, poi l'obiettivo", (ultimi2[0] ?? "").includes("Riassumi") && (ultimi2[1] ?? "").includes("Rispondi solo con la parola READY"), JSON.stringify(ultimi2));
  let rispReady = null;
  for (let i = 0; i < 90; i++) {
    try {
      rispReady = ultimoAssistant(f[2]);
      if (rispReady && rispReady.includes("READY")) break;
    } catch { /* non ancora */ }
    await sleep(2000);
  }
  console.log(`  risposta al giro in coda: ${JSON.stringify((rispReady ?? "").slice(0, 100))}`);
  check("1b: l'obiettivo in coda è stato processato (READY)", (rispReady ?? "").includes("READY"), rispReady ?? "");
  await post(BASE_A, "/termina", { taskId: b.id }, TOKEN_A);
  sse2.chiudi();

  // ---- PUNTO 2a: /riprendi mentre la finestra genera → attesa, poi ripresa ----
  console.log("[rifiniture] punto 2a — attesa quando la finestra sta lavorando");
  execFileSync("tmux", ["send-keys", "-t", `${SESS}:t3`, "Scrivi una spiegazione in italiano di circa 300 parole sul ciclo dell'acqua, completa e dettagliata", "Enter"]);
  await attesaPaneVivo(`${SESS}:t3`, 30000, "t3 sta generando");
  console.log("  t3 sta generando: /riprendi ora (attesa max 120s)");
  const tInizio = Date.now();
  r = await post(BASE_A, "/riprendi", { finestra: `${SESS}:t3` }, TOKEN_A);
  const tempo2a = Date.now() - tInizio;
  b = await r.json();
  check("2a: /riprendi durante la generazione → 200 (dopo l'attesa)", r.status === 200, JSON.stringify(b).slice(0, 120));
  check("2a: ha ASPETTATO la fine della generazione (risposta > 5s, non kill immediato)", tempo2a > 5000, `tempo=${tempo2a}ms`);
  const sse3 = apriSse(`${BASE_A}/eventi/${b.id}`);
  await sse3.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro 1 della ripresa (sunto)");
  check("2a: il resume ha scritto nel file GIUSTO e parte dal sunto", fs.readFileSync(f[3], "utf8").includes("Riassumi in breve"), "");
  await post(BASE_A, "/termina", { taskId: b.id }, TOKEN_A);
  sse3.chiudi();

  // ---- PUNTO 2b: caso limite — oltre il limite: errore chiaro, MAI uccidere ----
  console.log("[rifiniture] punto 2b — caso limite (attesa max 6s sul server B)");
  execFileSync("tmux", ["send-keys", "-t", `${SESS}:t4`, "Scrivi una spiegazione molto lunga in italiano, almeno 600 parole, sulla storia del cinema", "Enter"]);
  await attesaPaneVivo(`${SESS}:t4`, 30000, "t4 sta generando");
  const pidT4 = pidPiFinestra(`${SESS}:t4`);
  check("2b: processo pi della finestra trovato", pidT4 != null, `pid=${pidT4}`);
  r = await post(BASE_B, "/riprendi", { finestra: `${SESS}:t4` }, TOKEN_B);
  b = await r.json();
  check("2b: /riprendi oltre il limite → 409 col motivo chiaro", r.status === 409 && (b.errore ?? "").includes("ancora lavorando"), JSON.stringify(b));
  let vivo = true;
  try { process.kill(pidT4, 0); } catch { vivo = false; }
  check("2b: il processo della finestra NON è stato ucciso", vivo, `pid=${pidT4}`);
  console.log("  attendo la fine della generazione (max 5 min)...");
  await attesaPaneFermo(`${SESS}:t4`, 300000, "t4 si ferma");
  const tInizio2 = Date.now();
  r = await post(BASE_B, "/riprendi", { finestra: `${SESS}:t4` }, TOKEN_B);
  const tempo2b = Date.now() - tInizio2;
  b = await r.json();
  check("2b: a finestra ferma la ripresa procede subito", r.status === 200, JSON.stringify(b).slice(0, 120));
  check("2b: nessuna attesa residua (risposta < 8s)", tempo2b < 8000, `tempo=${tempo2b}ms`);
  const sse4 = apriSse(`${BASE_B}/eventi/${b.id}`);
  await sse4.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro 1 della ripresa");
  check("2b: il resume ha scritto nel file GIUSTO", fs.readFileSync(f[4], "utf8").includes("Riassumi in breve"), "");
  await post(BASE_B, "/termina", { taskId: b.id }, TOKEN_B);
  sse4.chiudi();

  // ---- PUNTO 3: menù separato (struttura pagina + E2E) ----
  console.log("[rifiniture] punto 3 — menù separato per le sessioni");
  const html = fs.readFileSync(join(ROOT, "src", "pagina.html"), "utf8");
  check("3: nav con le voci Home e Sessioni", html.includes('data-vista="home"') && html.includes('data-vista="sessioni"'), "");
  check("3: viste separate (vista-home, vista-sessioni nascosta di default)", html.includes('id="vista-home"') && html.includes('id="vista-sessioni" hidden'), "");
  // multi (2026-08-13): barra schede + canale globale; il listener di cambio
  // vista NON crea EventSource (quelli vivono solo in apriGlobale/apriStream)
  check("3: la pagina ha la barra schede e il canale globale", html.includes("scheda-conv") && html.includes("/eventi-globali") && html.includes("vista-chat"), "");
  const navJs = html.split('document.querySelectorAll("#nav button[data-vista]")').pop().split("});")[0];
  check("3: il cambio vista non crea stream SSE (solo chiude quello della scheda lasciata)", !/new EventSource/.test(navJs), navJs.slice(0, 80));
  r = await post(BASE_A, "/task", { obiettivo: "Rispondi solo con la parola FINE3", cwd: CWD }, TOKEN_A);
  b = await r.json();
  const idE = b.id;
  const sseE = apriSse(`${BASE_A}/eventi/${idE}`);
  await sseE.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "task E2E in attesa");
  r = await fetch(`${BASE_A}/sessioni`, { headers: { "X-CSRF-Token": TOKEN_A } });
  b = await r.json();
  check("3: GET /sessioni mentre il compito è attivo → 200", r.status === 200, `status=${r.status}`);
  check("3: il pannello è sola lettura (lista finestre pi presente)", Array.isArray(b.finestre) && b.finestre.some((v) => v.cmd === "pi"), "");
  r = await post(BASE_A, "/messaggio", { taskId: idE, testo: "Rispondi solo con la parola ANCORA3" }, TOKEN_A);
  check("3: il compito è rimasto in_attesa: /messaggio funziona dopo /sessioni", r.status === 200, `status=${r.status}`);
  await sseE.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "giro dopo /sessioni");
  await post(BASE_A, "/termina", { taskId: b.id }, TOKEN_A);
  sseE.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error("log server A:", serverA?.logServer.slice(-800));
  console.error("log server B:", serverB?.logServer.slice(-800));
  exitCode = 2;
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", SESS], { stdio: "ignore" }); } catch { /* già rimossa */ }
  for (const s of [serverA, serverB]) {
    if (!s) continue;
    s.proc.kill("SIGTERM");
    await sleep(500);
    if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
  }
}

console.log(`\nRISULTATO RIFINITURE: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
