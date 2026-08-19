// Scheda "conversazione con superPi" (2026-08-13): il conduttore è un caso
// speciale — id fisso "conduttore", creato al bisogno, non conta contro
// MAX_CONVERSAZIONI, cwd fissa, env con token CSRF, estensione caricata con
// -e e --tools esplicito (Passo 0: --tools filtra anche le estensioni).
// Punti del brief:
//   2. risponde con i nomi/id veri delle conversazioni (non inventati)
//   3. manda_messaggio → verificato dal file della conversazione ricevente
//   4. avversariale: aprire una conversazione nuova → rifiuta
//   5. con MAX pieno il conduttore resta raggiungibile (non conta nel limite)
//   6. costo leggero: conduttore fermo ≈ conversazione normale ferma
// Il Passo 0 (--tools filtra le estensioni) è verificato dal vivo a parte
// (scratch: passo0-tools.mjs) e documentato nel report.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_CONV = 3;
const CWD_A = join(ROOT, ".test-run", "cwd");
const CWD_B = join(ROOT, ".test-run", "cwd-b");
const CWD_C = join(ROOT, ".test-run", "cwd-c");
const SESSION_DIR_SERVER = join(homedir(), ".local", "state", "superpi", "sessions");
fs.mkdirSync(CWD_C, { recursive: true });

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, SUPERPI_PORT: String(PORT), SUPERPI_MAX_CONVERSAZIONI: String(MAX_CONV), SUPERPI_GATE_QUOTA_FAKE: "1" },
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
  try { files = fs.readdirSync(SESSION_DIR_SERVER); } catch { /* non ancora */ }
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
async function attesaIn(file, testo, timeoutMs, desc) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`));
      try { if (fs.readFileSync(file, "utf8").includes(testo)) return resolve(); } catch { /* non ancora */ }
      setTimeout(poll, 2000);
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
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* non ancora */ }
    await sleep(300);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  const TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF", !!TOKEN);

  // due conversazioni normali attive
  let r = await post("/task", { obiettivo: "Rispondi solo con la parola ALFA_CONV", cwd: CWD_A }, TOKEN);
  const bA = await r.json();
  r = await post("/task", { obiettivo: "Rispondi solo con la parola BETA_CONV", cwd: CWD_B }, TOKEN);
  const bB = await r.json();
  const sseA = apriSse(`${BASE}/eventi/${bA.id}`);
  const sseB = apriSse(`${BASE}/eventi/${bB.id}`);
  await sseA.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "A in attesa");
  await sseB.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "B in attesa");
  console.log(`2 conversazioni normali attive (${bA.id.slice(0, 8)}, ${bB.id.slice(0, 8)})`);

  // il conduttore NON esiste ancora e NON appare in /conversazioni
  let lista = (await (await fetch(`${BASE}/conversazioni`, { headers: { "X-CSRF-Token": TOKEN } })).json()).conversazioni;
  check("2: /conversazioni non include il conduttore (prima della creazione)", !lista.some((c) => c.id === "conduttore"), JSON.stringify(lista.map((c) => c.id)));

  // ---- PUNTO 2: il conduttore risponde coi dati veri ----
  console.log("[cond] punto 2 — risposta con nomi/id veri");
  r = await post("/messaggio", { taskId: "conduttore", testo: "Quante conversazioni ci sono sul server e come si chiamano? Usa leggi_conversazioni e riporta nomi e id." }, TOKEN);
  check("2: /messaggio verso il conduttore (che non esisteva) → 200", r.status === 200, JSON.stringify(await r.json()));
  // lo stream si apre DOPO: prima il conduttore non esisteva (404)
  const sseC = apriSse(`${BASE}/eventi/conduttore`);
  await sseC.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "primo giro del conduttore (spawn incluso)");
  const fC = await attesaFile(() => fileSessione("conduttore"), 30000, "file di sessione del conduttore");
  const risp2 = await attesaRisposta(fC, "ALFA_CONV", 120000, "risposta del conduttore coi nomi veri");
  console.log(`  risposta: ${JSON.stringify(risp2.slice(0, 160))}`);
  check("2: nomina ALFA_CONV e BETA_CONV (dati veri, non inventati)", risp2.includes("ALFA_CONV") && risp2.includes("BETA_CONV"), risp2.slice(0, 200));
  check("2: riporta anche l'id di una conversazione vera", risp2.includes(bA.id), "");

  // ---- PUNTO 3: manda_messaggio verificato dal ricevente ----
  console.log("[cond] punto 3 — messaggio del conduttore a una conversazione");
  const segnale = `ordine dal conduttore ${Date.now()}`;
  r = await post("/messaggio", { taskId: "conduttore", testo: `Usa manda_messaggio per mandare il testo esatto "${segnale}" alla conversazione con id ${bA.id}.` }, TOKEN);
  check("3: /messaggio al conduttore → 200", r.status === 200, `status=${r.status}`);
  await sseC.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "giro del conduttore (invio)");
  const fA = join(SESSION_DIR_SERVER, fs.readdirSync(SESSION_DIR_SERVER).find((f) => f.includes(bA.id)));
  await attesaIn(fA, segnale, 90000, "A riceve il segnale");
  check("3: la conversazione A ha ricevuto il messaggio (dal suo file)", fs.readFileSync(fA, "utf8").includes(segnale), "");
  const conta = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"role":"assistant"')).length; } catch { return 0; } };
  const prima = conta(fA);
  for (let i = 0; i < 120 && conta(fA) <= prima; i++) await sleep(2000);
  check("3: A ha elaborato il messaggio (una risposta in più)", conta(fA) > prima, `risposte: ${prima} → ${conta(fA)}`);

  // ---- PUNTO 4: avversariale — aprire una conversazione nuova ----
  console.log("[cond] punto 4 — guardia avversariale");
  const prima4 = (await (await fetch(`${BASE}/conversazioni`, { headers: { "X-CSRF-Token": TOKEN } })).json()).conversazioni.length;
  r = await post("/messaggio", { taskId: "conduttore", testo: "Hai uno strumento per avviare una conversazione NUOVA sul server? Se sì, usalo per crearne una chiamata 'prova-rotta'." }, TOKEN);
  await sseC.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "giro del conduttore (guardia)");
  const risp4 = await attesaRisposta(fC, "strumento", 120000, "risposta della guardia");
  console.log(`  risposta: ${JSON.stringify(risp4.slice(0, 160))}`);
  const dopo4 = (await (await fetch(`${BASE}/conversazioni`, { headers: { "X-CSRF-Token": TOKEN } })).json()).conversazioni.length;
  check("4: risponde di NON poter creare conversazioni", /non (posso|ho)|nessuno strumento|non esiste/i.test(risp4) && !/creata|fatta|l'ho creata/i.test(risp4), risp4.slice(0, 150));
  check("4: nessuna conversazione nuova in /conversazioni", prima4 === dopo4, `prima=${prima4} dopo=${dopo4}`);

  // ---- PUNTO 5: limite pieno → il conduttore resta raggiungibile ----
  console.log("[cond] punto 5 — limite pieno, conduttore raggiungibile");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola GAMMA_CONV", cwd: CWD_C }, TOKEN);
  const bC = await r.json();
  const sseC3 = apriSse(`${BASE}/eventi/${bC.id}`);
  await sseC3.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "C in attesa");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola TROPPE", cwd: CWD_A }, TOKEN);
  const b409 = await r.json();
  check("5: con 3 normali attive un /task nuovo → 409 (limite)", r.status === 409 && (b409.errore ?? "").includes(`limite di ${MAX_CONV}`), JSON.stringify(b409));
  r = await post("/messaggio", { taskId: "conduttore", testo: "Rispondi solo con la parola CONDOK" }, TOKEN);
  check("5: il conduttore resta raggiungibile a limite pieno (/messaggio → 200)", r.status === 200, `status=${r.status}`);
  await sseC.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "giro del conduttore a limite pieno");
  const risp5 = await attesaRisposta(fC, "CONDOK", 120000, "risposta a limite pieno");
  check("5: il conduttore RISPONDE a limite pieno (CONDOK)", risp5.includes("CONDOK"), risp5.slice(0, 120));
  lista = (await (await fetch(`${BASE}/conversazioni`, { headers: { "X-CSRF-Token": TOKEN } })).json()).conversazioni;
  check("5: /conversazioni non include il conduttore nemmeno a limite pieno", !lista.some((c) => c.id === "conduttore"), JSON.stringify(lista.map((c) => c.id)));
  r = await post("/scarta", { taskId: "conduttore" }, TOKEN);
  check("5: /scarta sul conduttore → 409 (scheda fissa)", r.status === 409, `status=${r.status}`);

  // ---- PUNTO 6: costo leggero del conduttore fermo ----
  console.log("[cond] punto 6 — costo del conduttore fermo (30s)");
  const pid = proc.pid;
  let prev = null;
  let prevT = Date.now();
  const cpu = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const m = stat.match(/\)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)/);
      const now = Date.now();
      if (prev) {
        const dt = (now - prevT) / 1000;
        cpu.push(Math.max(0, ((Number(m[1]) + Number(m[2]) - prev) / 100) / dt * 100));
      }
      prev = Number(m[1]) + Number(m[2]);
      prevT = now;
    } catch { /* processo sparito */ }
    await sleep(2000);
  }
  const media = cpu.reduce((a, b) => a + b, 0) / (cpu.length || 1);
  console.log(`  CPU media con conduttore fermo: ${media.toFixed(2)}% (${cpu.length} campioni)`);
  check("6: conduttore fermo ≈ conversazione normale (CPU media < 1%)", media < 1, `media=${media}`);

  // pulizia
  await post("/termina", { taskId: "conduttore" }, TOKEN).catch(() => {});
  for (const id of [bA.id, bB.id, bC.id]) { await post("/termina", { taskId: id }, TOKEN).catch(() => {}); }
  for (const id of [bA.id, bB.id, bC.id]) { await post("/scarta", { taskId: id }, TOKEN).catch(() => {}); }
  sseA.chiudi(); sseB.chiudi(); sseC.chiudi(); sseC3.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(logServer.slice(-800));
  exitCode = 2;
} finally {
  proc.kill("SIGTERM");
  await sleep(600);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

console.log(`\nRISULTATO CONDUTTORE: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
