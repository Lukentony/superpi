// Riserva OpenRouter (2026-08-18, aggiornata 2026-08-27): verificaGate resta
// il gate di /riprendi (cwd + quota OpenCode Go + riserva OpenRouter). Il
// percorso /task NON usa più verificaGate: il router LLM sceglie il profilo
// (GLM 5.3) e la riserva OpenRouter DSV4 non è estesa ai figli /task
// (vedi src/router.mjs e scripts/test-router.mjs). Il caso E2E "riserva reale
// via /task" è quindi rimosso: sarebbe passato da /riprendi (sessione reale da
// riprendere), non da /task. Restano i casi unit di verificaGate con mock
// iniettati, che coprono la logica della riserva indipendentemente dal percorso.
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { verificaGate } from "../src/gate.mjs";
import { OPENROUTER_MODELLO } from "../src/quota-openrouter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CWD = join(ROOT, ".test-run", "cwd");
fs.mkdirSync(CWD, { recursive: true });

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}

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

console.log(`\nRISULTATO OPENROUTER RISERVA: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
