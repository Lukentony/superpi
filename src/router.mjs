// Router LLM automatico (2026-08-27): sceglie il profilo del figlio a partire
// da obiettivo + metadati minimi, con un figlio Pi SENZA tool (--no-tools) su
// GLM 5.3. Il router può restituire SOLO un profilo validato
// (scout|microfix|standard|long): mai provider o nome modello liberi. La mappa
// profilo -> (provider, modello) vive in configurazione LOCALE senza
// credenziali (default = router.example.json versionato). Output invalido,
// timeout o risposta ambigua (bassa confidenza) -> { ok:false }: il chiamante
// NON avvia il figlio e mostra la scelta fallita.
//
// Profili decisi (vault lavori/superpi.md):
//   tutti i profili -> Codex Luna.
//   Mistral resta fuori dal percorso automatico: solo micro-task rapidi espliciti.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { creaFiglio, avviaFiglio, promptEAttendi, fermaFiglio } from "./spawner.mjs";

const PROFILI_DEFAULT = {
  scout: { provider: "openai-codex", model: "gpt-5.6-luna" },
  microfix: { provider: "openai-codex", model: "gpt-5.6-luna" },
  standard: { provider: "openai-codex", model: "gpt-5.6-luna" },
  long: { provider: "openai-codex", model: "gpt-5.6-luna" },
};
const ROUTER_MODEL_DEFAULT = { provider: "openai-codex", model: "gpt-5.6-luna" };

export const PROFILI = Object.freeze(Object.keys(PROFILI_DEFAULT));

const STATO_DIR = join(homedir(), ".local", "state", "superpi");
const ROUTER_CWD = join(STATO_DIR, "router");
const ROUTER_SESSION_DIR = join(STATO_DIR, "router-sessions");
const CONFIG_PATH = process.env.SUPERPI_ROUTER_CONFIG ?? join(homedir(), ".config", "superpi", "router.json");

// Valida un {provider, model} come coppia di stringhe non vuote.
function coppiaValida(v) {
  return v && typeof v.provider === "string" && typeof v.model === "string" && v.provider && v.model;
}

function profiliOmogenei(config) {
  const standard = config?.profili?.standard;
  return coppiaValida(standard) && PROFILI.every((p) => {
    const voce = config.profili?.[p];
    return coppiaValida(voce)
      && voce.provider === standard.provider
      && voce.model === standard.model;
  });
}

// Legge la configurazione locale; se assente o illeggibile usa i default
// versionati. La forma viene validata profilo per profilo: un profilo mal
// formato ricade sul default, mai su un valore libero.
export function leggiConfig(percorso = CONFIG_PATH) {
  if (!existsSync(percorso)) return { fonte: "default", profili: { ...PROFILI_DEFAULT }, modelloRouter: { ...ROUTER_MODEL_DEFAULT } };
  try {
    const raw = JSON.parse(readFileSync(percorso, "utf8"));
    const profili = {};
    for (const p of PROFILI) {
      profili[p] = coppiaValida(raw?.profili?.[p]) ? { provider: raw.profili[p].provider, model: raw.profili[p].model } : { ...PROFILI_DEFAULT[p] };
    }
    // Il modello del router è fisso per decisione di piano: la configurazione
    // locale può cambiare solo la mappa dei profili, mai il classificatore.
    return { fonte: "locale", profili, modelloRouter: { ...ROUTER_MODEL_DEFAULT } };
  } catch {
    return { fonte: "default", profili: { ...PROFILI_DEFAULT }, modelloRouter: { ...ROUTER_MODEL_DEFAULT } };
  }
}

// Estrazione + validazione dello schema di risposta: il router deve restituire
// ESATTAMENTE una delle quattro stringhe dell'enum. Frasi, virgolette,
// punteggiatura, due profili o testo extra = risposta invalida/ambigua
// (bassa confidenza, nessuno spawn).
export function estraiProfilo(testo) {
  if (typeof testo !== "string") return null;
  const t = testo.trim().toLowerCase();
  return PROFILI.includes(t) ? t : null;
}

function promptDiRouting(obiettivo, metadati = {}) {
  const cwdAutomatica = metadati?.cwdAutomatica === true ? "sì" : "no";
  return [
    "Sei un router. Classifica il compito di coding qui sotto in UNO SOLO di questi profili:",
    ...PROFILI.map((p) => `- ${p}`),
    "",
    "Regole: rispondi con il SOLO nome del profilo scelto, una parola, senza",
    "spiegazioni, senza virgolette, senza punteggiatura. Se il compito non è di",
    "coding, scegli comunque il profilo più vicino.",
    `Metadato minimo: cwd automatica = ${cwdAutomatica}.`,
    "",
    `Compito: ${obiettivo}`,
  ].join("\n");
}

// Classificatore reale: un figlio Pi SENZA tool, a cui viene chiesto solo il
// profilo. Restituisce il testo dell'ultima risposta assistente (o lancia su
// timeout/errore di spawn).
async function classificaConPi(obiettivo, metadati, config, timeoutMs) {
  mkdirSync(ROUTER_CWD, { recursive: true });
  mkdirSync(ROUTER_SESSION_DIR, { recursive: true });
  const figlio = creaFiglio({
    cwd: ROUTER_CWD,
    nome: "router",
    sessionDir: ROUTER_SESSION_DIR,
    provider: config.modelloRouter.provider,
    model: config.modelloRouter.model,
    timeoutMs,
    extraArgs: ["--no-tools", "-a"],
  });
  try {
    await avviaFiglio(figlio, timeoutMs);
    await promptEAttendi(figlio, promptDiRouting(obiettivo, metadati), timeoutMs);
    return await figlio.client.getLastAssistantText();
  } finally {
    await fermaFiglio(figlio);
  }
}

// routeModello(obiettivo, opts) -> { ok:true, profilo, provider, model }
//                                 | { ok:false, motivo }
// `classificatore` iniettabile (test deterministici, nessuno spawn reale):
// riceve (obiettivo, metadati) e ritorna il testo della risposta del router.
export async function routeModello(obiettivo, { metadati = {}, config = leggiConfig(), classificatore = null, timeoutMs = Number(process.env.SUPERPI_ROUTER_TIMEOUT_MS ?? 90000) } = {}) {
  if (!obiettivo || typeof obiettivo !== "string" || !obiettivo.trim()) {
    return { ok: false, motivo: "obiettivo vuoto: routing impossibile" };
  }
  if (!classificatore && profiliOmogenei(config)) {
    const voce = config.profili.standard;
    return { ok: true, profilo: "standard", provider: voce.provider, model: voce.model };
  }
  let testo;
  if (classificatore) {
    try {
      testo = await classificatore(obiettivo, metadati);
    } catch (e) {
      return { ok: false, motivo: `router fallito: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else {
    try {
      testo = await classificaConPi(obiettivo, metadati, config, timeoutMs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, motivo: msg.startsWith("TIMEOUT") ? `timeout del router (${timeoutMs}ms)` : `router fallito: ${msg}` };
    }
  }
  const profilo = estraiProfilo(testo);
  if (!profilo) {
    return { ok: false, motivo: "risposta del router non valida o ambigua (nessun profilo univoco riconosciuto)" };
  }
  const voce = config.profili[profilo];
  if (!voce) {
    return { ok: false, motivo: `profilo "${profilo}" assente dalla configurazione` };
  }
  return { ok: true, profilo, provider: voce.provider, model: voce.model };
}
