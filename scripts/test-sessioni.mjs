// Test pannello sessioni (passo A) e ripresa (passo B) — regressione via HTTP.
// MAI tocca finestre vere: il caso "bottone su finestra pi reale" è verificato
// dal vivo con una finestra di test dedicata (2026-08-12); qui si verifica la
// struttura dell'endpoint e i rifiuti, che non hanno effetti collaterali.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

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

let exitCode = 0;
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) break;
    } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const html = await (await fetch(`${BASE}/`)).text();
  const TOKEN = (html.match(/<meta name="csrf-token" content="([0-9a-f]{64})">/) ?? [])[1];
  check("token CSRF dalla pagina", !!TOKEN);

  console.log("[sessioni] passo A — GET /sessioni");
  let r = await fetch(`${BASE}/sessioni`);
  check("A: senza CSRF → 401", r.status === 401, `status=${r.status}`);

  r = await fetch(`${BASE}/sessioni`, { headers: { "X-CSRF-Token": TOKEN } });
  const lista = await r.json();
  check("A: con CSRF → 200", r.status === 200, `status=${r.status}`);
  check("A: lettaIl presente (principio 4: dato datato)", typeof lista.lettaIl === "string" && !Number.isNaN(Date.parse(lista.lettaIl)));
  check("A: almeno una finestra pi reale in lista", (lista.finestre ?? []).some((v) => v.cmd === "pi"), JSON.stringify(lista.finestre ?? []));
  check(
    "A: ogni voce ha i campi base (nome, cmd, pid, snippet, eta)",
    (lista.finestre ?? []).every((v) => v.nome && v.cmd && typeof v.snippet === "string" && v.etaMs != null),
    JSON.stringify((lista.finestre ?? [])[0]),
  );
  check(
    "A: ogni finestra pi ha sessioneId o motivoNoId (mai nessuno dei due)",
    (lista.finestre ?? []).filter((v) => v.cmd === "pi").every((v) => v.sessioneId || v.motivoNoId),
  );
  check("A: claude agents incluso (array)", Array.isArray(lista.claude), JSON.stringify(lista.claude));

  console.log("[sessioni] passo B — POST /riprendi (solo rifiuti innocui)");
  r = await fetch(`${BASE}/riprendi`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ finestra: "x" }),
  });
  check("B: senza CSRF → 401", r.status === 401, `status=${r.status}`);

  r = await fetch(`${BASE}/riprendi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": TOKEN },
    body: JSON.stringify({ finestra: "sessione-inesistente:finestra" }),
  });
  const b404 = await r.json();
  check("B: finestra inesistente → 404 col motivo", r.status === 404 && (b404.errore ?? "").includes("non trovata"), JSON.stringify(b404));

  // finestra claude reale: rifiuto PRIMA di qualunque kill (nessun effetto)
  const claudeFinestra = (lista.finestre ?? []).find((v) => v.cmd === "claude");
  if (claudeFinestra) {
    r = await fetch(`${BASE}/riprendi`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": TOKEN },
      body: JSON.stringify({ finestra: claudeFinestra.nome }),
    });
    const bClaude = await r.json();
    check("B: finestra claude → 400 (controllo solo per pi), nessun kill", r.status === 400 && (bClaude.errore ?? "").includes("non è una sessione pi"), JSON.stringify(bClaude));
  } else {
    console.log("  (nessuna finestra claude in lista: check saltato)");
  }
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(logServer.slice(-1500));
  exitCode = 2;
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

console.log(`\nRISULTATO TEST SESSIONI: ${exitCode === 0 && nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(exitCode === 0 && nFail === 0 ? 0 : 1);
