// Test Fase 9 — server web di superPi (passi 9.1-9.5) via HTTP reale.
// Avvia src/server.mjs su una porta di test (SUPERPI_PORT=8799) e verifica:
//   9.1  POST /task: CSRF, gate (cwd in $HOME/hive rifiutate col motivo), 200+id
//   9.2  GET /eventi/<id> (SSE): grezzo uno alla volta nel tempo, condensato dopo
//   9.3  /rispondi: dialogo select (permission-gate pi-guardrails) risposto via
//        HTTP — conferma esegue, rifiuto blocca (coerente col test F del broker)
//   9.4  un figlio alla volta: secondo /task durante il primo → 409 col motivo,
//        dopo la fine → accettato
//   9.5  GET /: pagina HTML con token CSRF e riferimenti agli endpoint giusti
import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import os from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = join(ROOT, ".test-run", "cwd");
fs.mkdirSync(CWD, { recursive: true });

let nPass = 0;
let nFail = 0;
let exitCode = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) {
    nPass++;
    console.log(`  OK ${nome}`);
  } else {
    nFail++;
    console.error(`  FAIL ${nome} ${dettaglio}`);
  }
}

// --- avvio server di test ---
console.log("[fase9] avvio server di test su porta " + PORT);
const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, SUPERPI_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let logServer = "";
proc.stdout.on("data", (d) => (logServer += d));
proc.stderr.on("data", (d) => (logServer += d));

async function attesaPronto(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server non pronto. Log:\n${logServer}`);
}

// --- client SSE minimale (Node non ha EventSource): parsing del frame a mano ---
function apriSse(url) {
  const eventi = []; // {tipo, dati, ts}
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
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const mTipo = frame.match(/^event: (.+)$/m);
          const mData = frame.match(/^data: (.+)$/m);
          if (!mData) continue; // commento/ping
          const ev = { tipo: mTipo ? mTipo[1] : "message", dati: JSON.parse(mData[1]), ts: Date.now() };
          eventi.push(ev);
          for (let i = attese.length - 1; i >= 0; i--) {
            if (attese[i].pred(ev)) {
              const a = attese.splice(i, 1)[0];
              clearTimeout(a.timer);
              a.resolve(ev);
            }
          }
        }
      }
    } catch { /* connessione chiusa: le attese in sospeso scadranno da sole */ }
  })();
  return {
    eventi,
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

// --- helper HTTP ---
async function postTask(obiettivo, cwd, token) {
  return fetch(`${BASE}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ obiettivo, cwd }),
  });
}
async function postRispondi(payload, token) {
  return fetch(`${BASE}/rispondi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(payload),
  });
}
// Chat continua (2026-08-12): il condensato arriva SOLO dopo /termina — ogni
// attesa di condensato nei test passa prima da qui. Multi (2026-08-14):
// /termina vuole esplicitamente il taskId della conversazione.
async function postTermina(taskId, token) {
  return fetch(`${BASE}/termina`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ taskId }),
  });
}
async function postScarta(taskId, token) {
  return fetch(`${BASE}/scarta`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ taskId }),
  });
}

try {
  await attesaPronto();

  // 9.5 (anticipato per prendere il token dalla pagina, come farebbe un browser)
  console.log("[fase9] 9.5 — la pagina (GET /)");
  const paginaRes = await fetch(`${BASE}/`);
  const html = await paginaRes.text();
  check("9.5: GET / risponde 200 HTML", paginaRes.ok && (paginaRes.headers.get("content-type") ?? "").includes("text/html"), `status=${paginaRes.status}`);
  check("9.5: token CSRF iniettato nella pagina", /<meta name="csrf-token" content="[0-9a-f]{64}">/.test(html));
  check("9.5: la pagina referenzia gli endpoint giusti", html.includes("/eventi/") && html.includes("/rispondi") && html.includes("/task") && html.includes("EventSource"));
  const TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("9.5: token estraibile (64 hex)", !!TOKEN);

  // 9.1 — rifiuti e validazione
  console.log("[fase9] 9.1 — POST /task: CSRF e gate");
  let r = await fetch(`${BASE}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ obiettivo: "x", cwd: CWD }),
  });
  check("9.1: POST senza token → 401", r.status === 401, `status=${r.status}`);

  r = await postTask("x", CWD, "token-sbagliato");
  check("9.1: POST con token sbagliato → 401", r.status === 401, `status=${r.status}`);

  r = await postTask("x", os.homedir(), TOKEN);
  const bHome = await r.json();
  check("9.1: cwd = $HOME rifiutata col motivo del gate", r.status === 400 && (bHome.errore ?? "").includes("$HOME"), JSON.stringify(bHome));

  r = await postTask("x", join(os.homedir(), "hive", "appunti"), TOKEN);
  const bHive = await r.json();
  check("9.1: cwd dentro hive rifiutata col motivo del gate", r.status === 400 && (bHive.errore ?? "").includes("hive"), JSON.stringify(bHive));

  r = await postTask("", CWD, TOKEN);
  check("9.1: obiettivo vuoto → 400", r.status === 400, `status=${r.status}`);

  // 9.1+9.2 — compito vero (3 tool call in sequenza) + stream in tempo reale
  console.log("[fase9] 9.2 — SSE: eventi grezzi uno alla volta, condensato dopo");
  r = await postTask(
    "Esegui ESATTAMENTE tre comandi bash, UNO PER CHIAMATA del tool, mai due nella stessa chiamata, in quest'ordine: 1) echo UNO 2) echo DUE 3) echo TRE. Poi rispondi con la sola parola FATTO.",
    CWD,
    TOKEN,
  );
  const bTask = await r.json();
  check("9.1: POST valido → 200 con id", r.status === 200 && typeof bTask.id === "string" && bTask.id.length > 0, JSON.stringify(bTask));
  const taskId = bTask.id;

  const sse = apriSse(`${BASE}/eventi/${taskId}`);
  const t0 = Date.now();

  // 9.4 — multi-conversazione (2026-08-14): un secondo /task durante il primo
  // NON è più rifiutato: crea una seconda conversazione indipendente.
  r = await postTask("compito di prova da rifiutare", CWD, TOKEN);
  const b409 = await r.json();
  check(
    "9.4: secondo /task durante il primo → 200 (multi-conversazione, limite non raggiunto)",
    r.status === 200 && typeof b409.id === "string",
    JSON.stringify(b409),
  );
  const sse409 = apriSse(`${BASE}/eventi/${b409.id}`); // stream PRIMA di chiudere
  await postTermina(b409.id, TOKEN); // e la si chiude subito
  await sse409.attesa((e) => e.tipo === "condensato", 60000, "condensato del secondo task");
  sse409.chiudi();
  await postScarta(b409.id, TOKEN);

  const g1 = await sse.attesa((e) => e.tipo === "grezzo" && e.dati.riga.includes("UNO"), 120000, "primo grezzo (UNO)");
  const g2 = await sse.attesa((e) => e.tipo === "grezzo" && e.dati.riga.includes("DUE"), 120000, "secondo grezzo (DUE)");
  const g3 = await sse.attesa((e) => e.tipo === "grezzo" && e.dati.riga.includes("TRE"), 120000, "terzo grezzo (TRE)");
  await postTermina(taskId, TOKEN); // chat continua: il condensato arriva solo a chiusura
  await postScarta(taskId, TOKEN); // le finite restano in tasks finché /scarta non le rimuove
  const cond = await sse.attesa((e) => e.tipo === "condensato", 120000, "condensato");

  const grezzi = sse.eventi.filter((e) => e.tipo === "grezzo");
  check("9.2: almeno 3 eventi grezzi", grezzi.length >= 3, `grezzi=${grezzi.length}`);
  const inOrdine = g1.ts < g2.ts && g2.ts < g3.ts && g3.ts < cond.ts;
  check("9.2: consegnati uno alla volta (tempi crescenti), condensato per ultimo", inOrdine, `g1=${g1.ts - t0}ms g2=${g2.ts - t0}ms g3=${g3.ts - t0}ms cond=${cond.ts - t0}ms`);
  const distanziati = g2.ts - g1.ts > 100 && g3.ts - g2.ts > 100;
  check("9.2: non tutti insieme (gap reali tra un grezzo e il successivo)", distanziati, `gap12=${g2.ts - g1.ts}ms gap23=${g3.ts - g2.ts}ms`);
  check("9.2: condensato con fatto >= 3 tool", (cond.dati.fatto ?? []).length >= 3, JSON.stringify(cond.dati.fatto));
  sse.chiudi();

  // 9.4 — dopo la fine, un nuovo compito è accettato
  console.log("[fase9] 9.4 — dopo la fine, un nuovo compito è accettato");
  r = await postTask("Usa il tool bash per eseguire `date -u +%Y-%m-%d` e rispondi con l'output esatto.", CWD, TOKEN);
  const bTask2 = await r.json();
  check("9.4: terzo /task dopo la fine → 200", r.status === 200 && typeof bTask2.id === "string", JSON.stringify(bTask2));
  const sse2 = apriSse(`${BASE}/eventi/${bTask2.id}`);
  await sse2.attesa((e) => e.tipo === "grezzo", 120000, "primo grezzo del secondo compito");
  await postTermina(bTask2.id, TOKEN);
  await postScarta(bTask2.id, TOKEN);
  await sse2.attesa((e) => e.tipo === "condensato", 120000, "condensato del secondo compito");
  check("9.4: il secondo compito arriva a condensato", true);
  sse2.chiudi();

  // 9.3 — dialoghi: permission-gate (select) via HTTP reale
  console.log("[fase9] 9.3 — dialogo select risposto via /rispondi (conferma e rifiuto)");
  const fileA = join(CWD, "fase9-allow.txt");
  const fileB = join(CWD, "fase9-deny.txt");
  fs.writeFileSync(fileA, "usa e getta\n");
  fs.writeFileSync(fileB, "usa e getta\n");

  r = await postTask(`Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo né aggiungere altro: \`rm -rf ${fileA}\``, CWD, TOKEN);
  const bA = await r.json();
  const sseA = apriSse(`${BASE}/eventi/${bA.id}`);
  const dlgA = await sseA.attesa((e) => e.tipo === "dialogo", 180000, "dialogo (select) — conferma");
  check("9.3: dialogo select arriva nello stream", dlgA.dati.method === "select" && Array.isArray(dlgA.dati.options) && dlgA.dati.options.includes("Allow once"), JSON.stringify(dlgA.dati));
  // con una conversazione ATTIVA, un id inesistente deve dare 404 (non 409: la conversazione c'è)
  r = await postRispondi({ taskId: bA.id, id: "id-inventato", confirmed: true }, TOKEN);
  check("9.3: /rispondi con id inesistente (conversazione attiva) → 404 col motivo", r.status === 404, `status=${r.status}`);
  r = await postRispondi({ taskId: bA.id, id: dlgA.dati.id, value: "Allow once" }, TOKEN);
  check("9.3: /rispondi select → 200 ok", r.status === 200, `status=${r.status}`);
  await sseA.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 180000, "giro chiuso (in_attesa) dopo conferma");
  await postTermina(bA.id, TOKEN);
  await postScarta(bA.id, TOKEN);
  await sseA.attesa((e) => e.tipo === "condensato", 180000, "condensato dopo conferma");
  check("9.3: confermato → il comando è stato eseguito (file cancellato)", !fs.existsSync(fileA));
  sseA.chiudi();

  r = await postTask(`Esegui ESATTAMENTE questo comando nel tool bash, senza modificarlo né aggiungere altro: \`rm -rf ${fileB}\``, CWD, TOKEN);
  const bB = await r.json();
  const sseB = apriSse(`${BASE}/eventi/${bB.id}`);
  // rifiuta OGNI dialogo che arriva (il modello può riprovare, come nel test C del broker)
  let rifiuti = 0;
  for (;;) {
    const dlg = await sseB.attesa((e) => e.tipo === "dialogo", 60000, `dialogo (select) — rifiuto #${rifiuti + 1}`).catch(() => null);
    if (!dlg) break;
    rifiuti++;
    await postRispondi({ taskId: bB.id, id: dlg.dati.id, value: "Deny" }, TOKEN);
    if (rifiuti >= 6) break;
  }
  await postTermina(bB.id, TOKEN); // chat continua: il condensato arriva solo a chiusura
  const condB = await sseB.attesa((e) => e.tipo === "condensato", 240000, "condensato dopo rifiuto");
  check("9.3: rifiutato → il comando NON è stato eseguito (file ancora presente)", fs.existsSync(fileB));
  check(
    "9.3: il condensato riporta il blocco in bloccato_su",
    (condB.dati.bloccato_su ?? "") !== "" && condB.dati.bloccato_su !== null,
    JSON.stringify(condB.dati.bloccato_su),
  );
  console.log(`  (dialoghi rifiutati in sequenza: ${rifiuti}, bloccato_su: ${JSON.stringify(condB.dati.bloccato_su).slice(0, 160)})`);
  sseB.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(`--- log server ---\n${logServer.slice(-3000)}`);
  exitCode = 2;
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  if (proc.exitCode === null) proc.kill("SIGKILL");
  if (fs.existsSync(join(CWD, "fase9-allow.txt"))) fs.unlinkSync(join(CWD, "fase9-allow.txt"));
  if (fs.existsSync(join(CWD, "fase9-deny.txt"))) fs.unlinkSync(join(CWD, "fase9-deny.txt"));
}

console.log(`\nRISULTATO FASE 9 (9.1-9.5): ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
