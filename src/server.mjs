// Fase 9 — server web di superPi (v1, un figlio alla volta).
// Node http puro + Server-Sent Events: nessuna dipendenza nuova.
//
// Endpoint:
//   GET  /                 → la pagina (src/pagina.html, token CSRF iniettato)
//   POST /task             → {obiettivo, cwd} + header X-CSRF-Token
//                            (verificaGate prima di spawnare; un figlio alla volta)
//   GET  /eventi/<task-id> → stream SSE: grezzo (righe scriba in tempo reale),
//                            dialogo (extension_ui_request confirm/select),
//                            condensato (a fine compito), stato, errore
//   POST /rispondi         → {id, confirmed} o {id, value} + header X-CSRF-Token
//   GET  /sessioni         → sessioni esistenti (finestre tmux pi/claude + claude
//                            agents --json), sola lettura, CSRF richiesto
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
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { creaFiglio, avviaFiglio, promptFiglio, attendiIdle, fermaFiglio } from "./spawner.mjs";
import { creaScriba } from "./scriba.mjs";
import { condensa } from "./condensatore.mjs";
import { verificaGate } from "./gate.mjs";
import { leggiCredenzialeOpenRouter, OPENROUTER_VARIABILE } from "./quota-openrouter.mjs";

// Test-only: SUPERPI_GATE_QUOTA_FAKE — "1" quota finta a 0% (caso comune), "sopra"
// quota finta sopra soglia (per testare la riserva OpenRouter senza toccare la
// quota reale). La quota reale è coperta da test-fase4 col mock iniettabile.
const GATE_QUOTA_FAKE = process.env.SUPERPI_GATE_QUOTA_FAKE;
async function gateOk(cwd, permettiHive) {
  return verificaGate({
    cwd,
    permettiHive,
    ottieniQuota: GATE_QUOTA_FAKE
      ? async () => ({ rolling: { percentuale: GATE_QUOTA_FAKE === "sopra" ? 95 : 0, reset_in: 0 }, aggiornato: new Date().toISOString() })
      : undefined,
  });
}

// Riserva OpenRouter (2026-08-18): se il gate ha scelto openrouter, il figlio
// va spawnato con la credenziale NEL NOME GIUSTO (OPENROUTER_API_KEY — bridging:
// nel vault è OPENROUTER_API_TOKEN) e SOLO in quel caso: i figli su OpenCode Go
// non si portano dietro una variabile che non gli serve. Il valore transita
// solo in memoria (subprocesso secret env) e non esce mai da qui.
async function envFiglioPerProvider(gate) {
  if (gate?.provider !== "openrouter") return undefined;
  const { valore } = leggiCredenzialeOpenRouter();
  return { [OPENROUTER_VARIABILE]: valore };
}

const PORT = Number(process.env.SUPERPI_PORT ?? 8787);
const HOST = "127.0.0.1"; // MAI 0.0.0.0 — la sicurezza sta qui + CSRF, non in tailscale serve
const STATO_DIR = join(homedir(), ".local", "state", "superpi");
const NOTE_DIR = join(STATO_DIR, "note");
const SESSION_DIR = join(STATO_DIR, "sessions");
// Cartella di lavoro di DEFAULT (Pezzo A, 2026-08-17): un posto solo lato
// server. Se il corpo di /task non porta una cwd (o porta il valore leggibile
// di default della pagina), postTask crea una sottocartella dedicata qui dentro.
const LAVORI_DIR = process.env.SUPERPI_LAVORI_DIR ?? join(homedir(), "lavori-superpi");
const TASK_TIMEOUT_MS = Number(process.env.SUPERPI_TASK_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_CONVERSAZIONI = Number(process.env.SUPERPI_MAX_CONVERSAZIONI ?? 4);
const MAX_BODY = 64 * 1024;
const MAX_OBIETTIVO = 4000;

mkdirSync(NOTE_DIR, { recursive: true });
mkdirSync(SESSION_DIR, { recursive: true });
mkdirSync(LAVORI_DIR, { recursive: true });

const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
const PAGINA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pagina.html"), "utf8")
  .replace("__CSRF__", CSRF_TOKEN);

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
const RIPRESA_ATTESA_MAX_MS = Number(process.env.SUPERPI_RIPRESA_ATTESA_MAX_MS ?? 60 * 1000);
const RIPRESA_ATTESA_INTERVALO_MS = 2500;
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

// Canale SSE leggero e unico per lo stato di TUTTE le conversazioni: la
// pagina lo tiene sempre aperto per colorare le schede; lo stream completo
// (/eventi/<id>) si apre solo per la scheda guardata.
const clientiGlobali = new Set();

function statoGlobale(t) {
  return { taskId: t.id, nome: t.nome, stato: t.stato, dialogoInSospeso: t.dialoghi.size > 0 };
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

function limiteRaggiunto() {
  return tasks.size - (tasks.has(CONDUTTORE_ID) ? 1 : 0) >= MAX_CONVERSAZIONI;
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
const CONDUTTORE_EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "conduttore.ts");
const CONDUTTORE_TOOLS = "bash,leggi_conversazioni,manda_messaggio";

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
  mkdirSync(dir, { recursive: true });
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
  while (Date.now() - t0 < RIASSUNTO_TIMEOUT_MS && t.turnoAttivo) await sleep(200);
  const riassunto = t.ultimaRisposta && t.ultimaRisposta.ts !== tsPrima ? t.ultimaRisposta.testo : null;
  try {
    const dir = join(t.cwd, ".superpi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "riassunto.md"), riassunto ? `${riassunto}\n` : "_riassunto non disponibile (timeout o errore del figlio)_\n");
    return riassunto;
  } catch {
    return riassunto; // il salvataggio non deve bloccare /termina
  }
}

function json(res, status, dati) {
  const body = JSON.stringify(dati);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
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
  figlio.client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", ...payload }) + "\n");
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
    while (t.codaMessaggi.length > 0 && (t.stato === "in_corso" || t.stato === "in_attesa")) {
      const msg = t.codaMessaggi.shift();
      notificaStato(t, "in_corso");
      await promptFiglio(t.figlio, msg, TASK_TIMEOUT_MS);
      await attendiIdle(t.figlio, TASK_TIMEOUT_MS);
    }
    notificaStato(t, "in_attesa");
  } catch (err) {
    // Errore vero: unico modo (oltre a /termina) di fermare il figlio.
    // Se /termina ha già vinto la corsa (stato "finito"), non fare nulla.
    if (t.stato === "finito") return;
    t.stato = "errore";
    broadcast(t, "errore", { motivo: err instanceof Error ? err.message : String(err) });
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
function costruisciTask({ id, nome, obiettivo, cwd, figlio, cwdAutomatica = false }) {
  const noteFile = join(NOTE_DIR, `${id}.jsonl`);
  const scriba = creaScriba(noteFile, () => {});
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
    condensatoFinale: null,
    ultimaRisposta: null, // {testo, ts} — ultima risposta a parole del figlio (fix 2026-08-16)
    creatoIl: Date.now(),
  };
  tasks.set(id, t); // sincrono: dal momento della risposta 200 la conversazione esiste

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
    } else if (e.type === "extension_ui_request" && (e.method === "confirm" || e.method === "select")) {
      const d = { id: e.id, method: e.method, title: e.title ?? null, message: e.message ?? null, options: e.options ?? null, ts: new Date().toISOString() };
      t.dialoghi.set(e.id, d);
      broadcast(t, "dialogo", d);
      broadcastGlobale(statoGlobale(t)); // dialogo in sospeso → scheda ambra
    }
  });
  return t;
}

async function avviaTask({ obiettivo, cwd, id, nome, cwdAutomatica = false, resumeSessionId = null, resumeSessionDir = null, primoMessaggio = null, codaIniziale = [], provider = null, modello = null, envFiglio = undefined }) {
  // Resume: --session <id> apre il file di sessione esistente della finestra
  // presa in controllo, e il --session-dir deve essere QUELLO del file (per
  // le finestre reali è la cartella di default di pi, non quella di superPi —
  // verificato dal vivo: "No session found matching <id>" col dir sbagliato).
  // Altrimenti --session-id crea una sessione nuova nel dir di superPi.
  const figlio = creaFiglio({
    cwd,
    nome: `task-${id.slice(0, 8)}`,
    sessionId: id,
    sessionDir: resumeSessionId ? resumeSessionDir : SESSION_DIR,
    timeoutMs: TASK_TIMEOUT_MS,
    resumeSessionId,
    provider: provider ?? undefined,
    model: modello ?? undefined,
    env: envFiglio,
  });
  const t = costruisciTask({ id, nome: nome ?? obiettivo.slice(0, 48), obiettivo, cwd, figlio, cwdAutomatica });

  broadcast(t, "stato", { stato: "avviato", obiettivo, cwd, taskId: id });
  broadcastGlobale(statoGlobale(t));
  try {
    await avviaFiglio(t.figlio, TASK_TIMEOUT_MS);
  } catch (err) {
    // spawn fallito: mai un figlio mezzo-vivo
    t.stato = "errore";
    broadcast(t, "errore", { motivo: err instanceof Error ? err.message : String(err) });
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
  mkdirSync(CONDUTTORE_DIR, { recursive: true });
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
  const t = costruisciTask({ id: CONDUTTORE_ID, nome: "superPi", obiettivo: "conduttore", cwd: CONDUTTORE_DIR, figlio });
  broadcast(t, "stato", { stato: "avviato", obiettivo: "conduttore", cwd: CONDUTTORE_DIR, taskId: CONDUTTORE_ID });
  broadcastGlobale(statoGlobale(t));
  try {
    await avviaFiglio(t.figlio, TASK_TIMEOUT_MS);
  } catch (err) {
    t.stato = "errore";
    broadcast(t, "errore", { motivo: err instanceof Error ? err.message : String(err) });
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
  if (limiteRaggiunto()) {
    return json(res, 409, { errore: motivoLimite() });
  }
  let body;
  try {
    body = await leggiBody(req);
  } catch (e) {
    return json(res, 400, { errore: e.message });
  }
  const obiettivo = typeof body?.obiettivo === "string" ? body.obiettivo.trim() : "";
  const cwdInput = typeof body?.cwd === "string" ? body.cwd.trim() : "";
  if (!obiettivo) return json(res, 400, { errore: "obiettivo mancante" });
  if (obiettivo.length > MAX_OBIETTIVO) return json(res, 400, { errore: `obiettivo troppo lungo (max ${MAX_OBIETTIVO} caratteri)` });
  // Pezzo A: cwd assente (o il default leggibile della pagina) => sottocartella
  // automatica dentro LAVORI_DIR; cwd esplicita => usata esattamente com'è,
  // anche se coincide con LAVORI_DIR: solo l'assenza di cwd attiva la
  // sottocartella. Il gate si applica alla cwd FINALE (già creata).
  const cwdAutomatica = !cwdInput || cwdInput === CWD_DEFAULT_LEGGIBILE;
  const cwd = cwdAutomatica ? creaSottocartellaAutomatica(obiettivo) : cwdInput;
  const gate = await gateOk(cwd, false); // /task: mai permettiHive
  if (!gate.ok) return json(res, 400, { errore: gate.motivo });
  const id = crypto.randomUUID();
  void avviaTask({ obiettivo, cwd, id, cwdAutomatica, provider: gate.provider ?? null, modello: gate.modello ?? null, envFiglio: await envFiglioPerProvider(gate) });
  return json(res, 200, { id });
}

function getEventi(req, res, taskId) {
  const t = taskPerId(taskId);
  if (!t) return json(res, 404, { errore: "task non trovato" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connesso\n\n");
  t.sse.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    t.sse.delete(res);
    clearInterval(ping);
  });
  // Snapshot all'apertura (multi-conversazione, 2026-08-13): stato corrente +
  // dialoghi in sospeso + ultima risposta a parole, così riaprire una scheda
  // mostra dove si è — la pagina chiude/riapre lo stream completo a ogni
  // cambio scheda.
  res.write(`event: stato\ndata: ${JSON.stringify({ stato: t.stato, taskId: t.id, nome: t.nome, dialogoInSospeso: t.dialoghi.size > 0 })}\n\n`);
  for (const d of t.dialoghi.values()) {
    res.write(`event: dialogo\ndata: ${JSON.stringify(d)}\n\n`);
  }
  if (t.ultimaRisposta) {
    res.write(`event: risposta\ndata: ${JSON.stringify(t.ultimaRisposta)}\n\n`);
  }
  // connessione a conversazione già conclusa: esito finale subito, poi chiusura
  if (t.stato === "finito" && t.condensatoFinale) {
    res.write(`event: condensato\ndata: ${JSON.stringify(t.condensatoFinale)}\n\n`);
    res.end();
  } else if (t.stato === "errore") {
    res.write(`event: errore\ndata: ${JSON.stringify({ motivo: "compito terminato con errore" })}\n\n`);
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
    return json(res, 404, { errore: `nessun dialogo in sospeso con id ${id ?? "(mancante)"}` });
  }
  const payload = { id };
  if (d.method === "confirm") {
    if (typeof body?.confirmed !== "boolean") {
      return json(res, 400, { errore: "per un confirm serve il campo confirmed (boolean)" });
    }
    payload.confirmed = body.confirmed;
  } else if (d.method === "select") {
    if (typeof body?.value !== "string" || !Array.isArray(d.options) || !d.options.includes(body.value)) {
      return json(res, 400, { errore: `value deve essere una delle opzioni: ${(d.options ?? []).join(", ")}` });
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
    if (!t) return json(res, 500, { errore: "conduttore non avviabile (spawn fallito)" });
  }
  if (!t) return json(res, 404, { errore: "task non trovato" });
  if (!taskAttivo(t)) {
    return json(res, 409, { errore: "la conversazione non è attiva (terminata o in errore)" });
  }
  const testo = typeof body?.testo === "string" ? body.testo.trim() : "";
  if (!testo) return json(res, 400, { errore: "testo mancante" });
  if (testo.length > MAX_OBIETTIVO) return json(res, 400, { errore: `testo troppo lungo (max ${MAX_OBIETTIVO} caratteri)` });
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
    return json(res, 409, { errore: "la conversazione non è attiva da terminare" });
  }
  // Pezzo A, punto 6: riassunto finale SOLO per le conversazioni con
  // sottocartella automatica (cwd scelta da Luca: niente riassunto richiesto,
  // non ha senso). Da fare PRIMA di stato="finito" (eseguiTurno non processa
  // più nessun messaggio quando lo stato è finito). Timeout interno: se il
  // figlio non risponde in tempo, si procede comunque a fermarlo.
  if (t.cwdAutomatica) {
    await chiediRiassunto(t);
    // il figlio potrebbe essere andato in errore durante il riassunto
    if (t.stato === "errore") {
      // procedi comunque: condensato con le note esistenti, poi cleanup
      t.condensatoFinale = { ...condensa({ noteFile: t.noteFile, obiettivo: t.obiettivo, settled: true }), rispostaFinale: t.ultimaRisposta ?? null };
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
  t.condensatoFinale = { ...condensa({ noteFile: t.noteFile, obiettivo: t.obiettivo, settled: true }), rispostaFinale: t.ultimaRisposta ?? null };
  // Pezzo A: il condensato su disco accanto al riassunto, per la valutazione
  // futura (materiale grezzo, nessun giudice in questo giro).
  if (t.cwdAutomatica) {
    try {
      const dir = join(t.cwd, ".superpi");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "condensato.json"), JSON.stringify(t.condensatoFinale, null, 2));
    } catch { /* non deve mai bloccare /termina */ }
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
    return json(res, 409, { errore: "il conduttore è una scheda fissa: non si scarta (al più si termina)" });
  }
  const t = taskPerId(taskId);
  if (!t) return json(res, 404, { errore: "task non trovato" });
  if (taskAttivo(t)) {
    return json(res, 409, { errore: "la conversazione è ancora attiva: prima va terminata (POST /termina)" });
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
// NOTA (2026-08-13): SENZA CSRF — EventSource (browser) non può mandare
// header custom, e il canale è sola lettura dello stato (id+nome+stato+
// dialogo), come /eventi/<id>: non cambia nulla, non rivela più di quanto
// rivela /conversazioni a chi ha il token.
function getEventiGlobali(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connesso\n\n");
  for (const t of tasks.values()) {
    res.write(`event: stato\ndata: ${JSON.stringify(statoGlobale(t))}\n\n`);
  }
  clientiGlobali.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clientiGlobali.delete(res);
    clearInterval(ping);
  });
}

// --- sessioni esistenti (pannello, passo A) e ripresa (passo B) ---

const SESSIONI_DEFAULT_DIR = join(homedir(), ".pi", "agent", "sessions");
const CORRELAZIONE_SOGLIA_MS = 15 * 60 * 1000; // due finestre nella stessa cwd a <15 min: ambigue

function esegui(cmd, args, timeoutMs = 5000) {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }) };
  } catch (e) {
    return { ok: false, errore: e.message.split("\n")[0] };
  }
}

function sanitizzaCwd(cwd) {
  // Formato reale di ~/.pi/agent/sessions (verificato dal vivo):
  // /home/alice/projects -> --home-alice-projects-- (slash iniziale rimosso,
  // "/" -> "-", avvolto tra doppi trattini). Un trattino di differenza =
  // cartella sbagliata.
  return "--" + cwd.slice(1).replaceAll("/", "-") + "--";
}

function epochDiAvvio(pid) {
  const r = esegui("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (!r.ok || !r.stdout.trim()) return null;
  const t = Date.parse(r.stdout.trim());
  return Number.isNaN(t) ? null : t;
}

function pidFiglioPerComm(panePid, comm) {
  const r = esegui("pgrep", ["-P", String(panePid)]);
  if (!r.ok) return null;
  for (const p of r.stdout.trim().split("\n")) {
    const pid = Number(p);
    if (!pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === comm) return pid;
    } catch { /* processo sparito */ }
  }
  return null;
}

// Correlazione finestra ↔ file di sessione (strada a, motivata nel report):
// il file più vicino all'orario di avvio del processo nella cartella di
// default per la sua cwd. Il timestamp è nel nome: 2026-08-12T07-59-33-685Z_uuid.jsonl
function correlazionaSessione(pid, cwd, avviatoIl) {
  const dir = join(SESSIONI_DEFAULT_DIR, sanitizzaCwd(cwd));
  let file;
  try {
    file = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let migliore = null;
  let miglioreDist = Infinity;
  for (const f of file) {
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/);
    if (!m) continue;
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    if (Number.isNaN(t)) continue;
    const dist = Math.abs(t - avviatoIl);
    if (dist < miglioreDist) {
      migliore = { sessioneId: m[8], distanzaMs: dist, dir };
      miglioreDist = dist;
    }
  }
  return miglioreDist <= CORRELAZIONE_SOGLIA_MS ? migliore : null;
}

function snippetFinestra(target, maxRighe = 8, maxChar = 400) {
  const r = esegui("tmux", ["capture-pane", "-p", "-t", target], 3000);
  if (!r.ok) return "";
  const righe = r.stdout
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  const ultime = righe.slice(-maxRighe).join("\n");
  return ultime.length > maxChar ? ultime.slice(-maxChar) : ultime;
}

// Punto 2: la finestra sta lavorando se il capture-pane cambia tra due
// campionamenti a ~1.5s (segnale verificato dal vivo il 2026-08-13: hash del
// pane diversi a ogni campione durante la generazione, identici a riposo).
// true = sta lavorando, false = ferma, null = non leggibile (trattato come
// "lavorando": mai uccidere una finestra di cui non si sa nulla).
async function finestraStaLavorando(target) {
  const a = esegui("tmux", ["capture-pane", "-p", "-t", target], 3000);
  await sleep(RIPRESA_CAMPIONE_GAP_MS);
  const b = esegui("tmux", ["capture-pane", "-p", "-t", target], 3000);
  if (!a.ok || !b.ok) return null;
  return a.stdout !== b.stdout;
}

function leggiSessioni() {
  const lettaIl = Date.now();
  const finestre = [];
  const r = esegui("tmux", ["list-panes", "-a", "-F", "#{session_name}:#{window_name}|#{pane_pid}|#{pane_current_command}"], 5000);
  if (r.ok) {
    for (const riga of r.stdout.trim().split("\n")) {
      if (!riga.includes("|")) continue;
      const [nome, panePidStr, cmd] = riga.split("|");
      if (cmd !== "pi" && cmd !== "claude") continue;
      const panePid = Number(panePidStr);
      if (!panePid) continue;
      const voce = {
        nome, cmd, panePid, pid: null, cwd: null, avviatoIl: null, etaMs: null,
        snippet: "", sessioneId: null, motivoNoId: null, etaLetturaMs: 0,
      };
      const pid = pidFiglioPerComm(panePid, cmd);
      voce.pid = pid;
      if (pid) {
        try { voce.cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { voce.cwd = null; }
        const avvio = epochDiAvvio(pid);
        if (avvio) {
          voce.avviatoIl = new Date(avvio).toISOString();
          voce.etaMs = lettaIl - avvio;
        }
        if (cmd === "pi" && voce.cwd && avvio) {
          const corr = correlazionaSessione(pid, voce.cwd, avvio);
          if (corr) voce.sessioneId = corr.sessioneId;
          else voce.motivoNoId = "nessun file di sessione correlabile (entro 15 min dall'avvio)";
        } else if (cmd === "pi") {
          voce.motivoNoId = "cwd o orario di avvio non leggibili";
        }
      } else {
        voce.motivoNoId = "processo non trovato";
      }
      voce.snippet = snippetFinestra(nome);
      finestre.push(voce);
    }
  }
  const claude = [];
  const rc = esegui("claude", ["agents", "--json"], 8000);
  if (rc.ok) {
    try {
      for (const a of JSON.parse(rc.stdout)) {
        claude.push({
          sessionId: a.sessionId ?? null,
          name: a.name ?? null,
          status: a.status ?? null,
          pid: a.pid ?? null,
          cwd: a.cwd ?? null,
          avviatoIl: a.startedAt ? new Date(a.startedAt).toISOString() : null,
          etaMs: a.startedAt ? lettaIl - a.startedAt : null,
        });
      }
    } catch { /* JSON non valido: lista vuota */ }
  }
  return { lettaIl: new Date(lettaIl).toISOString(), etaLetturaMs: 0, finestre, claude };
}

function getSessioni(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  return json(res, 200, leggiSessioni());
}

async function postRiprendi(req, res) {
  if (!csrfOk(req)) {
    return json(res, 401, { errore: "token CSRF mancante o non valido" });
  }
  if (limiteRaggiunto()) {
    return json(res, 409, { errore: motivoLimite() });
  }
  let body;
  try {
    body = await leggiBody(req);
  } catch (e) {
    return json(res, 400, { errore: e.message });
  }
  const nomeFinestra = typeof body?.finestra === "string" ? body.finestra.trim() : "";
  if (!nomeFinestra) return json(res, 400, { errore: "campo finestra mancante" });
  const obiettivoUtente =
    typeof body?.obiettivo === "string" && body.obiettivo.trim()
      ? body.obiettivo.trim()
      : null;
  // Punto 1: l'obiettivo del TASK (per condensato/UI) è il messaggio utente
  // se c'è, altrimenti il sunto; il PRIMO MESSAGGIO al figlio è sempre il
  // sunto, e l'eventuale obiettivo va in coda come messaggio successivo.
  // ri-legge la finestra dal vivo (mai fidarsi di una lista vecchia)
  const r = esegui("tmux", ["list-panes", "-a", "-F", "#{session_name}:#{window_name}|#{pane_pid}|#{pane_current_command}"], 5000);
  let riga = null;
  if (r.ok) riga = r.stdout.trim().split("\n").find((l) => l.startsWith(nomeFinestra + "|"));
  if (!riga) return json(res, 404, { errore: `finestra non trovata: ${nomeFinestra}` });
  const [, panePidStr, cmd] = riga.split("|");
  if (cmd !== "pi") {
    return json(res, 400, { errore: `la finestra ${nomeFinestra} non è una sessione pi (cmd=${cmd}): il controllo è possibile solo per pi` });
  }
  const panePid = Number(panePidStr);
  const pid = pidFiglioPerComm(panePid, "pi");
  if (!pid) return json(res, 409, { errore: "processo pi della finestra non trovato (già terminato?)" });
  let cwd;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return json(res, 409, { errore: "cwd del processo non leggibile" });
  }
  const avvio = epochDiAvvio(pid);
  const corr = avvio ? correlazionaSessione(pid, cwd, avvio) : null;
  if (!corr?.sessioneId) {
    return json(res, 400, { errore: "nessun file di sessione correlabile a questa finestra (entro 15 min dall'avvio): impossibile riprenderla" });
  }
  // Parte 1 (2026-08-13): per /riprendi il gate salta SOLO il controllo
  // "dentro hive" (la sessione esisteva già, aperta da Luca; hive-safety.ts
  // resta comunque attivo lì). $HOME esatta resta SEMPRE rifiutata, e /task
  // non usa mai permettiHive.
  const gate = await gateOk(cwd, true);
  if (!gate.ok) {
    return json(res, 400, { errore: `cwd della finestra rifiutata dal gate: ${gate.motivo}` });
  }
  // Punto 2: se la finestra sta ancora lavorando (generando una risposta o
  // eseguendo un tool), aspetta fino a RIPRESA_ATTESA_MAX_MS invece di
  // interromperla; oltre il limite rispondi con un errore chiaro, MAI uccidere
  // comunque. La rilettura del pane (finestraStaLavorando) ha un timeout
  // esterno suo (esegui → 3000ms per capture).
  const attesaMax = RIPRESA_ATTESA_MAX_MS;
  const partitoA = Date.now();
  let lavorando = await finestraStaLavorando(nomeFinestra);
  while (lavorando && Date.now() - partitoA < attesaMax) {
    await sleep(RIPRESA_ATTESA_INTERVALO_MS);
    lavorando = await finestraStaLavorando(nomeFinestra);
  }
  if (lavorando) {
    return json(res, 409, { errore: "la sessione sta ancora lavorando, riprova tra poco" });
  }
  // kill del processo pi della finestra: verificato (2026-08-12) che SIGTERM
  // basta (~2s, file di sessione sempre valido); SIGKILL solo di sicurezza.
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 10; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch { /* già morto */ }
  } catch (e) {
    return json(res, 500, { errore: `kill del processo fallito: ${e.message}` });
  }
  const id = crypto.randomUUID();
  void avviaTask({
    obiettivo: obiettivoUtente ?? SUNTO_RIPRESA,
    cwd,
    id,
    nome: nomeFinestra,
    resumeSessionId: corr.sessioneId,
    resumeSessionDir: corr.dir,
    primoMessaggio: SUNTO_RIPRESA,
    codaIniziale: obiettivoUtente ? [obiettivoUtente] : [],
    provider: gate.provider ?? null,
    modello: gate.modello ?? null,
    envFiglio: await envFiglioPerProvider(gate),
  });
  return json(res, 200, { id, sessioneRipresa: corr.sessioneId });
}

function pagina(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGINA);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  if (req.method === "GET" && path === "/") return pagina(req, res);
  if (req.method === "GET" && path === "/sessioni") return getSessioni(req, res);
  if (req.method === "GET" && path === "/conversazioni") return getConversazioni(req, res);
  if (req.method === "GET" && path === "/eventi-globali") return getEventiGlobali(req, res);
  if (req.method === "POST" && path === "/task") return void postTask(req, res);
  if (req.method === "GET" && path.startsWith("/eventi/")) return getEventi(req, res, path.slice("/eventi/".length));
  if (req.method === "POST" && path === "/rispondi") return void postRispondi(req, res);
  if (req.method === "POST" && path === "/messaggio") return void postMessaggio(req, res);
  if (req.method === "POST" && path === "/termina") return void postTermina(req, res);
  if (req.method === "POST" && path === "/scarta") return void postScarta(req, res);
  if (req.method === "POST" && path === "/riprendi") return void postRiprendi(req, res);
  return json(res, 404, { errore: "non trovato" });
});

server.listen(PORT, HOST, () => {
  console.log(`superPi server su http://${HOST}:${PORT} (CSRF token: ${CSRF_TOKEN})`);
  console.log(`stato in ${STATO_DIR} — fino a ${MAX_CONVERSAZIONI} conversazioni, timeout ${TASK_TIMEOUT_MS}ms`);
});
