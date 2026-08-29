// Fix risposte a solo testo (2026-08-16): le risposte a parole non arrivavano
// mai alla pagina (bug trovato provando la pagina, non da test). Il gestore
// condiviso ora gestisce message_end assistant → evento SSE "risposta" +
// t.ultimaRisposta (usata anche nello snapshot e nel condensato, che resta
// invariato — il campo si aggiunge a parte in postTermina).
// Punti del brief:
//   1. messaggio a SOLO testo → evento "risposta" con il testo giusto
//   2. caso misto (strumento + testo) → grezzo e risposta, nell'ordine
//   3. condensato con rispostaFinale (contenuto vero, non null)
//   4. il sunto alla ripresa arriva DAVVERO sullo stream (non solo nel file)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = join(ROOT, ".test-run", "cwd");
const SCRATCH = "/tmp/superpi-verifica-fix-risposta-2026-08-16";
const PI_SESSIONS = join(homedir(), ".pi", "agent", "sessions");
fs.mkdirSync(SCRATCH, { recursive: true });

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, SUPERPI_PORT: String(PORT), SUPERPI_GATE_QUOTA_FAKE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logServer = "";
proc.stdout.on("data", (d) => (logServer += d));
proc.stderr.on("data", (d) => (logServer += d));

function apriSse(url) {
  const eventi = [];
  const attese = [];
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
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const mTipo = frame.match(/^event: (.+)$/m);
          const mData = frame.match(/^data: (.+)$/m);
          if (!mData) continue;
          const ev = { tipo: mTipo ? mTipo[1] : "message", dati: JSON.parse(mData[1]) };
          eventi.push(ev);
          for (let i = attese.length - 1; i >= 0; i--) {
            if (attese[i].pred(ev)) { const a = attese.splice(i, 1)[0]; clearTimeout(a.timer); a.resolve(ev); }
          }
        }
      }
    } catch { /* chiusa */ }
  })();
  return { eventi, attesa: (p, t, d) => new Promise((res, rej) => {
    const già = eventi.find(p); if (già) return res(già);
    const timer = setTimeout(() => rej(new Error(`TIMEOUT ${t}: ${d}`)), t);
    const iv = setInterval(() => { const e = eventi.find(p); if (e) { clearInterval(iv); clearTimeout(timer); res(e); } }, 200);
    setTimeout(() => clearInterval(iv), t + 1000);
  }), chiudi: () => controller.abort() };
}

const post = (path, body, token) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify(body) });

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
function fileSessione(taskId) {
  let files = [];
  try { files = fs.readdirSync(join(homedir(), ".local", "state", "superpi", "sessions")); } catch { /* non ancora */ }
  const f = files.find((x) => x.includes(taskId));
  return f ? join(homedir(), ".local", "state", "superpi", "sessions", f) : null;
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
async function attesaRisposta(file, chiave, timeoutMs, desc) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`));
      try {
        const u = ultimoAssistant(file);
        if (u && u.includes(chiave)) return resolve(u);
      } catch { /* non ancora */ }
      setTimeout(poll, 2000);
    })();
  });
}

let exitCode = 0;
let TOKEN = null;
// Fix residuo test (2026-08-16): traccia OGNI task creato — il finally chiude
// tutto (best-effort) qualunque punto del test fallisca, non solo i task che
// il flusso normale aveva già chiuso. Verifica del Passo 0: su questa
// versione i figli muoiono comunque col server (pipe chiuso), ma la chiusura
// pulita via /termina resta l'ordine giusto (condensato, niente stati a metà).
const taskCreati = [];
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* non ancora */ }
    await sleep(300);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF", !!TOKEN);

  // ---- PUNTO 1: risposta a SOLO testo arriva come evento "risposta" ----
  console.log("[fix] punto 1 — solo testo");
  let r = await post("/task", { obiettivo: "Rispondi solo con la parola PAROLE_OK, senza usare strumenti.", cwd: CWD }, TOKEN);
  const b1 = await r.json();
  taskCreati.push(b1.id);
  const sse1 = apriSse(`${BASE}/eventi/${b1.id}`);
  const risp1 = await sse1.attesa((e) => e.tipo === "risposta" && (e.dati.testo ?? "").includes("PAROLE_OK"), 150000, "evento risposta (PAROLE_OK)");
  check("1: l'evento 'risposta' arriva sullo stream col testo giusto", risp1.dati.testo.includes("PAROLE_OK"), JSON.stringify(risp1.dati));
  check("1: l'evento ha il timestamp", typeof risp1.dati.ts === "string" && risp1.dati.ts.length > 0, JSON.stringify(risp1.dati));

  // ---- PUNTO 3 (qui, prima della pulizia): condensato con rispostaFinale ----
  r = await post("/termina", { taskId: b1.id }, TOKEN);
  check("3: /termina → 200", r.status === 200, `status=${r.status}`);
  const cond1 = await sse1.attesa((e) => e.tipo === "condensato", 30000, "condensato");
  check("3: il condensato include rispostaFinale col contenuto vero", cond1.dati.rispostaFinale?.testo?.includes("PAROLE_OK"), JSON.stringify(cond1.dati.rispostaFinale));
  await post("/scarta", { taskId: b1.id }, TOKEN);
  sse1.chiudi();

  // ---- PUNTO 2: caso misto (strumento + testo finale) ----
  console.log("[fix] punto 2 — misto: strumento + risposta a parole");
  r = await post("/task", { obiettivo: "Usa il tool bash per eseguire `echo MISTO_TOOL`, poi rispondi esattamente con la parola MISTO_FINE.", cwd: CWD }, TOKEN);
  const b2 = await r.json();
  taskCreati.push(b2.id);
  const sse2 = apriSse(`${BASE}/eventi/${b2.id}`);
  await sse2.attesa((e) => e.tipo === "grezzo" && e.dati.riga.includes("MISTO_TOOL"), 150000, "grezzo dello strumento");
  const risp2 = await sse2.attesa((e) => e.tipo === "risposta" && (e.dati.testo ?? "").includes("MISTO_FINE"), 150000, "risposta finale");
  check("2: arrivano ENTRAMBI (grezzo per lo strumento, risposta per il testo)", true, "");
  const iGrezzo = sse2.eventi.findIndex((e) => e.tipo === "grezzo" && e.dati.riga.includes("MISTO_TOOL"));
  const iRisposta = sse2.eventi.indexOf(risp2);
  check("2: nell'ordine giusto (grezzo prima, risposta dopo)", iGrezzo >= 0 && iRisposta > iGrezzo, `grezzo=${iGrezzo} risposta=${iRisposta}`);
  check("2: la risposta è il testo vero (MISTO_FINE)", risp2.dati.testo.includes("MISTO_FINE"), JSON.stringify(risp2.dati.testo));
  r = await post("/termina", { taskId: b2.id }, TOKEN);
  const cond2 = await sse2.attesa((e) => e.tipo === "condensato", 30000, "condensato misto");
  check("2: condensato con rispostaFinale = MISTO_FINE", cond2.dati.rispostaFinale?.testo?.includes("MISTO_FINE"), JSON.stringify(cond2.dati.rispostaFinale));
  await post("/scarta", { taskId: b2.id }, TOKEN);
  sse2.chiudi();

  // ---- PUNTO 4: il sunto alla ripresa arriva sullo stream ----
  console.log("[fix] punto 4 — sunto alla ripresa sullo stream");
  // pre-trust della cartella nuova (trust prompt interattivo, lezione già pagata)
  execFileSync("tmux", ["new-session", "-d", "-s", "superpi-trust-fix", "-n", "t", "-c", SCRATCH]);
  execFileSync("tmux", ["send-keys", "-t", "superpi-trust-fix:t", `pi --model openai-codex/gpt-5.6-luna --session-id ${crypto.randomUUID()}`, "Enter"]);
  await sleep(25 * 1000);
  const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", "superpi-trust-fix:t"], { encoding: "utf8" });
  if (pane.includes("Trust project folder")) {
    execFileSync("tmux", ["send-keys", "-t", "superpi-trust-fix:t", "Enter"]);
    await sleep(15 * 1000);
  }
  execFileSync("tmux", ["kill-session", "-t", "superpi-trust-fix"], { stdio: "ignore" });
  execFileSync("tmux", ["new-session", "-d", "-s", "superpi-test-fix-risp", "-n", "wt", "-c", SCRATCH]);
  const uuid = crypto.randomUUID();
  execFileSync("tmux", ["send-keys", "-t", "superpi-test-fix-risp:wt", `pi --model openai-codex/gpt-5.6-luna --session-id ${uuid}`, "Enter"]);
  await sleep(30 * 1000);
  execFileSync("tmux", ["send-keys", "-t", "superpi-test-fix-risp:wt", "Il codice è SUNTO_RIP, ricordalo.", "Enter"]);
  const dirSan = "--tmp-superpi-verifica-fix-risposta-2026-08-16--";
  const fWt = await attesaFile(() => {
    let files = [];
    try { files = fs.readdirSync(join(PI_SESSIONS, dirSan)); } catch { /* non ancora */ }
    const f = files.find((x) => x.includes(uuid));
    return f ? join(PI_SESSIONS, dirSan, f) : null;
  }, 90000, "file sessione finestra");
  await attesaRisposta(fWt, "SUNTO_RIP", 150000, "risposta nella finestra");
  r = await post("/riprendi", { finestra: "superpi-test-fix-risp:wt" }, TOKEN);
  const bR = await r.json();
  taskCreati.push(bR.id);
  check("4: /riprendi → 200", r.status === 200, JSON.stringify(bR).slice(0, 100));
  const sseR = apriSse(`${BASE}/eventi/${bR.id}`);
  const rispR = await sseR.attesa((e) => e.tipo === "risposta", 240000, "sunto come evento risposta");
  console.log(`  sunto arrivato sullo stream: ${JSON.stringify(rispR.dati.testo.slice(0, 120))}`);
  check("4: il sunto arriva DAVVERO come evento risposta (testo non vuoto)", (rispR.dati.testo ?? "").trim().length > 20, JSON.stringify(rispR.dati).slice(0, 100));
  check("4: il sunto è coerente (cita il contesto della finestra)", rispR.dati.testo.includes("SUNTO_RIP") || rispR.dati.testo.includes("codice"), rispR.dati.testo.slice(0, 150));
  await post("/termina", { taskId: bR.id }, TOKEN);
  await post("/scarta", { taskId: bR.id }, TOKEN);
  sseR.chiudi();
  execFileSync("tmux", ["kill-session", "-t", "superpi-test-fix-risp"], { stdio: "ignore" });

  // ---- PUNTO 6 (prova dal vivo come farebbe la pagina): conduttore a solo testo ----
  console.log("[fix] punto 6 — prova dal vivo col conduttore");
  r = await post("/messaggio", { taskId: "conduttore", testo: "Rispondi solo con la parola COND_PAROLE, senza usare strumenti." }, TOKEN);
  taskCreati.push("conduttore");
  check("6: /messaggio al conduttore → 200", r.status === 200, `status=${r.status}`);
  const sseC = apriSse(`${BASE}/eventi/conduttore`);
  const rispC = await sseC.attesa((e) => e.tipo === "risposta" && (e.dati.testo ?? "").includes("COND_PAROLE"), 300000, "risposta del conduttore (spawn incluso)");
  check("6: la risposta a solo testo del conduttore arriva sullo stream", rispC.dati.testo.includes("COND_PAROLE"), JSON.stringify(rispC.dati.testo).slice(0, 100));
  await post("/termina", { taskId: "conduttore" }, TOKEN);
  sseC.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(logServer.slice(-800));
  exitCode = 2;
} finally {
  // Chiusura best-effort di QUALUNQUE task ancora aperto (fix residuo test,
  // 2026-08-16): un fallimento a metà script non deve lasciare figli aperti.
  // Il /termina salva il condensato; il /scarta libera il posto. Ogni chiamata
  // ha il suo try/catch: un errore su uno non blocca gli altri.
  if (TOKEN) {
    let chiusi = 0;
    for (const id of taskCreati) {
      try { await post("/termina", { taskId: id }, TOKEN); chiusi++; } catch { /* best-effort */ }
      try { await post("/scarta", { taskId: id }, TOKEN); } catch { /* best-effort */ }
    }
    console.log(`  cleanup: ${chiusi}/${taskCreati.length} task terminati best-effort nel finally`);
  }
  for (const s of ["superpi-test-fix-risp", "superpi-trust-fix"]) {
    try { execFileSync("tmux", ["kill-session", "-t", s], { stdio: "ignore" }); } catch { /* già rimossa */ }
  }
  proc.kill("SIGTERM");
  await sleep(600);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

console.log(`\nRISULTATO FIX RISPOSTA: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
