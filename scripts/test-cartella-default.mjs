// Cartella di lavoro di default + sottocartella per conversazione (Pezzo A,
// 2026-08-17). Server di test con SUPERPI_LAVORI_DIR dedicato (mai tocca
// ~/lavori-superpi vero). Punti:
//   1  cwd assente o vuota -> LAVORI_DIR/<data>-<slug>/, figlio lavora, gate ok
//   2  due conversazioni con lo stesso obiettivo -> due sottocartelle DISTINTE
//   3  cwd esplicita -> usata com'è, NESSUNA sottocartella creata
//   4  cwd=$HOME e cwd in hive -> ancora rifiutate (gate invariato)
//   5  /termina su cwd automatica -> .superpi/riassunto.md e condensato.json
//   6  /termina su cwd esplicita -> nessun .superpi dentro la cwd di Luca
//   7  Passo 0: la prima sottocartella mai vista non blocca il primo giro
//      (verificato: cartelle nuove vuote NON innescano il trust prompt — il
//      figlio parte senza -a e completa il primo giro).
import { spawn, execFileSync } from "node:child_process";
import fs, { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const LAVORI_TEST = "/tmp/superpi-lavori-test-2026-08-17";
const CWD_ESP = join(ROOT, ".test-run", "cwd"); // cwd esplicita di test (già fidata)
fs.mkdirSync(CWD_ESP, { recursive: true });
// la LAVORI di test parte SEMPRE pulita: i run precedenti lasciano le
// sottocartelle (da qui i falsi "-2", "-3"...) — questo test misura la
// creazione, non deve accumulare stato tra i run.
fs.rmSync(LAVORI_TEST, { recursive: true, force: true });
fs.mkdirSync(LAVORI_TEST, { recursive: true });

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, SUPERPI_PORT: String(PORT), SUPERPI_LAVORI_DIR: LAVORI_TEST, SUPERPI_GATE_QUOTA_FAKE: "1" },
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

function pidFiglioPerCwd(cwd) {
  let r;
  try { r = execFileSync("pgrep", ["-P", String(proc.pid)], { encoding: "utf8" }).trim(); } catch { return null; }
  for (const p of r.split("\n")) {
    const pid = Number(p); if (!pid) continue;
    try { if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi" && readlinkSync(`/proc/${pid}/cwd`) === cwd) return pid; } catch { /* sparito */ }
  }
  return null;
}

let exitCode = 0;
let TOKEN = null;
const taskCreati = [];
try {
  await sleep(1500);
  const html = await (await fetch(`${BASE}/`)).text();
  TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF", !!TOKEN);

  // ---- PUNTO 4: $HOME e hive rifiutate (gate invariato) — eseguito PRIMA
  // di saturare il limite (4 task attivi = MAX: il 409 sarebbe il limite,
  // mascherando il gate). ----
  console.log("[cd] punto 4 — $HOME e hive rifiutati");
  let r = await post("/task", { obiettivo: "x", cwd: homedir() }, TOKEN);
  let b = await r.json();
  check("4: cwd = $HOME esatta -> 400 col motivo di sempre", r.status === 400 && (b.errore ?? "").includes("$HOME"), JSON.stringify(b));
  r = await post("/task", { obiettivo: "x", cwd: join(homedir(), "hive", "appunti") }, TOKEN);
  b = await r.json();
  check("4: cwd dentro hive -> 400 col motivo di sempre", r.status === 400 && (b.errore ?? "").includes("dentro hive"), JSON.stringify(b));

  // ---- PUNTO 1+7: cwd assente -> sottocartella automatica, primo giro parte ----
  console.log("[cd] punto 1 — cwd assente, sottocartella automatica");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola ALFA_CD", cwd: "" }, TOKEN);
  b = await r.json();
  const id1 = b.id;
  taskCreati.push(id1);
  check("1: /task con cwd vuota -> 200", r.status === 200, JSON.stringify(b).slice(0, 80));
  const sse1 = apriSse(`${BASE}/eventi/${id1}`);
  await sse1.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "primo giro (sottocartella mai vista — Passo 0)");
  check("7: la sottocartella mai vista non blocca il primo giro (in_attesa arrivato)", true, "");
  // la sottocartella esiste dentro LAVORI_TEST e il figlio ci lavora dentro
  const sottocartelle = fs.readdirSync(LAVORI_TEST).filter((f) => f.includes("-rispondi-solo-con-la-parola-alfa-cd"));
  check("1: sottocartella creata in LAVORI_TEST con lo slug dell'obiettivo", sottocartelle.length === 1, JSON.stringify(sottocartelle));
  const cwdAuto1 = join(LAVORI_TEST, sottocartelle[0]);
  const pid1 = pidFiglioPerCwd(cwdAuto1);
  check("1: il figlio lavora DAVVERO dentro la sottocartella (cwd per pid)", pid1 != null, `pid=${pid1}`);
  sse1.chiudi();

  // ---- PUNTO 2: stesso obiettivo -> due sottocartelle distinte ----
  console.log("[cd] punto 2 — due conversazioni, stesso obiettivo, sottocartelle distinte");
  r = await post("/task", { obiettivo: "Rispondi solo con la parola DUPLICATO_CD" }, TOKEN); // senza campo cwd
  b = await r.json();
  const id2a = b.id; taskCreati.push(id2a);
  r = await post("/task", { obiettivo: "Rispondi solo con la parola DUPLICATO_CD" }, TOKEN);
  b = await r.json();
  const id2b = b.id; taskCreati.push(id2b);
  const sse2a = apriSse(`${BASE}/eventi/${id2a}`);
  const sse2b = apriSse(`${BASE}/eventi/${id2b}`);
  await sse2a.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "2a in attesa");
  await sse2b.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "2b in attesa");
  const duplicati = fs.readdirSync(LAVORI_TEST).filter((f) => f.includes("-rispondi-solo-con-la-parola-duplicato-cd")).sort();
  check("2: due sottocartelle distinte (base e -2)", duplicati.length === 2 && duplicati[0] !== duplicati[1], JSON.stringify(duplicati));
  sse2a.chiudi(); sse2b.chiudi();

  // ---- PUNTO 3: cwd esplicita -> usata com'è, nessuna sottocartella ----
  console.log("[cd] punto 3 — cwd esplicita");
  const subDirPrima = fs.readdirSync(LAVORI_TEST).length;
  r = await post("/task", { obiettivo: "Rispondi solo con la parola ESP_CD", cwd: CWD_ESP }, TOKEN);
  b = await r.json();
  const id3 = b.id; taskCreati.push(id3);
  const sse3 = apriSse(`${BASE}/eventi/${id3}`);
  await sse3.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "3 in attesa");
  const pid3 = pidFiglioPerCwd(CWD_ESP);
  check("3: il figlio usa la cwd esplicita (per pid)", pid3 != null, `pid=${pid3}`);
  check("3: NESSUNA nuova sottocartella creata in LAVORI_DIR", fs.readdirSync(LAVORI_TEST).length === subDirPrima, `${subDirPrima} -> ${fs.readdirSync(LAVORI_TEST).length}`);
  sse3.chiudi();

  // ---- PUNTO 5: /termina su cwd automatica -> riassunto + condensato su disco ----
  console.log("[cd] punto 5 — /termina con riassunto su cwd automatica");
  r = await post("/termina", { taskId: id1 }, TOKEN);
  check("5: /termina -> 200 (riassunto incluso)", r.status === 200, `status=${r.status}`);
  const riassuntoPath = join(cwdAuto1, ".superpi", "riassunto.md");
  const condensatoPath = join(cwdAuto1, ".superpi", "condensato.json");
  check("5: .superpi/riassunto.md esiste e non è vuoto", fs.existsSync(riassuntoPath) && fs.readFileSync(riassuntoPath, "utf8").trim().length > 20, "");
  const contenutoRis = fs.existsSync(riassuntoPath) ? fs.readFileSync(riassuntoPath, "utf8") : "";
  console.log(`  riassunto: ${JSON.stringify(contenutoRis.slice(0, 110))}`);
  check("5: riassunto non è il placeholder di timeout", !contenutoRis.startsWith("_riassunto non disponibile"), "");
  check("5: .superpi/condensato.json esiste e ha almeno 'fatto'", fs.existsSync(condensatoPath) && "fatto" in JSON.parse(fs.readFileSync(condensatoPath, "utf8")), "");
  await post("/scarta", { taskId: id1 }, TOKEN);

  // ---- PUNTO 6: /termina su cwd esplicita -> NESSUN .superpi ----
  console.log("[cd] punto 6 — /termina su cwd esplicita, nessun .superpi");
  r = await post("/termina", { taskId: id3 }, TOKEN);
  check("6: /termina cwd esplicita -> 200", r.status === 200, `status=${r.status}`);
  check("6: nessuna cartella .superpi creata dentro la cwd esplicita", !fs.existsSync(join(CWD_ESP, ".superpi")), "");
  await post("/scarta", { taskId: id3 }, TOKEN);

  // pulizia del resto
  for (const id of [id2a, id2b]) { await post("/termina", { taskId: id }, TOKEN); await post("/scarta", { taskId: id }, TOKEN); }
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(logServer.slice(-700));
  exitCode = 2;
} finally {
  if (TOKEN) {
    for (const id of taskCreati) {
      try { await post("/termina", { taskId: id }, TOKEN); } catch { /* best-effort */ }
      try { await post("/scarta", { taskId: id }, TOKEN); } catch { /* best-effort */ }
    }
  }
  proc.kill("SIGTERM");
  await sleep(600);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

console.log(`\nRISULTATO CARTELLA DEFAULT: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
