// Test Fase 4 — gate di ammissione v1: controllo cwd (realpath, mai $HOME
// esatta, mai dentro hive) + quota OpenCode Go rolling 5h oltre soglia.
// Contratto: {ok:true} o {ok:false, motivo} — mai eccezioni silenziose.
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { verificaCwd, verificaQuota, verificaGate } from "../src/gate.mjs";
import { estraiDallaPagina } from "../src/quota-go.mjs";
import { OPENROUTER_MODELLO } from "../src/quota-openrouter.mjs";
import { CWD_DIR } from "./_paths.mjs";

fs.mkdirSync(CWD_DIR, { recursive: true });
const HOME = os.homedir();
const HIVE = join(HOME, "hive");

let exitCode = 0;
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

console.log("[fase4] === controllo cwd (realpath) ===");

let r = verificaCwd(CWD_DIR);
check("cwd sicura (.test-run/cwd) passa", r.ok === true, JSON.stringify(r));

r = verificaCwd(".test-run/cwd"); // path relativo: risolve contro la cwd del processo
check("cwd relativa passa", r.ok === true, JSON.stringify(r));

r = verificaCwd(HOME);
check("$HOME esatta rifiutata", r.ok === false && r.motivo.includes("$HOME"), JSON.stringify(r));

r = verificaCwd(join(HIVE, "appunti"));
check(
  "dentro hive rifiutata",
  r.ok === false && r.motivo.includes("dentro hive") && r.motivo.includes(HIVE),
  JSON.stringify(r),
);

r = verificaCwd(HIVE);
check("radice di hive rifiutata", r.ok === false && r.motivo.includes("radice di hive"), JSON.stringify(r));

r = verificaCwd(join(HIVE, "appunti", "..")); // .. che risolve nella radice di hive
check(".. che risolve in hive rifiutata", r.ok === false, JSON.stringify(r));

r = verificaCwd(join(CWD_DIR, "..")); // .. che risolve in .test-run (sicura)
check(".. che risolve in zona sicura passa", r.ok === true, JSON.stringify(r));

r = verificaCwd(join(CWD_DIR, "non-esiste-xyz"));
check(
  "cwd inesistente rifiutata con motivo",
  r.ok === false && r.motivo.includes("non risolvibile"),
  JSON.stringify(r),
);

console.log("[fase4] === quota: parser (fixture, nessuna rete) ===");

const HTML_FIXTURE = `<!doctype html><html><head><script>
function _init() {
  const a = 1;
  rollingUsage:$R[36]={status:"ok",resetInSec:4321,usagePercent:45.23};
  weeklyUsage:$R[37]={status:"ok",resetInSec:900000,usagePercent:12.5};
  monthlyUsage:$R[38]={status:"ok",resetInSec:99999999,usagePercent:30};
}
</script></head><body></body></html>`;

// Il formato della pagina vera (verificato dal vivo il 2026-08-11) ha chiavi
// SENZA virgolette (oggetto JS, non JSON): il fixture lo rispecchia.

const usoFixture = estraiDallaPagina(HTML_FIXTURE);
check(
  "parser: rolling 45% / reset 4321s",
  usoFixture.rolling?.percentuale === 45 && usoFixture.rolling?.reset_in === 4321,
  JSON.stringify(usoFixture),
);
check(
  "parser: weekly e monthly presenti",
  usoFixture.weekly?.percentuale === 13 && usoFixture.monthly?.percentuale === 30,
  JSON.stringify(usoFixture),
);

console.log("[fase4] === quota: soglia (verificaQuota, pura) ===");

r = verificaQuota({ rolling: { percentuale: 45, reset_in: 4321 }, aggiornato: new Date().toISOString() });
check("45% sotto soglia passa", r.ok === true && r.quota.percentuale === 45, JSON.stringify(r));

r = verificaQuota({ rolling: { percentuale: 95, reset_in: 60 }, aggiornato: new Date().toISOString() });
check(
  "95% oltre soglia rifiutata col motivo esatto",
  r.ok === false && r.motivo.includes("95%") && r.motivo.includes("soglia 80"),
  JSON.stringify(r),
);

r = verificaQuota({ rolling: { percentuale: 80, reset_in: 60 }, aggiornato: new Date().toISOString() });
check("80% esatto (non oltre) passa", r.ok === true, JSON.stringify(r));

r = verificaQuota({ weekly: { percentuale: 10, reset_in: 1 }, aggiornato: new Date().toISOString() });
check(
  "rolling mancante → rifiuto esplicito, non silenzioso",
  r.ok === false && r.motivo.includes("non determinabile"),
  JSON.stringify(r),
);

console.log("[fase4] === gate combinato (quota iniettata) ===");

const fakeQuota = async () => ({ rolling: { percentuale: 45, reset_in: 4321 }, aggiornato: new Date().toISOString() });
// Riserva OpenRouter (2026-08-18): nei test di rifiuto la riserva va iniettata
// KO — il fail-closed è il comportamento SOLO quando anche la riserva fallisce;
// senza mock uscirebbe la riserva VERA (saldo reale) e il gate passerebbe.
const riservaKo = async () => ({ ok: false, motivo: "riserva ko (mock)" });
let chiamateRiserva = 0;
const riservaSpia = () => async () => {
  chiamateRiserva++;
  return { ok: true, saldoResiduo: 5.3 };
};
r = await verificaGate({ cwd: CWD_DIR, ottieniQuota: fakeQuota, verificaRiserva: riservaKo });
check("cwd sicura + quota 45% → ok", r.ok === true, JSON.stringify(r));

r = await verificaGate({ cwd: CWD_DIR, sogliaPercentuale: 80, ottieniQuota: async () => ({ rolling: { percentuale: 95, reset_in: 60 }, aggiornato: new Date().toISOString() }), verificaRiserva: riservaKo });
check("quota 95% → rifiuto col motivo quota (anche con riserva ko)", r.ok === false && r.motivo.includes("quota"), JSON.stringify(r));

r = await verificaGate({ cwd: HOME, ottieniQuota: fakeQuota, verificaRiserva: riservaKo });
check("cwd $HOME vince sulla quota (primo controllo)", r.ok === false && r.motivo.includes("$HOME"), JSON.stringify(r));

r = await verificaGate({
  cwd: CWD_DIR,
  ottieniQuota: async () => {
    throw new Error("HTTP 401: cookie auth scaduto o non valido");
  },
  verificaRiserva: riservaKo,
});
check(
  "quota non determinabile → fail-closed con motivo, mai silenzio",
  r.ok === false && r.motivo.includes("non determinabile") && r.motivo.includes("HTTP 401"),
  JSON.stringify(r),
);

console.log("[fase4] === riserva OpenRouter: mock puri, nessuna rete/credenziale ===");

// Prima di qui c'era un blocco "quota vera (live)" che chiamava
// verificaGate({ cwd: CWD_DIR }) senza iniettare ottieniQuota/verificaRiserva:
// con la riserva OpenRouter (2026-08-18) questo scatena rete vera verso
// opencode.ai e, se quella fallisce, verso OpenRouter (con un helper esterno
// openrouter` in chiaro nell'ambiente) — non deterministico, e capace di far
// passare il gate per davvero, rompendo l'assert "rifiuto esplicito" scritta
// prima che la riserva esistesse (audit hive 2026-08-20, punto 5). Rimosso:
// il comportamento va verificato con mock, come nel resto del file e come già
// fatto in scripts/test-openrouter-riserva.mjs (le sue "CASI SERVER" restano
// l'unico punto che parla per davvero con OpenCode Go/OpenRouter, fuori da
// `npm run verify`).

r = await verificaGate({ cwd: CWD_DIR, ottieniQuota: fakeQuota, verificaRiserva: riservaSpia() });
check(
  "primaria sotto soglia → ok, riserva MAI interrogata (caso comune)",
  r.ok === true && r.provider === undefined && chiamateRiserva === 0,
  `${JSON.stringify(r)} chiamateRiserva=${chiamateRiserva}`,
);

const riservaOk = async () => ({ ok: true, saldoResiduo: 5.3 });

r = await verificaGate({
  cwd: CWD_DIR,
  sogliaPercentuale: 80,
  ottieniQuota: async () => ({ rolling: { percentuale: 95, reset_in: 60 }, aggiornato: new Date().toISOString() }),
  verificaRiserva: riservaOk,
});
check(
  "primaria sopra soglia + riserva ok → ok, provider openrouter",
  r.ok === true && r.provider === "openrouter" && r.modello === OPENROUTER_MODELLO,
  JSON.stringify(r),
);

r = await verificaGate({
  cwd: CWD_DIR,
  ottieniQuota: async () => {
    throw new Error("HTTP 401: cookie auth scaduto o non valido");
  },
  verificaRiserva: riservaOk,
});
check(
  "primaria non determinabile + riserva ok → ok, provider openrouter",
  r.ok === true && r.provider === "openrouter" && r.modello === OPENROUTER_MODELLO,
  JSON.stringify(r),
);

console.log(`\nRISULTATO FASE 4: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
