// Test router LLM (2026-08-27) — deterministico, SENZA spawn di figli reali:
// il classificatore è iniettabile (routeModello accetta `classificatore`), la
// configurazione è letta da un file temporaneo. Copre: schema di risposta
// (un solo profilo), ambiguità/bassa confidenza, fallback (errore/timeout),
// mappa profilo -> provider/model da configurazione locale, default versionati.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estraiProfilo, leggiConfig, routeModello, PROFILI } from "../src/router.mjs";

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}

console.log("[router] === schema di risposta (estraiProfilo) ===");
check("1: profilo unico valido", estraiProfilo("scout") === "scout");
check("1: profilo con spazi/case", estraiProfilo("  STANDARD ") === "standard");
check("1: testo extra -> null (schema stretto)", estraiProfilo("scelgo il profilo long per questo") === null);
check("1: virgolette -> null (schema stretto)", estraiProfilo('"microfix"') === null);
check("1: risposta vuota -> null", estraiProfilo("") === null);
check("1: testo senza profilo -> null", estraiProfilo("non so cosa fare") === null);
check("1: due profili -> null (ambigua/bassa confidenza)", estraiProfilo("scout o microfix") === null, estraiProfilo("scout o microfix"));
check("1: non-string -> null", estraiProfilo(null) === null);
check("1: parola parziale non conta", estraiProfilo("standardizzare") === null, "standardizzare non deve matchare standard");

console.log("[router] === configurazione locale (leggiConfig) ===");
const dir = mkdtempSync(join(tmpdir(), "superpi-router-"));
const cfgPath = join(dir, "router.json");
const d = leggiConfig(join(dir, "inesistente.json"));
check("2: file assente -> default versionati", d.fonte === "default" && d.profili.scout.provider === "openai-codex" && d.profili.scout.model === "gpt-5.6-luna", JSON.stringify(d.profili.scout));

writeFileSync(cfgPath, JSON.stringify({
  modelloRouter: { provider: "non-ammesso", model: "non-ammesso" },
  profili: {
    scout: { provider: "openai-codex", model: "gpt-5.6-luna" },
    microfix: { provider: "openai-codex", model: "gpt-5.6-luna" },
    standard: { provider: "openai-codex", model: "gpt-5.6-luna" },
    long: { provider: "openai-codex", model: "gpt-5.6-luna" },
  },
}));
const l = leggiConfig(cfgPath);
check("2: file locale letto", l.fonte === "locale");
check("2: modello router fisso su Codex Luna", l.modelloRouter.provider === "openai-codex" && l.modelloRouter.model === "gpt-5.6-luna", JSON.stringify(l.modelloRouter));
check("2: mappa profili locale corretta", l.profili.standard.provider === "openai-codex" && l.profili.standard.model === "gpt-5.6-luna", JSON.stringify(l.profili.standard));
check("2: microfix -> Codex Luna", l.profili.microfix.provider === "openai-codex" && l.profili.microfix.model === "gpt-5.6-luna");

writeFileSync(cfgPath, JSON.stringify({ profili: { scout: { provider: "", model: "" } } }));
const mal = leggiConfig(cfgPath);
check("2: profilo mal formato -> ricade sul default (mai valore libero)", mal.profili.scout.provider === "openai-codex" && mal.profili.scout.model === "gpt-5.6-luna", JSON.stringify(mal.profili.scout));

writeFileSync(cfgPath, "non-json{{{");
check("2: file non-JSON -> default", leggiConfig(cfgPath).fonte === "default");

console.log("[router] === routeModello (classificatore iniettabile) ===");
const cls = (testo) => async () => testo;
const configUguale = {
  profili: Object.fromEntries(PROFILI.map((p) => [p, { provider: "same-provider", model: "same-model" }])),
  get modelloRouter() { throw new Error("il router LLM non deve essere creato"); },
};
const rLocale = await routeModello("x", { config: configUguale });
check("3: profili uguali -> standard locale senza router", rLocale.ok && rLocale.profilo === "standard" && rLocale.provider === "same-provider" && rLocale.model === "same-model", JSON.stringify(rLocale));
let chiamateUguale = 0;
const rIniettatoUguale = await routeModello("x", {
  config: configUguale,
  classificatore: async () => { chiamateUguale++; return "scout"; },
});
check("3: classificatore iniettato usato anche con profili uguali", chiamateUguale === 1 && rIniettatoUguale.ok && rIniettatoUguale.profilo === "scout", JSON.stringify(rIniettatoUguale));
const profiliDifferenziati = Object.fromEntries(PROFILI.map((p) => [p, { provider: "same-provider", model: "same-model" }]));
profiliDifferenziati.long = { provider: "other-provider", model: "other-model" };
let chiamateDifferenziata = 0;
const rDifferenziata = await routeModello("x", {
  config: { profili: profiliDifferenziati },
  classificatore: async () => { chiamateDifferenziata++; return "long"; },
});
check("3: profili differenziati -> usa il classificatore", chiamateDifferenziata === 1 && rDifferenziata.ok && rDifferenziata.profilo === "long" && rDifferenziata.provider === "other-provider" && rDifferenziata.model === "other-model", JSON.stringify(rDifferenziata));
check("3: scout -> Codex Luna", (await routeModello("x", { classificatore: cls("scout") })).provider === "openai-codex" && (await routeModello("x", { classificatore: cls("scout") })).model === "gpt-5.6-luna");
check("3: microfix -> Codex Luna", (await routeModello("x", { classificatore: cls("microfix") })).provider === "openai-codex" && (await routeModello("x", { classificatore: cls("microfix") })).model === "gpt-5.6-luna");
check("3: standard -> Codex Luna", (await routeModello("x", { classificatore: cls("standard") })).provider === "openai-codex" && (await routeModello("x", { classificatore: cls("standard") })).model === "gpt-5.6-luna");
check("3: long -> Codex Luna", (await routeModello("x", { classificatore: cls("long") })).provider === "openai-codex" && (await routeModello("x", { classificatore: cls("long") })).model === "gpt-5.6-luna");
const rOk = await routeModello("x", { classificatore: cls("standard") });
check("3: esito ok porta profilo+provider+model", rOk.ok && rOk.profilo === "standard" && rOk.provider === "openai-codex" && rOk.model === "gpt-5.6-luna", JSON.stringify(rOk));

check("3: profilo sconosciuto -> ok:false", !(await routeModello("x", { classificatore: cls("banana") })).ok);
check("3: ambigua (due profili) -> ok:false", !(await routeModello("x", { classificatore: cls("scout o long") })).ok);
check("3: risposta vuota -> ok:false", !(await routeModello("x", { classificatore: cls("") })).ok);
check("3: obiettivo vuoto -> ok:false", !(await routeModello("   ", { classificatore: cls("scout") })).ok);
const rThrow = await routeModello("x", { classificatore: async () => { throw new Error("provider giù"); } });
check("3: classificatore che lancia -> ok:false col motivo", !rThrow.ok && rThrow.motivo.includes("router fallito"), JSON.stringify(rThrow));
const rTimeout = await routeModello("x", { classificatore: async () => { throw new Error("TIMEOUT 10ms: router"); } });
check("3: timeout del router -> ok:false (nessuno spawn)", !rTimeout.ok && rTimeout.motivo.includes("TIMEOUT"), JSON.stringify(rTimeout));

// configurazione custom: la mappa profilo->modello viene DAVVERO dalla config
writeFileSync(cfgPath, JSON.stringify({
  profili: { scout: { provider: "custom-prov", model: "custom-model" } },
}));
const cfg = leggiConfig(cfgPath);
const rCustom = await routeModello("x", { config: cfg, classificatore: cls("scout") });
check("4: mappa profilo->modello dalla configurazione (non dal codice)", rCustom.ok && rCustom.provider === "custom-prov" && rCustom.model === "custom-model", JSON.stringify(rCustom));
const rDefault = await routeModello("x", { config: cfg, classificatore: cls("standard") });
check("4: profilo mancante in config custom -> ricade sul default", rDefault.ok && rDefault.provider === "openai-codex" && rDefault.model === "gpt-5.6-luna", JSON.stringify(rDefault));

check("PROFILI esporta esattamente i 4 profili validati", JSON.stringify(PROFILI) === JSON.stringify(["scout", "microfix", "standard", "long"]), JSON.stringify(PROFILI));

rmSync(dir, { recursive: true, force: true });
console.log(`\nRISULTATO TEST ROUTER: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
