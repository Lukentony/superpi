// Riserva OpenRouter (2026-08-18): quando la quota OpenCode Go è esaurita o
// non determinabile, il gate prova OpenRouter prima di rifiutare. OpenCode Go
// resta il primario — comportamento invariato nel caso comune (nessuna
// chiamata a OpenRouter).
// Casi unit (verificaGate con mock iniettati): sotto soglia -> invariato e
// riserva MAI chiamata; sopra/non determinabile + riserva ok -> provider
// openrouter col modello giusto; entrambi ko -> rifiuto fail-closed col
// motivo di oggi.
// Casi server: figlio su OpenCode Go NON porta OPENROUTER_API_KEY (presenza
// verificata senza mai stampare il valore); con quota finta "sopra" il gate
// usa la riserva REALE (OpenRouter vero, credenziale dal vault solo in
// memoria) e il figlio porta la chiave e completa il giro.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { verificaGate } from "../src/gate.mjs";
import { OPENROUTER_MODELLO } from "../src/quota-openrouter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = join(ROOT, ".test-run", "cwd");
fs.mkdirSync(CWD, { recursive: true });

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const quota = (p) => async () => ({ rolling: { percentuale: p, reset_in: 0 }, aggiornato: new Date().toISOString() });
const quotaKo = () => async () => { throw new Error("servizio giù (mock)"); };
const riservaOk = () => async () => ({ ok: true, saldoResiduo: 5.3 });
const riservaKo = () => async () => ({ ok: false, motivo: "OpenRouter: saldo sotto soglia (mock)" });

// ---- CASI UNIT ----
console.log("[or] casi unit — verificaGate con mock");
let chiamateRiserva = 0;
const riservaSpia = () => async () => { chiamateRiserva++; return { ok: true, saldoResiduo: 5.3 }; };
let g = await verificaGate({ cwd: CWD, ottieniQuota: quota(50), verificaRiserva: riservaSpia() });
check("1: quota sotto soglia -> ok e NESSUNA chiamata a OpenRouter", g.ok && chiamateRiserva === 0, JSON.stringify(g));
check("1: caso comune senza provider esplicito (OpenCode Go, invariato)", g.provider === undefined, JSON.stringify(g));

g = await verificaGate({ cwd: CWD, ottieniQuota: quota(95), verificaRiserva: riservaOk() });
check("2: quota sopra soglia + riserva ok -> ok con provider openrouter", g.ok && g.provider === "openrouter", JSON.stringify(g));
check("2: modello giusto per OpenRouter (prefisso provider)", g.modello === OPENROUTER_MODELLO, `modello=${g.modello}`);

g = await verificaGate({ cwd: CWD, ottieniQuota: quotaKo(), verificaRiserva: riservaOk() });
check("3: quota non determinabile + riserva ok -> ok openrouter", g.ok && g.provider === "openrouter", JSON.stringify(g));

g = await verificaGate({ cwd: CWD, ottieniQuota: quota(95), verificaRiserva: riservaKo() });
check("4: entrambi ko -> rifiuto col motivo della quota primaria (fail-closed)", !g.ok && (g.motivo ?? "").includes("quota OpenCode Go"), JSON.stringify(g));
g = await verificaGate({ cwd: CWD, ottieniQuota: quotaKo(), verificaRiserva: riservaKo() });
check("4b: quota non determinabile + riserva ko -> rifiuto 'non determinabile'", !g.ok && (g.motivo ?? "").includes("non determinabile"), JSON.stringify(g));

// ---- CASI SERVER ----
function avviaServer(fake) {
  const proc = spawn("node", [join(ROOT, "src", "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, SUPERPI_PORT: String(PORT), SUPERPI_GATE_QUOTA_FAKE: fake },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logServer = "";
  proc.stdout.on("data", (d) => (logServer += d));
  proc.stderr.on("data", (d) => (logServer += d));
  return { proc, logServer };
}
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
function pidFiglioPerCwd(cwd, serverPid) {
  let r;
  try { r = execFileSync("pgrep", ["-P", String(serverPid)], { encoding: "utf8" }).trim(); } catch { return null; }
  for (const p of r.split("\n")) {
    const pid = Number(p); if (!pid) continue;
    try { if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi" && readlinkSync(`/proc/${pid}/cwd`) === cwd) return pid; } catch { /* sparito */ }
  }
  return null;
}
// la chiave è presente nell'env del figlio? (SOLO presenza, MAI il valore)
function envFiglioHaChiave(pid) {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    return env.includes("OPENROUTER_API_KEY=");
  } catch { return false; }
}
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
const { execFileSync: efs } = { execFileSync }; // noop alias per chiarezza

let exitCode = 0;
let server = null;
let TOKEN = null;
try {
  // caso comune: quota finta 0% -> figlio su OpenCode Go, NIENTE chiave
  console.log("[or] server — caso comune (quota 0%, OpenCode Go)");
  server = avviaServer("1");
  await sleep(1500);
  const html = await (await fetch(`${BASE}/`)).text();
  TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  let r = await post("/task", { obiettivo: "Rispondi solo con la parola GO_OK", cwd: CWD }, TOKEN);
  const b1 = await r.json();
  const sse1 = apriSse(`${BASE}/eventi/${b1.id}`);
  await sse1.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 240000, "giro su OpenCode Go");
  const pidGo = pidFiglioPerCwd(CWD, server.proc.pid);
  check("5: figlio su OpenCode Go trovato (per cwd)", pidGo != null, `pid=${pidGo}`);
  check("5: il figlio OpenCode Go NON porta OPENROUTER_API_KEY", pidGo != null && !envFiglioHaChiave(pidGo), "");
  await post("/termina", { taskId: b1.id }, TOKEN);
  await post("/scarta", { taskId: b1.id }, TOKEN);
  sse1.chiudi();
  server.proc.kill("SIGTERM");
  await sleep(600);
  if (server.proc.exitCode === null) server.proc.kill("SIGKILL");

  // riserva reale: quota finta sopra soglia -> il gate usa OpenRouter VERO
  console.log("[or] server — riserva REALE (quota 95% finta -> OpenRouter vero)");
  server = avviaServer("sopra");
  await sleep(1500);
  const html2 = await (await fetch(`${BASE}/`)).text();
  TOKEN = (html2.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  r = await post("/task", { obiettivo: "Rispondi solo con la parola ROR_OK", cwd: CWD }, TOKEN);
  const b2 = await r.json();
  check("6: /task con quota sopra soglia -> 200 (riserva accettata)", r.status === 200, JSON.stringify(b2).slice(0, 80));
  const sse2 = apriSse(`${BASE}/eventi/${b2.id}`);
  await sse2.attesa((e) => e.tipo === "stato" && e.dati.stato === "in_attesa", 300000, "giro su OpenRouter (riserva reale)");
  const pidOr = pidFiglioPerCwd(CWD, server.proc.pid);
  check("6: figlio (riserva) trovato per cwd", pidOr != null, `pid=${pidOr}`);
  check("6: il figlio della riserva PORTA OPENROUTER_API_KEY (presenza, mai valore)", pidOr != null && envFiglioHaChiave(pidOr), "");
  // provider nel file di sessione (senza stampare nulla di sensibile)
  const sessDir = join(homedir(), ".local", "state", "superpi", "sessions");
  const fSess = join(sessDir, fs.readdirSync(sessDir).find((f) => f.includes(b2.id)));
  const txtSess = fs.readFileSync(fSess, "utf8");
  check("6: il file di sessione mostra il provider openrouter", txtSess.includes('"provider":"openrouter"') || txtSess.includes("openrouter"), "");
  await post("/termina", { taskId: b2.id }, TOKEN);
  await post("/scarta", { taskId: b2.id }, TOKEN);
  sse2.chiudi();
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  if (server) console.error(server.logServer.slice(-600));
  exitCode = 2;
} finally {
  if (server) {
    server.proc.kill("SIGTERM");
    await sleep(500);
    if (server.proc.exitCode === null) server.proc.kill("SIGKILL");
  }
}

console.log(`\nRISULTATO OPENROUTER RISERVA: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
