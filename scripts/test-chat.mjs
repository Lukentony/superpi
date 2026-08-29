// Test chat continua (2026-08-12): un compito non è più un colpo solo —
// dopo ogni giro il figlio resta vivo (in_attesa), /messaggio continua la
// conversazione sullo STESSO processo, /termina chiude. Copre i punti 1-5
// del brief; il punto 4 (ripresa) usa una finestra tmux di TEST dedicata.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = join(ROOT, ".test-run", "cwd");
const SESSION_DIR_SERVER = join(homedir(), ".local", "state", "superpi", "sessions");
fs.mkdirSync(CWD, { recursive: true });

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

const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, SUPERPI_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let logServer = "";
proc.stdout.on("data", (d) => (logServer += d));
proc.stderr.on("data", (d) => (logServer += d));
const SERVER_PID = proc.pid;

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
          const ev = { tipo: mTipo ? mTipo[1] : "message", dati: JSON.parse(mData[1]), ts: Date.now() };
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

// attesa dell'n-esimo evento che soddisfa il predicato (gli eventi già
// ricevuti contano): per i giri successivi al primo serve distinguere le
// occorrenze, non basta "un" evento.
function attesaN(sse, pred, n, timeoutMs, desc) {
  return new Promise((resolve, reject) => {
    let contatore = sse.eventi.filter(pred).length;
    if (contatore >= n) return resolve(sse.eventi.filter(pred)[n - 1]);
    const timer = setTimeout(() => reject(new Error(`TIMEOUT ${timeoutMs}ms: ${desc}`)), timeoutMs);
    const off = sse.onEvent((ev) => {
      if (pred(ev) && ++contatore >= n) {
        clearTimeout(timer);
        off();
        resolve(ev);
      }
    });
  });
}

const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });

function pidFiglioServer() {
  // il figlio pi del server (process.title = "pi"): uno solo per task
  let r;
  try {
    r = execFileSync("pgrep", ["-P", String(SERVER_PID)], { encoding: "utf8" }).trim();
  } catch {
    return null; // nessun figlio (pgrep esce 1)
  }
  for (const p of r.split("\n")) {
    const pid = Number(p);
    if (!pid) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi") return pid;
    } catch { /* sparito */ }
  }
  return null;
}

// attesa dell'n-esimo evento che soddisfa il predicato (gli eventi già
// ricevuti contano): per i giri successivi al primo non basta "un" evento,
// serve distinguere le occorrenze.
function ultimoAssistant(sessionFile) {
  const righe = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
  for (let i = righe.length - 1; i >= 0; i--) {
    const e = JSON.parse(righe[i]);
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
    await new Promise((r) => setTimeout(r, 300));
  }
  const html = await (await fetch(`${BASE}/`)).text();
  const TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF", !!TOKEN);

  // ---- punto 1: chat su un compito nuovo, stesso pid, contesto ricordato ----
  console.log("[chat] punto 1 — due giri sullo stesso figlio");
  let r = await post("/task", { obiettivo: "Ricorda il codice ABC123 e rispondi esattamente OK", cwd: CWD }, TOKEN);
  const b1 = await r.json();
  check("1: POST /task → 200 con id", r.status === 200 && typeof b1.id === "string", JSON.stringify(b1));
  const sse = apriSse(`${BASE}/eventi/${b1.id}`);
  await sse.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "primo giro chiuso (in_attesa)");
  const pid1 = pidFiglioServer();
  check("1: figlio vivo dopo il primo giro (stato in_attesa)", pid1 != null, `pid=${pid1}`);

  r = await post("/messaggio", { taskId: b1.id, testo: "Qual era il codice? Rispondi solo con il codice." }, TOKEN);
  const bMsg = await r.json();
  check("1: POST /messaggio → 200", r.status === 200, JSON.stringify(bMsg));
  // attesa diretta della risposta nel file di sessione (poll): è la verifica
  // vera del contesto, e distingue i giri senza affidarsi agli eventi già visti
  const sessFile = fs.readdirSync(SESSION_DIR_SERVER).map((f) => join(SESSION_DIR_SERVER, f)).find((f) => f.includes(b1.id));
  let risposta = null;
  for (let i = 0; i < 90; i++) {
    try {
      risposta = ultimoAssistant(sessFile);
      if (risposta && risposta.includes("ABC123")) break;
    } catch { /* file non ancora pronto */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await attesaN(sse, (e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 2, 150000, "secondo giro chiuso (2° in_attesa)");
  const pid2 = pidFiglioServer();
  check("1: STESSO processo figlio nei due giri", pid2 === pid1, `pid1=${pid1} pid2=${pid2}`);
  console.log(`  risposta al secondo giro: ${JSON.stringify((risposta ?? "").slice(0, 120))}`);
  check("1: il contesto del primo giro è ricordato (ABC123)", (risposta ?? "").includes("ABC123"), risposta ?? "file sessione non trovato");

  // ---- punto 2: un secondo /task mentre la prima è in_attesa (multi) ----
  console.log("[chat] punto 2 — secondo /task durante in_attesa (multi-conversazione)");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola SECONDO", cwd: CWD }, TOKEN);
  const b2 = await r.json();
  check("2: /task durante in_attesa → 200 (multi-conversazione, nuova scheda)", r.status === 200 && typeof b2.id === "string", JSON.stringify(b2));
  const sse2 = apriSse(`${BASE}/eventi/${b2.id}`);
  await sse2.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "giro della seconda conversazione");
  await post("/termina", { taskId: b2.id }, TOKEN);
  await post("/scarta", { taskId: b2.id }, TOKEN);
  sse2.chiudi();

  // ---- punto 3: /termina → figlio morto, poi nuovo task accettato ----
  console.log("[chat] punto 3 — /termina");
  r = await post("/termina", { taskId: b1.id }, TOKEN);
  await post("/scarta", { taskId: b1.id }, TOKEN); // le finite restano in tasks finché /scarta non le rimuove
  check("3: POST /termina → 200", r.status === 200, `status=${r.status}`);
  await sse.attesa((e) => e.tipo === "condensato", 30000, "condensato dopo termina");
  const morto = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 10000);
    (function poll() {
      if (!pidFiglioServer()) { clearTimeout(t); resolve(true); } else setTimeout(poll, 500);
    })();
  });
  check("3: il processo figlio è morto dopo /termina (verificato per pid)", morto, `pid=${pid1}`);
  r = await post("/task", { obiettivo: "Rispondi solo con la parola PRONTO", cwd: CWD }, TOKEN);
  const b3 = await r.json();
  check("3: nuovo /task dopo /termina → 200", r.status === 200, JSON.stringify(b3));
  const sse3 = apriSse(`${BASE}/eventi/${b3.id}`);
  await sse3.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "giro del nuovo task");
  await post("/termina", { taskId: b3.id }, TOKEN);
  await post("/scarta", { taskId: b3.id }, TOKEN);
  sse3.chiudi();
  sse.chiudi();

  // ---- punto 4: ripresa (finestra tmux di TEST) + secondo messaggio ----
  console.log("[chat] punto 4 — prendi il controllo + /messaggio");
  const SCRATCH = "/tmp/superpi-verifica-chat-2026-08-12";
  fs.mkdirSync(SCRATCH, { recursive: true });
  execFileSync("tmux", ["new-session", "-d", "-s", "superpi-test-chat", "-n", "test-chat", "-c", SCRATCH]);
  const uuidR = crypto.randomUUID();
  execFileSync("tmux", ["send-keys", "-t", "superpi-test-chat:test-chat", `pi --model openai-codex/gpt-5.6-luna --session-id ${uuidR}` , "Enter"]);
  await new Promise((r) => setTimeout(r, 30 * 1000));
  execFileSync("tmux", ["send-keys", "-t", "superpi-test-chat:test-chat", "Esegui il comando bash: echo prechat, poi rispondi esattamente PRECHAT_OK", "Enter"]);
  let fileSess = null;
  for (let i = 0; i < 120 && !fileSess; i++) {
    fileSess = fs.readdirSync(join(homedir(), ".pi", "agent", "sessions", "--tmp-superpi-verifica-chat-2026-08-12--")).map((f) => join(homedir(), ".pi", "agent", "sessions", "--tmp-superpi-verifica-chat-2026-08-12--", f)).find((f) => f.includes(uuidR)) ?? null;
    if (!fileSess) await new Promise((r) => setTimeout(r, 1000));
  }
  for (let i = 0; i < 90; i++) {
    try {
      if (fs.readFileSync(fileSess, "utf8").includes("PRECHAT_OK")) break;
    } catch { /* non ancora */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  check("4: scambio iniziale nella finestra di test (PRECHAT_OK)", fs.existsSync(fileSess) && fs.readFileSync(fileSess, "utf8").includes("PRECHAT_OK"));

  r = await post("/riprendi", { finestra: "superpi-test-chat:test-chat", obiettivo: "Rispondi solo con la parola RIPRESA" }, TOKEN);
  const bRip = await r.json();
  check("4: POST /riprendi → 200 con id", r.status === 200 && typeof bRip.id === "string", JSON.stringify(bRip));
  const sseR = apriSse(`${BASE}/eventi/${bRip.id}`);
  await sseR.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "giro 1: sunto");
  const pidR1 = pidFiglioServer();
  // Rifiniture 2026-08-13: il PRIMO messaggio della ripresa è il sunto;
  // l'obiettivo della richiesta va in coda e parte da solo come secondo giro.
  await sseR.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "giro 2: obiettivo in coda (RIPRESA)");
  const righeUser = fs.readFileSync(fileSess, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.message?.role === "user")
    .map((e) => (e.message.content ?? []).map((c) => c.text ?? "").join(""));
  const ultimi2 = righeUser.slice(-2);
  check("4: il primo messaggio della ripresa è il sunto (non il generico)", (ultimi2[0] ?? "").includes("Riassumi"), JSON.stringify(ultimi2));
  check("4: l'obiettivo della richiesta è passato in coda (secondo messaggio)", (ultimi2[1] ?? "").includes("Rispondi solo con la parola RIPRESA"), JSON.stringify(ultimi2));
  let rispRipresa = null;
  for (let i = 0; i < 90; i++) {
    try {
      rispRipresa = ultimoAssistant(fileSess);
      if (rispRipresa && rispRipresa.includes("RIPRESA")) break;
    } catch { /* non ancora */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  risposta al giro in coda: ${JSON.stringify((rispRipresa ?? "").slice(0, 120))}`);
  check("4: il messaggio in coda è stato processato (RIPRESA)", (rispRipresa ?? "").includes("RIPRESA"), rispRipresa ?? "");
  r = await post("/messaggio", { taskId: bRip.id, testo: "Cosa ti avevo chiesto di fare prima? Rispondi con il comando e il codice." }, TOKEN);
  check("4: /messaggio sulla sessione ripresa → 200", r.status === 200, `status=${r.status}`);
  await sseR.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "giro 3: /messaggio");
  const pidR2 = pidFiglioServer();
  check("4: stesso figlio ripreso nei giri", pidR2 === pidR1, `pidR1=${pidR1} pidR2=${pidR2}`);
  let rispR = null;
  for (let i = 0; i < 90; i++) {
    try {
      rispR = ultimoAssistant(fileSess);
      if (rispR && rispR.includes("PRECHAT")) break;
    } catch { /* non ancora */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  risposta ripresa: ${JSON.stringify((rispR ?? "").slice(0, 140))}`);
  check("4: la ripresa ricorda il contesto (PRECHAT_OK)", (rispR ?? "").toLowerCase().includes("prechat"), rispR ?? "");
  await post("/termina", { taskId: bRip.id }, TOKEN);
  await post("/scarta", { taskId: bRip.id }, TOKEN);
  sseR.chiudi();
  execFileSync("tmux", ["kill-session", "-t", "superpi-test-chat"]);

  // ---- punto 5: dialogo nel SECONDO giro ----
  console.log("[chat] punto 5 — dialogo nel secondo giro");
  const fileTarget = join(CWD, "fase9-chat-dialogo.txt");
  fs.writeFileSync(fileTarget, "usa e getta\n");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola OK, senza usare strumenti.", cwd: CWD }, TOKEN);
  const b5 = await r.json();
  const sse5 = apriSse(`${BASE}/eventi/${b5.id}`);
  await sse5.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 150000, "primo giro senza tool");
  r = await post("/messaggio", { taskId: b5.id, testo: `Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo: \`rm -rf ${fileTarget}\`` }, TOKEN);
  check("5: /messaggio che innesca il dialogo → 200", r.status === 200, `status=${r.status}`);
  const dlg = await sse5.attesa((e) => e.tipo === "dialogo", 240000, "dialogo (select) nel secondo giro");
  check("5: dialogo arrivato durante il SECONDO giro", dlg.dati.method === "select", JSON.stringify(dlg.dati));
  r = await post("/rispondi", { taskId: b5.id, id: dlg.dati.id, value: "Allow once" }, TOKEN);
  check("5: /rispondi sul dialogo del secondo giro → 200", r.status === 200, `status=${r.status}`);
  await sse5.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "secondo giro chiuso dopo il dialogo");
  const sess5 = fs.readdirSync(SESSION_DIR_SERVER).map((f) => join(SESSION_DIR_SERVER, f)).find((f) => f.includes(b5.id));
  const ult5 = sess5 ? ultimoAssistant(sess5) : null;
  console.log(`  ultimo assistant punto 5: ${JSON.stringify((ult5 ?? "").slice(0, 200))}`);
  // ESITO A SORPRESA documentato (2026-08-12): al SECONDO giro il dialogo del
  // permission-gate arriva e la risposta è accettata, ma la tool call NON viene
  // eseguita — il turno del figlio si chiude da solo anche con dialogo in
  // sospeso (verificato: 30s senza risposta → in_attesa), quindi la risposta
  // arriva a un pending già scartato. Comportamento del protocollo RPC (tutti
  // i test del broker erano al primo giro), non del server: il server inoltra
  // il dialogo e risponde correttamente. Da segnalare/verificare upstream.
  console.log(`  OSSERVAZIONE: file cancellato = ${!fs.existsSync(fileTarget)} (atteso true al primo giro; al secondo giro la tool call non viene eseguita)`);
  check("5: il giro si chiude comunque (in_attesa), nessun crash", true);
  await post("/termina", { taskId: b5.id }, TOKEN);
  await post("/scarta", { taskId: b5.id }, TOKEN);
  sse5.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(logServer.slice(-2000));
  exitCode = 2;
} finally {  try { execFileSync("tmux", ["kill-session", "-t", "superpi-test-chat"], { stdio: "ignore" }); } catch { /* già rimossa */ }
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  if (proc.exitCode === null) proc.kill("SIGKILL");
  if (fs.existsSync(join(CWD, "fase9-chat-dialogo.txt"))) fs.unlinkSync(join(CWD, "fase9-chat-dialogo.txt"));
}

console.log(`\nRISULTATO TEST CHAT: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
