// Fase 9 — server web di superPi (v1, un figlio alla volta).
// Node http puro + Server-Sent Events: nessuna dipendenza nuova.
//
// Endpoint:
//   GET  /                 → la pagina (src/pagina.html, token CSRF iniettato)
//   POST /task             → {obiettivo, cwd, profilo?} + header X-CSRF-Token
//                            (verificaCwd + router LLM prima di spawnare;
//                            un figlio alla volta)
//   GET  /eventi/<task-id> → stream SSE: grezzo (righe scriba in tempo reale),
//                            dialogo (extension_ui_request confirm/select),
//                            condensato (a fine compito), stato, errore
//   POST /rispondi         → {id, confirmed} o {id, value} + header X-CSRF-Token
//   GET  /sessioni         → sessioni esistenti (agenti Herdr pi/claude +
//                            claude agents --json), sola lettura, CSRF richiesto
//   POST /riprendi         → {finestra, obiettivo?} + CSRF: kill del processo pi
//                            della finestra e avviaTask con --session <id> invece
//                            di un --session-id nuovo (stesso task/SSE/dialoghi)
//   POST /messaggio        → {testo} + CSRF: chat continua — manda un messaggio
//                            al figlio ESISTENTE (mai uno nuovo); se un giro è in
//                            corso il messaggio va in coda e parte a fine giro
//   POST /termina          → CSRF: ferma il figlio, stato "finito", condensato
//                            finale, chiude le SSE. Unico modo normale di chiusura
//
// Ciclo di vita (chat continua, 2026-08-12): il figlio resta VIVO dopo ogni
// giro (stato "in_attesa"); si ferma solo su /termina o su errore vero.
//
// Correlazione finestra ↔ file di sessione (scelta motivata nel report): la
// cmdline del processo pi è solo "pi" (process.title) e il file non è tenuto
// aperto — l'unica via è temporale: il file più vicino all'orario di avvio del
// processo nella cartella di default per la sua cwd
// (~/.pi/agent/sessions/<cwd-sanitizzato>/), verificata a ~2s di precisione
// sulle sessioni reali del 2026-08-12. Limiti dichiarati: sessioni avviate con
// --session-dir custom non correlate (bottone assente col motivo); ambiguità
// se due finestre nella stessa cwd partono a meno di 15 min l'una dall'altra.
import http from "node:http";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  existsSync,
  writeFileSync,
  chmodSync,
  realpathSync,
  statSync,
  rmdirSync,
  readdirSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  creaFiglio,
  avviaFiglio,
  promptEAttendi,
  fermaFiglio,
} from "./spawner.mjs";
import { creaScriba, validaModalitaScriba } from "./scriba.mjs";
import { condensa } from "./condensatore.mjs";
import { verificaCwd, verificaGate } from "./gate.mjs";
import {
  leggiCredenzialeOpenRouter,
  OPENROUTER_VARIABILE,
} from "./quota-openrouter.mjs";
import { leggiSessioni, risolviFinestra, staLavorando } from "./sessioni.mjs";
import { routeModello, PROFILI, leggiConfig } from "./router.mjs";

// Test-only: SUPERPI_GATE_QUOTA_FAKE — "1" quota finta a 0% (caso comune), "sopra"
// quota finta sopra soglia (per testare la riserva OpenRouter senza toccare la
// quota reale). La quota reale è coperta da test-fase4 col mock iniettabile.
const GATE_QUOTA_FAKE = process.env.SUPERPI_GATE_QUOTA_FAKE;
async function gateOk(cwd, permettiHive) {
  return verificaGate({
    cwd,
    hiveRoot: PROTECTED_ROOT,
    permettiHive,
    ottieniQuota: GATE_QUOTA_FAKE
      ? async () => ({
          rolling: {
            percentuale: GATE_QUOTA_FAKE === "sopra" ? 95 : 0,
            reset_in: 0,
          },
          aggiornato: new Date().toISOString(),
        })
      : undefined,
  });
}

// Router LLM (2026-08-27): sceglie il profilo del figlio da obiettivo. La
// cwd resta protetta da verificaCwd; la quota OpenCode Go NON è il gate
// dei figli /task: tutti i profili del router usano Codex Luna. La riserva
// OpenRouter resta disponibile solo per sessioni legacy su /riprendi.
// `profiloEsplicito` (campo opzionale del body) salta il router: override
// esplicito validato. SUPERPI_ROUTER_FAKE (solo test) fissa un profilo senza
// spawnare il router (stesso stile di SUPERPI_GATE_QUOTA_FAKE).
const ROUTER_FAKE = process.env.SUPERPI_ROUTER_FAKE;
const ROUTER_CONFIG = leggiConfig();

async function scegliModello(
  obiettivo,
  profiloEsplicito,
  cwdAutomatica = false,
) {
  if (profiloEsplicito != null) {
    if (!PROFILI.includes(profiloEsplicito)) {
      return {
        ok: false,
        motivo: `profilo sconosciuto "${profiloEsplicito}" (validi: ${PROFILI.join(", ")})`,
      };
    }
    const v = ROUTER_CONFIG.profili[profiloEsplicito];
    return {
      ok: true,
      profilo: profiloEsplicito,
      provider: v.provider,
      model: v.model,
    };
  }
  if (ROUTER_FAKE) {
    if (!PROFILI.includes(ROUTER_FAKE)) {
      return {
        ok: false,
        motivo: `SUPERPI_ROUTER_FAKE sconosciuto "${ROUTER_FAKE}"`,
      };
    }
    const v = ROUTER_CONFIG.profili[ROUTER_FAKE];
    return {
      ok: true,
      profilo: ROUTER_FAKE,
      provider: v.provider,
      model: v.model,
    };
  }
  return routeModello(obiettivo, {
    config: ROUTER_CONFIG,
    metadati: { cwdAutomatica },
  });
}

// Riserva OpenRouter (2026-08-18): se il gate ha scelto openrouter, il figlio
// va spawnato con la credenziale NEL NOME GIUSTO (OPENROUTER_API_KEY — bridging:
// nel vault è OPENROUTER_API_TOKEN) e SOLO in quel caso: i figli su OpenCode Go
// non si portano dietro una variabile che non gli serve. Il valore transita
// solo in memoria (subprocesso dell'helper esterno) e non esce mai da qui.
async function envFiglioPerProvider(gate) {
  if (gate?.provider !== "openrouter") return undefined;
  const { valore } = leggiCredenzialeOpenRouter();
  return { [OPENROUTER_VARIABILE]: valore };
}

function numeroConfigurazione(
  nome,
  valore,
  { intero = false, minimo = 0, massimo = Infinity } = {},
) {
  const n = Number(valore);
  if (
    !Number.isFinite(n) ||
    n < minimo ||
    n > massimo ||
    (intero && !Number.isInteger(n))
  ) {
    throw new Error(
      `Configurazione ${nome} non valida: atteso ${intero ? "un intero" : "un numero finito"} ${minimo > 0 ? `positivo (>= ${minimo})` : `>= ${minimo}`}${Number.isFinite(massimo) ? ` e <= ${massimo}` : ""}`,
    );
  }
  return n;
}

const PORT = numeroConfigurazione(
  "SUPERPI_PORT",
  process.env.SUPERPI_PORT ?? 8787,
  { intero: true, minimo: 1, massimo: 65535 },
);
const HOST = "127.0.0.1"; // MAI 0.0.0.0 — la sicurezza sta qui + CSRF, non in tailscale serve
const STATO_DIR = join(homedir(), ".local", "state", "superpi");
const NOTE_DIR = join(STATO_DIR, "note");
const SESSION_DIR = join(STATO_DIR, "sessions");
// Cartella di lavoro di DEFAULT (Pezzo A, 2026-08-17): un posto solo lato
// server. Se il corpo di /task non porta una cwd (o porta il valore leggibile
// di default della pagina), postTask crea una sottocartella dedicata qui dentro.
const LAVORI_DIR =
  process.env.SUPERPI_LAVORI_DIR ?? join(homedir(), "lavori-superpi");
// Optional protected root. Public installs have no vault convention; callers
// that want the original hive safety rule configure this explicitly.
const PROTECTED_ROOT = process.env.SUPERPI_PROTECTED_ROOT?.trim() || null;
const TASK_TIMEOUT_MS = numeroConfigurazione(
  "SUPERPI_TASK_TIMEOUT_MS",
  process.env.SUPERPI_TASK_TIMEOUT_MS ?? 30 * 60 * 1000,
  { minimo: 1 },
);
const MAX_CONVERSAZIONI = numeroConfigurazione(
  "SUPERPI_MAX_CONVERSAZIONI",
  process.env.SUPERPI_MAX_CONVERSAZIONI ?? 4,
  { intero: true, minimo: 1 },
);
const LOG_MODE = (() => {
  const valore = process.env.SUPERPI_LOG_MODE ?? "metadata";
  try {
    return validaModalitaScriba(valore);
  } catch {
    throw new Error(
      `Configurazione SUPERPI_LOG_MODE non valida: ${valore} (validi: metadata, full, off)`,
    );
  }
})();
const LOG_RETENTION_DAYS = numeroConfigurazione(
  "SUPERPI_LOG_RETENTION_DAYS",
  process.env.SUPERPI_LOG_RETENTION_DAYS ?? 0,
  { intero: true, minimo: 0 },
);
const MAX_BODY = 64 * 1024;
const MAX_OBIETTIVO = 4000;

const AUTH_USER_RAW = process.env.SUPERPI_AUTH_USER;
const AUTH_PASSWORD = process.env.SUPERPI_AUTH_PASSWORD;
const AUTH_CONFIGURED =
  AUTH_USER_RAW !== undefined || AUTH_PASSWORD !== undefined;
const AUTH_USER = AUTH_USER_RAW?.trim() ?? "";
if (AUTH_CONFIGURED && (!AUTH_USER || !AUTH_PASSWORD)) {
  throw new Error(
    "Configurazione auth non valida: SUPERPI_AUTH_USER e SUPERPI_AUTH_PASSWORD devono essere impostati entrambi e non vuoti",
  );
}
const AUTH_ENABLED = AUTH_CONFIGURED;
const AUTH_HEADER = AUTH_ENABLED
  ? `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`, "utf8").toString("base64")}`
  : null;

// I figli e le librerie che creano file ereditano un umask restrittivo; i file
// gestiti direttamente dal server specificano inoltre esplicitamente 0600.
process.umask(0o077);

function creaDirPrivata(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function pulisciNoteScadute() {
  if (LOG_RETENTION_DAYS === 0 || !lstatSync(NOTE_DIR).isDirectory()) return;
  const soglia = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(NOTE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const percorso = join(NOTE_DIR, entry.name);
    if (statSync(percorso).mtimeMs < soglia) unlinkSync(percorso);
  }
}

creaDirPrivata(STATO_DIR);
creaDirPrivata(NOTE_DIR);
creaDirPrivata(SESSION_DIR);
pulisciNoteScadute();
mkdirSync(LAVORI_DIR, { recursive: true, mode: 0o700 });

const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
const PAGINA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "pagina.html"),
  "utf8",
).replace("__CSRF__", CSRF_TOKEN);

// Punto 1 (2026-08-13): alla ripresa il PRIMO messaggio è sempre una richiesta
// di riassunto, indipendentemente dall'obiettivo della richiesta (che va in
// coda come messaggio successivo — stesso meccanismo codaMessaggi della chat).
const SUNTO_RIPRESA =
  "Riassumi in breve, in italiano: obiettivo, passi principali fatti finora, stato attuale. Poi aspetta istruzioni.";

// Punto 2 (2026-08-13): prima di uccidere il processo di una finestra in
// ripresa, verifica se sta ancora lavorando — se sì, aspetta (limite di
// RIPRESA_ATTESA_MAX_MS, controlli ogni RIPRESA_ATTESA_INTERVALO_MS) invece di
// interromperla. Il segnale è verificato dal vivo (2026-08-13): il
// capture-pane di una finestra pi che genera una risposta cambia a ogni
// campionamento; a riposo è statico (3 hash identici su 3).
const RIPRESA_ATTESA_MAX_MS = numeroConfigurazione(
  "SUPERPI_RIPRESA_ATTESA_MAX_MS",
  process.env.SUPERPI_RIPRESA_ATTESA_MAX_MS ?? 60 * 1000,
  { minimo: 1 },
);
const RIPRESA_ATTESA_INTERVALO_MS = 2500;
const SHUTDOWN_TIMEOUT_MS = 10000;
const RIPRESA_CAMPIONE_GAP_MS = 1500; // due capture a 1.5s di distanza

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Multi-conversazione (v2, 2026-08-13): ogni conversazione è un task nella
// Map tasks, con un figlio vivo e un solo turno alla volta per ciascuna.
// Stati: "in_corso" (un giro sta girando) | "in_attesa" (figlio vivo, in
// attesa del prossimo messaggio) | "finito" (termina esplicito) | "errore".
// Una conversazione finita/errore RESTA in tasks (per vedere il risultato)
// finché /scarta non la rimuove. Limite: MAX_CONVERSAZIONI.
// { id, nome, figlio, scriba, sse:Set, dialoghi:Map, codaMessaggi:[],
//   turnoAttivo, obiettivo, cwd, noteFile, stato, condensatoFinale|null,
//   creatoIl }
const tasks = new Map();
let slotPrenotati = 0;

function contaSlotOccupati() {
  let occupati = 0;
  for (const t of tasks.values()) {
    if (t.id !== CONDUTTORE_ID && t.slotOccupato !== false) occupati++;
  }
  return occupati;
}

function prenotaSlot() {
  if (contaSlotOccupati() + slotPrenotati >= MAX_CONVERSAZIONI) return null;
  slotPrenotati++;
  let attiva = true;
  return {
    rilascia() {
      if (!attiva) return;
      attiva = false;
      slotPrenotati--;
    },
  };
}

// Canale SSE leggero e unico per lo stato di TUTTE le conversazioni: la
// pagina lo tiene sempre aperto per colorare le schede; lo stream completo
// (/eventi/<id>) si apre solo per la scheda guardata.
const clientiGlobali = new Set();
const sseTimers = new Set();
let shuttingDown = false;
let shutdownPromise = null;
let startPromise = null;

function statoGlobale(t) {
  return {
    taskId: t.id,
    nome: t.nome,
    stato: t.stato,
    dialogoInSospeso: t.dialoghi.size > 0,
  };
}

function broadcastGlobale(dati) {
  const frame = `event: stato\ndata: ${JSON.stringify(dati)}\n\n`;
  for (const res of clientiGlobali) res.write(frame);
}

// Cambio di stato: broadcast per-conversazione + notifica globale (colore
// della scheda). UNICO punto per non dimenticare la notifica.
function notificaStato(t, stato) {
  t.stato = stato;
  broadcast(t, "stato", { stato, taskId: t.id });
  broadcastGlobale(statoGlobale(t));
}

function taskPerId(id) {
  return typeof id === "string" ? tasks.get(id) : undefined;
}

function identitaPercorso(percorso) {
  const assoluto = resolve(String(percorso));
  const canonico = realpathSync(assoluto);
  const stato = statSync(canonico);
  if (!stato.isDirectory())
    throw new Error(`cwd non è una directory: "${percorso}"`);
  return { percorso: assoluto, canonico, dev: stato.dev, ino: stato.ino };
}

function rivalidaCwdTask(percorso, attesa) {
  let corrente;
  try {
    corrente = identitaPercorso(percorso);
  } catch {
    return {
      ok: false,
      motivo: `cwd non risolvibile: "${percorso}" (path inesistente o non accessibile)`,
    };
  }
  if (
    corrente.canonico !== attesa.canonico ||
    corrente.dev !== attesa.dev ||
    corrente.ino !== attesa.ino
  ) {
    return {
      ok: false,
      motivo:
        "cwd sostituita o symlink cambiato mentre il modello veniva selezionato",
    };
  }
  const gate = verificaCwd(corrente.canonico, { hiveRoot: PROTECTED_ROOT });
  return gate.ok ? { ok: true, cwd: corrente.canonico } : gate;
}

function pulisciCwdAutomatica(identita) {
  if (!identita) return;
  try {
    const corrente = identitaPercorso(identita.percorso);
    if (
      corrente.canonico !== identita.canonico ||
      corrente.dev !== identita.dev ||
      corrente.ino !== identita.ino
    )
      return;
    rmdirSync(identita.percorso);
  } catch {
    // Non cancellare directory sostituite, non vuote o non più accessibili.
  }
}

function motivoLimite() {
  return `limite di ${MAX_CONVERSAZIONI} conversazioni attive raggiunto: scarta una conversazione finita (POST /scarta) o attendi che si liberi un posto`;
}

function taskAttivo(t) {
  // una conversazione in attesa di un messaggio occupa comunque il suo posto
  return t && (t.stato === "in_corso" || t.stato === "in_attesa");
}

// --- il conduttore: caso speciale, NON una conversazione come le altre ------
// Id fisso e riservato "conduttore", creato al bisogno (primo messaggio
// mandato lì), NON conta contro MAX_CONVERSAZIONI, cwd fissa sotto il nostro
// controllo (nessun gate: la cwd non arriva da input esterno). Token CSRF del
// processo server in env, mai stampato. Riusa la stessa macchina di chat
// continua (eseguiTurno, coda, /messaggio, /termina). Passo 0 (2026-08-13):
// --tools è un'allowlist che filtra ANCHE gli strumenti delle estensioni —
// vanno nominati esplicitamente.
const CONDUTTORE_ID = "conduttore";
const CONDUTTORE_DIR = join(STATO_DIR, "conduttore");
const CONDUTTORE_EXT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "conduttore.ts",
);
const CONDUTTORE_TOOLS = "bash,leggi_conversazioni,manda_messaggio";

// Allowlist esplicita dei figli NORMALI (2026-08-20, audit pre-pubblicazione):
// avviaTask — condivisa da /task e /riprendi — creava il figlio senza
// extraArgs, quindi senza --tools: il gate prima dello spawn controlla solo
// cwd e quota, mai gli strumenti. Qui l'intero set built-in di coding del
// pacchetto installato (Fase 5, guardia di profondità: nessun tool di spawn
// in quel set) — non l'allowlist del conduttore, che ha uno scopo diverso
// (non tocca file, parla con le altre conversazioni).
const TASK_TOOLS = "read,bash,edit,write,grep,find,ls";

// Il valore leggibile di default nel campo cwd della pagina: un path relativo
// che non è mai una cwd valida di per sé (il server lo tratta come default,
// niente sottocartella se la pagina lo invia così com'è... NO: coincide con il
// default => stessa cosa di cwd assente, sottocartella automatica).
const CWD_DEFAULT_LEGGIBILE = "lavori-superpi";
const RIASSUNTO_PROMPT =
  "Prima di chiudere, riassumi in breve e onestamente, in italiano: cosa hai fatto in questa conversazione (passi principali), cosa hai prodotto (file o risultati, dove), e se secondo te vale la pena rivedere il risultato. Poi fermati.";
const RIASSUNTO_TIMEOUT_MS = 30000;

function slugDaObiettivo(obiettivo) {
  const s = String(obiettivo ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "compito";
}

// Sottocartella per conversazione dentro LAVORI_DIR: <data>-<slug>, con
// suffisso numerico se il nome esiste già (mai sovrascrivere). Creato QUI,
// prima del gate (verificaCwd fa realpathSync: deve esistere).
function creaSottocartellaAutomatica(obiettivo) {
  const data = new Date().toISOString().slice(0, 10);
  const slug = slugDaObiettivo(obiettivo);
  let dir = join(LAVORI_DIR, `${data}-${slug}`);
  let n = 2;
  while (existsSync(dir)) dir = join(LAVORI_DIR, `${data}-${slug}-${n++}`);
  creaDirPrivata(dir);
  return dir;
}

// Pezzo A, punto 6: prima di fermare una conversazione con sottocartella
// automatica, chiedi un riassunto finale al figlio (stesso meccanismo di
// eseguiTurno) e salva il materiale grezzo in <cwd>/.superpi/. Timeout
// esterno: se il figlio non risponde in tempo si procede comunque (non deve
// mai bloccare /termina).
async function chiediRiassunto(t) {
  const tsPrima = t.ultimaRisposta?.ts ?? null;
  void eseguiTurno(t, RIASSUNTO_PROMPT);
  const t0 = Date.now();
  while (Date.now() - t0 < RIASSUNTO_TIMEOUT_MS && t.turnoAttivo)
    await sleep(200);
  const riassunto =
    t.ultimaRisposta && t.ultimaRisposta.ts !== tsPrima
      ? t.ultimaRisposta.testo
      : null;
  try {
    const dir = join(t.cwd, ".superpi");
    creaDirPrivata(dir);
    const file = join(dir, "riassunto.md");
    writeFileSync(
      file,
      riassunto
        ? `${riassunto}\n`
        : "_riassunto non disponibile (timeout o errore del figlio)_\n",
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    return riassunto;
  } catch {
    return riassunto; // il salvataggio non deve bloccare /termina
  }
}

const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

function json(res, status, dati, extraHeaders = {}) {
  const body = JSON.stringify(dati);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function authOk(req) {
  if (!AUTH_ENABLED) return true;
  const ricevuto = req.headers.authorization;
  if (typeof ricevuto !== "string") return false;
  const actual = Buffer.from(ricevuto);
  const expected = Buffer.from(AUTH_HEADER);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function leggiBody(req) {
  return new Promise((resolve, reject) => {
    let acc = "";
    req.on("data", (c) => {
      acc += c;
      if (acc.length > MAX_BODY) {
        reject(new Error("body troppo grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(acc ? JSON.parse(acc) : {});
      } catch {
        reject(new Error("body JSON non valido"));
      }
    });
    req.on("error", reject);
  });
}

function csrfOk(req) {
  const tok = req.headers["x-csrf-token"];
  return typeof tok === "string" && tok.length > 0 && tok === CSRF_TOKEN;
}

function broadcast(t, tipo, dati) {
  const frame = `event: ${tipo}\ndata: ${JSON.stringify(dati)}\n\n`;
  for (const res of t.sse) res.write(frame);
}

// rispondiDialogo(figlio, payload) — UNICA funzione che risponde a un dialogo
// di conferma del figlio. client.send() NON è usabile: sovrascrive l'id del
// payload con un req_N autogenerato (rpc-client.js) e il figlio non risponde
// mai alle extension_ui_response (verificato dal vivo il 2026-08-11, test B1
// in scripts/test-conferme.mjs — NON ritestarlo). La risposta è una riga JSONL
// scritta direttamente sullo stdin del figlio, framing identico a
// serializeJsonLine (JSON.stringify + "\n"). Dettaglio interno non garantito,
// non un'API pubblica: se una versione futura di Pi cambia rpc-client.js, è
// QUESTO il punto che si rompe — per questo vive isolato qui, mai sparso.
function rispondiDialogo(figlio, payload) {
  figlio.client.process.stdin.write(
    JSON.stringify({ type: "extension_ui_response", ...payload }) + "\n",
  );
}

// eseguiTurno(t, testo): manda un messaggio al figlio ESISTENTE, aspetta la
// fine del giro, e ripete finché ci sono messaggi in coda (chi scrive mentre
// il figlio pensa: il messaggio parte a fine giro). A fine giro il figlio
// RESTA VIVO e lo stato torna a "in_attesa" — la conversazione continua finché
// /termina o un errore vero non chiudono. Un solo turno alla volta (flag
// turnoAttivo): le chiamate concorrenti accodano soltanto.
async function eseguiTurno(t, testo) {
  t.codaMessaggi.push(testo);
  if (t.turnoAttivo) return; // già in esecuzione: il messaggio è in coda
  t.turnoAttivo = true;
  try {
    while (
      t.codaMessaggi.length > 0 &&
      (t.stato === "in_corso" || t.stato === "in_attesa")
    ) {
      const msg = t.codaMessaggi.shift();
      notificaStato(t, "in_corso");
      await promptEAttendi(t.figlio, msg, TASK_TIMEOUT_MS);
    }
    notificaStato(t, "in_attesa");
  } catch (err) {
    // Errore vero: unico modo (oltre a /termina) di fermare il figlio.
    // Se /termina ha già vinto la corsa (stato "finito"), non fare nulla.
    if (t.stato === "finito") return;
    t.stato = "errore";
    broadcast(t, "errore", {
      motivo: err instanceof Error ? err.message : String(err),
    });
    broadcastGlobale(statoGlobale(t));
    await fermaFiglio(t.figlio);
    for (const res of t.sse) res.end();
    t.sse.clear();
  } finally {
    t.turnoAttivo = false;
  }
}

// Creazione del task condivisa: avviaTask (conversazioni normali) e
// assicuraConduttore (caso speciale) costruiscono lo stesso oggetto con la
// stessa macchina (scriba, dialoghi, coda, SSE, turnoAttivo).
function costruisciTask({
  id,
  nome,
  obiettivo,
  cwd,
  figlio,
  cwdAutomatica = false,
  prenotazione = null,
}) {
  const noteFile = join(NOTE_DIR, `${id}.jsonl`);
  const scriba = creaScriba(noteFile, () => {}, { mode: LOG_MODE });
  const t = {
    id,
    nome,
    figlio,
    scriba,
    sse: new Set(),
    dialoghi: new Map(), // id dialog -> {id, method, title, message, options, ts}
    codaMessaggi: [],
    turnoAttivo: false,
    obiettivo,
    cwd,
    cwdAutomatica,
    noteFile,
    stato: "in_corso",
    slotOccupato: id !== CONDUTTORE_ID,
    condensatoFinale: null,
    ultimaRisposta: null, // {testo, ts} — ultima risposta a parole del figlio (fix 2026-08-16)
    creatoIl: Date.now(),
  };
  tasks.set(id, t); // sincrono: dal momento della risposta 200 la conversazione esiste
  prenotazione?.rilascia(); // trasferita al task prima del primo await

  figlio.client.onEvent((e) => {
    if (e.type === "tool_execution_end") {
      const riga = t.scriba.onEvent(e); // append sul file + riga JSONL scritta
      if (riga) broadcast(t, "grezzo", { ts: new Date().toISOString(), riga });
    } else if (e.type === "message_end" && e.message?.role === "assistant") {
      // Le risposte a SOLO TESTO non passavano dai tool_execution_end: spariscono
      // (bug trovato provando la pagina, 2026-08-16). Forma vera verificata dal
      // vivo: un message_end assistant per blocco finale, content = array con
      // blocchi {type:"thinking"} e {type:"text", text}. Il testo parlato sta
      // nei blocchi text; se c'è anche una tool call il testo può essere vuoto.
      const testo = (e.message.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("")
        .trim();
      if (testo) {
        t.ultimaRisposta = { testo, ts: new Date().toISOString() };
        broadcast(t, "risposta", { testo, ts: t.ultimaRisposta.ts });
      }
    } else if (
      e.type === "extension_ui_request" &&
      (e.method === "confirm" || e.method === "select")
    ) {
      const d = {
        id: e.id,
        method: e.method,
        title: e.title ?? null,
        message: e.message ?? null,
        options: e.options ?? null,
        ts: new Date().toISOString(),
      };
      t.dialoghi.set(e.id, d);
      broadcast(t, "dialogo", d);
      broadcastGlobale(statoGlobale(t)); // dialogo in sospeso → scheda ambra
    }
  });
  return t;
}

async function avviaTask({
  obiettivo,
  cwd,
  id,
  nome,
  cwdAutomatica = false,
  resumeSessionId = null,
  resumeSessionDir = null,
  primoMessaggio = null,
  codaIniziale = [],
  provider = null,
  modello = null,
  envFiglio = undefined,
  prenotazione = null,
}) {
  // Resume: --session <id> apre il file di sessione esistente della finestra
  // presa in controllo, e il --session-dir deve essere QUELLO del file (per
  // le finestre reali è la cartella di default di pi, non quella di superPi —
  // verificato dal vivo: "No session found matching <id>" col dir sbagliato).
  // Altrimenti --session-id crea una sessione nuova nel dir di superPi.
  let figlio;
  let t;
  try {
    figlio = creaFiglio({
      cwd,
      nome: `task-${id.slice(0, 8)}`,
      sessionId: id,
      sessionDir: resumeSessionId ? resumeSessionDir : SESSION_DIR,
      timeoutMs: TASK_TIMEOUT_MS,
      resumeSessionId,
      provider: provider ?? undefined,
      model: modello ?? undefined,
      env: envFiglio,
      extraArgs: ["--tools", TASK_TOOLS],
    });
    t = costruisciTask({
      id,
      nome: nome ?? obiettivo.slice(0, 48),
      obiettivo,
      cwd,
      figlio,
      cwdAutomatica,
      prenotazione,
    });
  } catch {
    prenotazione?.rilascia();
    return;
  }

  broadcast(t, "stato", { stato: "avviato", obiettivo, cwd, taskId: id });
  broadcastGlobale(statoGlobale(t));
  try {
    await avviaFiglio(t.figlio, TASK_TIMEOUT_MS);
  } catch (err) {
    // spawn fallito: mai un figlio mezzo-vivo; lo slot viene liberato ma
    // l'errore resta visibile finché /scarta.
    t.slotOccupato = false;
    t.stato = "errore";
    broadcast(t, "errore", {
      motivo: err instanceof Error ? err.message : String(err),
    });
    broadcastGlobale(statoGlobale(t));
    await fermaFiglio(t.figlio);
    for (const res of t.sse) res.end();
    t.sse.clear();
    return;
  }
  // primo giro (chat continua: il figlio resta VIVO a fine giro). Il PRIMO
  // messaggio è sempre primoMessaggio (per la ripresa: il sunto); i messaggi
  // della coda iniziale (es. l'obiettivo della richiesta) vanno DOPO — il
  // push deve venire dopo la chiamata, mai prima, o l'ordine si inverte
  // (verificato dal vivo 2026-08-13: la coda partiva dall'obiettivo).
  void eseguiTurno(t, primoMessaggio ?? obiettivo);
  for (const m of codaIniziale) t.codaMessaggi.push(m);
}

// Il conduttore: creato al primo /messaggio verso di lui (mai al boot del
// server); se esiste ma è finito/errore, viene sostituito.
async function assicuraConduttore() {
  creaDirPrivata(CONDUTTORE_DIR);
  const esistente = tasks.get(CONDUTTORE_ID);
  if (esistente && taskAttivo(esistente)) return esistente;
  if (esistente) {
    for (const res of esistente.sse) res.end();
    esistente.sse.clear();
    tasks.delete(CONDUTTORE_ID);
  }
  const figlio = creaFiglio({
    cwd: CONDUTTORE_DIR,
    nome: "conduttore",
    sessionId: CONDUTTORE_ID,
    sessionDir: SESSION_DIR,
    timeoutMs: TASK_TIMEOUT_MS,
    // -a (--approve): la cwd dedicata del conduttore non è mai pre-fidata —
    // senza, il figlio RPC si blocca sul trust prompt (verificato dal vivo
    // 2026-08-13: primo giro mai completato). Solo per il conduttore.
    extraArgs: ["-e", CONDUTTORE_EXT, "--tools", CONDUTTORE_TOOLS, "-a"],
    env: { SUPERPI_URL: `http://127.0.0.1:${PORT}`, SUPERPI_TOKEN: CSRF_TOKEN },
  });
  const t = costruisciTask({
    id: CONDUTTORE_ID,
    nome: "superPi",
    obiettivo: "conduttore",
    cwd: CONDUTTORE_DIR,
    figlio,
  });
  broadcast(t, "stato", {
    stato: "avviato",
    obiettivo: "conduttore",
    cwd: CONDUTTORE_DIR,
    taskId: CONDUTTORE_ID,
  });
  broadcastGlobale(statoGlobale(t));
  try {
    await avviaFiglio(t.figlio, TASK_TIMEOUT_MS);
  } catch (err) {
    t.stato = "errore";
    broadcast(t, "errore", {
      motivo: err instanceof Error ? err.message : String(err),
    });
    broadcastGlobale(statoGlobale(t));
    await fermaFiglio(t.figlio);
    for (const res of t.sse) res.end();
    t.sse.clear();
    return null;
  }
  // niente primo giro automatico: il conduttore aspetta il primo messaggio
  notificaStato(t, "in_attesa");
  return t;
}

async function postTask(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  const prenotazione = prenotaSlot(); // sincrona: prima del primo await
  if (!prenotazione) return json(res, 409, { errore: motivoLimite() });
  let cwdAutomatica = false;
  let identitaAutomatica = null;
  let cwdConsegnata = false;
  try {
    let body;
    try {
      body = await leggiBody(req);
    } catch (e) {
      return json(res, 400, { errore: e.message });
    }
    const obiettivo =
      typeof body?.obiettivo === "string" ? body.obiettivo.trim() : "";
    const cwdInput = typeof body?.cwd === "string" ? body.cwd.trim() : "";
    if (!obiettivo) return json(res, 400, { errore: "obiettivo mancante" });
    if (obiettivo.length > MAX_OBIETTIVO)
      return json(res, 400, {
        errore: `obiettivo troppo lungo (max ${MAX_OBIETTIVO} caratteri)`,
      });
    // Cwd assente (o il default leggibile della pagina) => sottocartella
    // automatica. Il gate si applica alla cwd FINALE (già creata).
    cwdAutomatica = !cwdInput || cwdInput === CWD_DEFAULT_LEGGIBILE;
    const cwd = cwdAutomatica
      ? creaSottocartellaAutomatica(obiettivo)
      : cwdInput;
    if (cwdAutomatica) identitaAutomatica = identitaPercorso(cwd);
    const cwdOk = verificaCwd(cwd, { hiveRoot: PROTECTED_ROOT });
    if (!cwdOk.ok) return json(res, 400, { errore: cwdOk.motivo });
    const identitaIniziale = identitaPercorso(cwd);
    const profiloEsplicito =
      typeof body?.profilo === "string" && body.profilo.trim()
        ? body.profilo.trim()
        : null;
    const scelto = await scegliModello(
      obiettivo,
      profiloEsplicito,
      cwdAutomatica,
    );
    if (!scelto.ok)
      return json(res, 400, {
        errore: `scelta del modello fallita: ${scelto.motivo}`,
      });
    // Rivalidazione immediatamente dopo il router e prima della creazione del
    // figlio: né sostituzioni della directory né symlink swap sono accettati.
    const cwdFinale = rivalidaCwdTask(cwd, identitaIniziale);
    if (!cwdFinale.ok) return json(res, 400, { errore: cwdFinale.motivo });
    const id = crypto.randomUUID();
    void avviaTask({
      obiettivo,
      cwd: cwdFinale.cwd,
      id,
      cwdAutomatica,
      provider: scelto.provider,
      modello: scelto.model,
      prenotazione,
    });
    cwdConsegnata = true;
    return json(res, 200, { id });
  } finally {
    if (!cwdConsegnata) {
      prenotazione.rilascia();
      if (cwdAutomatica) pulisciCwdAutomatica(identitaAutomatica);
    }
  }
}

function getEventi(req, res, taskId) {
  const t = taskPerId(taskId);
  if (!t) return json(res, 404, { errore: "task non trovato" });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connesso\n\n");
  t.sse.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  sseTimers.add(ping);
  req.on("close", () => {
    t.sse.delete(res);
    sseTimers.delete(ping);
    clearInterval(ping);
  });
  // Snapshot all'apertura (multi-conversazione, 2026-08-13): stato corrente +
  // dialoghi in sospeso + ultima risposta a parole, così riaprire una scheda
  // mostra dove si è — la pagina chiude/riapre lo stream completo a ogni
  // cambio scheda.
  res.write(
    `event: stato\ndata: ${JSON.stringify({ stato: t.stato, taskId: t.id, nome: t.nome, dialogoInSospeso: t.dialoghi.size > 0 })}\n\n`,
  );
  for (const d of t.dialoghi.values()) {
    res.write(`event: dialogo\ndata: ${JSON.stringify(d)}\n\n`);
  }
  if (t.ultimaRisposta) {
    res.write(`event: risposta\ndata: ${JSON.stringify(t.ultimaRisposta)}\n\n`);
  }
  // connessione a conversazione già conclusa: esito finale subito, poi chiusura
  if (t.stato === "finito" && t.condensatoFinale) {
    res.write(
      `event: condensato\ndata: ${JSON.stringify(t.condensatoFinale)}\n\n`,
    );
    res.end();
  } else if (t.stato === "errore") {
    res.write(
      `event: errore\ndata: ${JSON.stringify({ motivo: "compito terminato con errore" })}\n\n`,
    );
    res.end();
  }
}

async function postRispondi(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  let body;
  try {
    body = await leggiBody(req);
  } catch (e) {
    return json(res, 400, { errore: e.message });
  }
  const taskId = typeof body?.taskId === "string" ? body.taskId : "";
  const t = taskPerId(taskId);
  if (!t) return json(res, 404, { errore: "task non trovato" });
  if (t.stato !== "in_corso") {
    return json(res, 409, { errore: "la conversazione non è in corso" });
  }
  const id = typeof body?.id === "string" ? body.id : null;
  const d = id ? t.dialoghi.get(id) : undefined;
  if (!d) {
    return json(res, 404, {
      errore: `nessun dialogo in sospeso con id ${id ?? "(mancante)"}`,
    });
  }
  const payload = { id };
  if (d.method === "confirm") {
    if (typeof body?.confirmed !== "boolean") {
      return json(res, 400, {
        errore: "per un confirm serve il campo confirmed (boolean)",
      });
    }
    payload.confirmed = body.confirmed;
  } else if (d.method === "select") {
    if (
      typeof body?.value !== "string" ||
      !Array.isArray(d.options) ||
      !d.options.includes(body.value)
    ) {
      return json(res, 400, {
        errore: `value deve essere una delle opzioni: ${(d.options ?? []).join(", ")}`,
      });
    }
    payload.value = body.value;
  }
  t.dialoghi.delete(id);
  rispondiDialogo(t.figlio, payload);
  broadcastGlobale(statoGlobale(t)); // dialogo risolto: la scheda torna blu/grigio
  return json(res, 200, { ok: true });
}

async function postMessaggio(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  let body;
  try {
    body = await leggiBody(req);
  } catch (e) {
    return json(res, 400, { errore: e.message });
  }
  const taskId = typeof body?.taskId === "string" ? body.taskId : "";
  let t = taskPerId(taskId);
  if (taskId === CONDUTTORE_ID && !t) {
    // il conduttore si crea al bisogno: primo messaggio verso di lui
    t = await assicuraConduttore();
    if (!t)
      return json(res, 500, {
        errore: "conduttore non avviabile (spawn fallito)",
      });
  }
  if (!t) return json(res, 404, { errore: "task non trovato" });
  if (!taskAttivo(t)) {
    return json(res, 409, {
      errore: "la conversazione non è attiva (terminata o in errore)",
    });
  }
  const testo = typeof body?.testo === "string" ? body.testo.trim() : "";
  if (!testo) return json(res, 400, { errore: "testo mancante" });
  if (testo.length > MAX_OBIETTIVO)
    return json(res, 400, {
      errore: `testo troppo lungo (max ${MAX_OBIETTIVO} caratteri)`,
    });
  if (t.turnoAttivo) {
    // il figlio sta già girando: il messaggio va in coda, parte a fine giro
    t.codaMessaggi.push(testo);
    return json(res, 200, { accodato: true });
  }
  void eseguiTurno(t, testo);
  return json(res, 200, { accodato: false });
}

async function postTermina(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  let body;
  try {
    body = await leggiBody(req);
  } catch (e) {
    return json(res, 400, { errore: e.message });
  }
  const taskId = typeof body?.taskId === "string" ? body.taskId : "";
  const t = taskPerId(taskId);
  if (!t) return json(res, 404, { errore: "task non trovato" });
  if (!taskAttivo(t)) {
    return json(res, 409, {
      errore: "la conversazione non è attiva da terminare",
    });
  }
  // Pezzo A, punto 6: riassunto finale SOLO per le conversazioni con
  // sottocartella automatica (cwd scelta dalla richiesta: niente riassunto richiesto,
  // non ha senso). Da fare PRIMA di stato="finito" (eseguiTurno non processa
  // più nessun messaggio quando lo stato è finito). Timeout interno: se il
  // figlio non risponde in tempo, si procede comunque a fermarlo.
  if (t.cwdAutomatica) {
    await chiediRiassunto(t);
    // il figlio potrebbe essere andato in errore durante il riassunto
    if (t.stato === "errore") {
      // procedi comunque: condensato con le note esistenti, poi cleanup
      t.condensatoFinale = {
        ...condensa({
          noteFile: t.noteFile,
          obiettivo: t.obiettivo,
          settled: true,
        }),
        rispostaFinale: t.ultimaRisposta ?? null,
      };
      await fermaFiglio(t.figlio);
      broadcast(t, "stato", { stato: "finito" });
      broadcastGlobale(statoGlobale(t));
      broadcast(t, "condensato", t.condensatoFinale);
      for (const res of t.sse) res.end();
      t.sse.clear();
      return json(res, 200, { ok: true });
    }
  }
  // stato "finito" PRIMA di fermare: se un turno è in corso, il suo catch
  // vede lo stato finito e non fa un secondo cleanup (corsa evitata)
  t.stato = "finito";
  // condensatore.mjs NON si tocca (logica e test invariati): il campo in più
  // si aggiunge qui, a parte — porta l'ultima cosa detta a parole, che il
  // condensato da solo non vede (elenca solo gli strumenti usati).
  t.condensatoFinale = {
    ...condensa({
      noteFile: t.noteFile,
      obiettivo: t.obiettivo,
      settled: true,
    }),
    rispostaFinale: t.ultimaRisposta ?? null,
  };
  // Pezzo A: il condensato su disco accanto al riassunto, per la valutazione
  // futura (materiale grezzo, nessun giudice in questo giro).
  if (t.cwdAutomatica) {
    try {
      const dir = join(t.cwd, ".superpi");
      creaDirPrivata(dir);
      const file = join(dir, "condensato.json");
      writeFileSync(file, JSON.stringify(t.condensatoFinale, null, 2), {
        mode: 0o600,
      });
      chmodSync(file, 0o600);
    } catch {
      /* non deve mai bloccare /termina */
    }
  }
  await fermaFiglio(t.figlio);
  broadcast(t, "stato", { stato: "finito" });
  broadcastGlobale(statoGlobale(t));
  broadcast(t, "condensato", t.condensatoFinale);
  for (const res of t.sse) res.end();
  t.sse.clear();
  return json(res, 200, { ok: true });
}

// Conversazione finita/errore: resta visibile finché /scarta non la rimuove.
// Su una conversazione ancora attiva risponde con errore (va prima terminata).
async function postScarta(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  let body;
  try {
    body = await leggiBody(req);
  } catch (e) {
    return json(res, 400, { errore: e.message });
  }
  const taskId = typeof body?.taskId === "string" ? body.taskId : "";
  if (taskId === CONDUTTORE_ID) {
    return json(res, 409, {
      errore:
        "il conduttore è una scheda fissa: non si scarta (al più si termina)",
    });
  }
  const t = taskPerId(taskId);
  if (!t) return json(res, 404, { errore: "task non trovato" });
  if (taskAttivo(t)) {
    return json(res, 409, {
      errore:
        "la conversazione è ancora attiva: prima va terminata (POST /termina)",
    });
  }
  tasks.delete(taskId);
  for (const res of t.sse) res.end();
  t.sse.clear();
  broadcastGlobale({ taskId, stato: "rimosso" });
  return json(res, 200, { ok: true });
}

function getConversazioni(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  const ora = Date.now();
  const lista = [];
  for (const t of tasks.values()) {
    if (t.id === CONDUTTORE_ID) continue; // il conduttore non è una conversazione normale
    lista.push({
      id: t.id,
      nome: t.nome,
      stato: t.stato,
      etaMs: ora - t.creatoIl,
      dialogoInSospeso: t.dialoghi.size > 0,
      cwd: t.cwd,
    });
  }
  return json(res, 200, { conversazioni: lista });
}

// Canale SSE unico e leggero: solo id+nome+stato+dialogo, ad ogni
// cambiamento di QUALSIASI conversazione. La pagina lo tiene sempre aperto
// per colorare le schede. Apre con lo snapshot di tutte le conversazioni.
// EventSource non può mandare header CSRF custom, ma l'autenticazione Basic
// viene applicata dal router HTTP prima di arrivare qui. Il canale è sola
// lettura dello stato (id+nome+stato+dialogo).
function getEventiGlobali(req, res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connesso\n\n");
  for (const t of tasks.values()) {
    res.write(`event: stato\ndata: ${JSON.stringify(statoGlobale(t))}\n\n`);
  }
  clientiGlobali.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  sseTimers.add(ping);
  req.on("close", () => {
    clientiGlobali.delete(res);
    sseTimers.delete(ping);
    clearInterval(ping);
  });
}

// --- sessioni esistenti (pannello) e ripresa ---------------------------------
// L'adapter (elenco, snippet, identità, PID, cwd, stato "sta lavorando") vive
// in src/sessioni.mjs: Herdr come backend primario, tmux come fallback SOLO
// se Herdr non offre un'identità stabile per la ripresa (2026-08-27).

function getSessioni(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  return json(res, 200, leggiSessioni());
}

function stessoTargetRipresa(atteso, corrente) {
  return (
    corrente?.ok &&
    corrente.cmd === "pi" &&
    corrente.sorgente === atteso.sorgente &&
    corrente.pid === atteso.pid &&
    corrente.sessioneId === atteso.sessioneId &&
    corrente.sessioneDir === atteso.sessioneDir &&
    corrente.cwd === atteso.cwd
  );
}

function processoPiConCwdValida(pid, cwd) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    return (
      readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi" &&
      realpathSync(readlinkSync(`/proc/${pid}/cwd`)) === cwd
    );
  } catch {
    return false;
  }
}

function rivalidaTargetRipresa(atteso) {
  const corrente = risolviFinestra(atteso.target);
  if (!corrente.ok) return { ok: false, motivo: corrente.motivo };
  if (
    corrente.pid <= 1 ||
    corrente.pid === process.pid ||
    !stessoTargetRipresa(atteso, corrente) ||
    !processoPiConCwdValida(corrente.pid, corrente.cwd)
  ) {
    return {
      ok: false,
      motivo:
        "il target della ripresa è cambiato o non è un processo pi verificato: nessun segnale inviato",
    };
  }
  try {
    process.kill(corrente.pid, 0);
  } catch {
    return {
      ok: false,
      motivo: "il processo del target non esiste più: nessun segnale inviato",
    };
  }
  return corrente;
}

async function postRiprendi(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  const prenotazione = prenotaSlot(); // sincrona: prima del primo await
  if (!prenotazione) return json(res, 409, { errore: motivoLimite() });
  try {
    let body;
    try {
      body = await leggiBody(req);
    } catch (e) {
      return json(res, 400, { errore: e.message });
    }
    const nomeFinestra =
      typeof body?.finestra === "string" ? body.finestra.trim() : "";
    if (!nomeFinestra)
      return json(res, 400, { errore: "campo finestra mancante" });
    const obiettivoUtente =
      typeof body?.obiettivo === "string" && body.obiettivo.trim()
        ? body.obiettivo.trim()
        : null;
    const info = risolviFinestra(nomeFinestra);
    if (!info.ok) return json(res, info.status, { errore: info.motivo });
    const providerSessione = info.provider ?? "";
    const gate = ["openai-codex", "mistral"].includes(providerSessione)
      ? verificaCwd(info.cwd, { hiveRoot: PROTECTED_ROOT, permettiHive: true })
      : await gateOk(info.cwd, true);
    if (!gate.ok) {
      return json(res, 400, {
        errore: `cwd della finestra rifiutata dal gate: ${gate.motivo}`,
      });
    }
    const attesaMax = RIPRESA_ATTESA_MAX_MS;
    const partitoA = Date.now();
    let lavorando = await staLavorando(
      info.target,
      info.sorgente,
      RIPRESA_CAMPIONE_GAP_MS,
    );
    while (lavorando && Date.now() - partitoA < attesaMax) {
      await sleep(RIPRESA_ATTESA_INTERVALO_MS);
      lavorando = await staLavorando(
        info.target,
        info.sorgente,
        RIPRESA_CAMPIONE_GAP_MS,
      );
    }
    if (lavorando) {
      return json(res, 409, {
        errore: "la sessione sta ancora lavorando, riprova tra poco",
      });
    }
    // Rivalidazione immediata prima di SIGTERM: PID, comando, sessione,
    // session dir e cwd devono essere esattamente quelli del primo snapshot.
    const primaDelTerm = rivalidaTargetRipresa(info);
    if (!primaDelTerm.ok)
      return json(res, 409, { errore: primaDelTerm.motivo });
    try {
      process.kill(primaDelTerm.pid, "SIGTERM");
    } catch (e) {
      return json(res, e.code === "ESRCH" ? 409 : 500, {
        errore:
          e.code === "ESRCH"
            ? "il processo del target è scomparso: nessun segnale inviato"
            : `kill del processo fallito: ${e.message}`,
      });
    }
    for (let i = 0; i < 10; i++) {
      try {
        process.kill(primaDelTerm.pid, 0);
      } catch {
        break;
      }
      await sleep(500);
    }
    let ancoraVivo = true;
    try {
      process.kill(primaDelTerm.pid, 0);
    } catch {
      ancoraVivo = false;
    }
    if (ancoraVivo) {
      const primaDelKill = rivalidaTargetRipresa(info);
      if (!primaDelKill.ok)
        return json(res, 409, { errore: primaDelKill.motivo });
      try {
        process.kill(primaDelKill.pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH")
          return json(res, 500, {
            errore: `kill del processo fallito: ${e.message}`,
          });
      }
    }
    const id = crypto.randomUUID();
    void avviaTask({
      obiettivo: obiettivoUtente ?? SUNTO_RIPRESA,
      cwd: info.cwd,
      id,
      nome: nomeFinestra,
      resumeSessionId: info.sessioneId,
      resumeSessionDir: info.sessioneDir,
      primoMessaggio: SUNTO_RIPRESA,
      codaIniziale: obiettivoUtente ? [obiettivoUtente] : [],
      provider: gate.provider ?? info.provider ?? null,
      modello: gate.modello ?? info.modello ?? null,
      envFiglio: await envFiglioPerProvider(gate),
      prenotazione,
    });
    return json(res, 200, { id, sessioneRipresa: info.sessioneId });
  } finally {
    prenotazione.rilascia();
  }
}

function pagina(_req, res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(PAGINA);
}

const server = http.createServer((req, res) => {
  if (!authOk(req)) {
    return json(
      res,
      401,
      { errore: "autenticazione HTTP Basic richiesta" },
      { "WWW-Authenticate": 'Basic realm="superPi"' },
    );
  }
  if (shuttingDown) return json(res, 503, { errore: "server in arresto" });
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;
  if (req.method === "GET" && path === "/") return pagina(req, res);
  if (req.method === "GET" && path === "/sessioni")
    return getSessioni(req, res);
  if (req.method === "GET" && path === "/conversazioni")
    return getConversazioni(req, res);
  if (req.method === "GET" && path === "/eventi-globali")
    return getEventiGlobali(req, res);
  if (req.method === "POST" && path === "/task") return void postTask(req, res);
  if (req.method === "GET" && path.startsWith("/eventi/"))
    return getEventi(req, res, path.slice("/eventi/".length));
  if (req.method === "POST" && path === "/rispondi")
    return void postRispondi(req, res);
  if (req.method === "POST" && path === "/messaggio")
    return void postMessaggio(req, res);
  if (req.method === "POST" && path === "/termina")
    return void postTermina(req, res);
  if (req.method === "POST" && path === "/scarta")
    return void postScarta(req, res);
  if (req.method === "POST" && path === "/riprendi")
    return void postRiprendi(req, res);
  return json(res, 404, { errore: "non trovato" });
});

export { server };

export function avviaServer() {
  if (server.listening) return Promise.resolve(server);
  if (startPromise) return startPromise;
  startPromise = new Promise((resolveAvvio, rejectAvvio) => {
    const errore = (err) => {
      server.removeListener("listening", pronto);
      rejectAvvio(err);
    };
    const pronto = () => {
      server.removeListener("error", errore);
      console.log(
        `superPi server su http://${HOST}:${PORT} (auth Basic: ${AUTH_ENABLED ? "attiva" : "disattivata"})`,
      );
      console.log(
        `stato in ${STATO_DIR} — fino a ${MAX_CONVERSAZIONI} conversazioni, timeout ${TASK_TIMEOUT_MS}ms`,
      );
      resolveAvvio(server);
    };
    server.once("error", errore);
    server.once("listening", pronto);
    server.listen(PORT, HOST);
  });
  return startPromise;
}

export function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    for (const timer of sseTimers) clearInterval(timer);
    sseTimers.clear();
    for (const res of clientiGlobali) {
      clientiGlobali.delete(res);
      if (!res.writableEnded) res.end();
    }
    for (const t of tasks.values()) {
      for (const res of t.sse) {
        if (!res.writableEnded) res.end();
      }
      t.sse.clear();
    }
    const chiusuraServer = server.listening
      ? new Promise((resolveClose) => server.close(resolveClose))
      : Promise.resolve();
    const figli = [...tasks.values()].map((t) => fermaFiglio(t.figlio));
    const attesaFigli = Promise.allSettled(figli);
    await Promise.race([attesaFigli, sleep(SHUTDOWN_TIMEOUT_MS)]);
    await Promise.race([chiusuraServer, sleep(SHUTDOWN_TIMEOUT_MS)]);
  })();
  return shutdownPromise;
}

const moduloDiretto =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (moduloDiretto) {
  let uscitaAvviata = false;
  const arrestaDaSegnale = () => {
    if (uscitaAvviata) return;
    uscitaAvviata = true;
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", arrestaDaSegnale);
  process.on("SIGTERM", arrestaDaSegnale);
  void avviaServer().catch((err) => {
    console.error(`avvio server fallito: ${err.message}`);
    process.exitCode = 1;
  });
}
