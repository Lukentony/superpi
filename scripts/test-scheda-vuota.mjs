// Fix scheda nuova vuota (2026-08-16): bug trovato da Luca provando la pagina
// — scritto un obiettivo in Home, la scheda nuova appariva ma vuota. Causa
// (verificata con DOM-finto, non solo lettura): apriStream() usava
// logPerConv.get() ma non creava mai il div .log-conv; logDi() è get-or-create.
// Questo test carica lo <script> della pagina in un contesto con DOM finto
// minimo, apre una conversazione nuova (taskId mai visto) e verifica che il
// log ESISTA e che un evento SSE "risposta" ci scriva davvero dentro.
import vm from "node:vm";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}

const html = fs.readFileSync(join(ROOT, "src", "pagina.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function mkEl(id) {
  return {
    id, style: {}, dataset: {}, children: [], _t: "",
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    appendChild(c){ this.children.push(c); return c; },
    append(...cs){ this.children.push(...cs); },
    addEventListener(){}, querySelector(){ return mkEl("q"); }, querySelectorAll(){ return []; },
    set textContent(v){ this._t = v; }, get textContent(){ return this._t; },
    set hidden(v){ this._h = v; }, get hidden(){ return this._h; },
    remove(){}, scrollTop: 0, scrollHeight: 0, onclick: null, disabled: false,
  };
}
const elems = {};
for (const id of ["log","stato","form-compito","schede-conv","log-conv","chat","chat-head",
  "msg-chat","btn-invia","btn-termina","errore-chat","errore-form","errore-sessioni",
  "btn-aggiorna-sessioni","obiettivo","cwd","msg-ripresa","elenco-sessioni","nota-sessioni",
  "vista-home","vista-sessioni","vista-chat","nav"]) elems[id] = mkEl(id);

const output = [];
const sandbox = {
  console: { log: (...a) => output.push(a.join(" ")), error: (...a) => output.push("ERR:" + a.join(" ")) },
  document: {
    getElementById(id){ if (!elems[id]) elems[id] = mkEl(id); return elems[id]; },
    querySelector(sel){ if (sel.startsWith("meta")) return { content: "0000000000000000000000000000000000000000000000000000000000000000" }; return null; },
    querySelectorAll(){ return []; },
    createElement(){ return mkEl("created"); },
  },
  EventSource: function(url) {
    this.url = url;
    this._listeners = {};
    this.addEventListener = (tipo, fn) => { this._listeners[tipo] = fn; };
    this.close = () => {};
  },
  setInterval(){ return 0; }, clearInterval(){}, setTimeout(){ return 0; },
  Date, JSON, Map, Set, AbortController: function(){ return { signal: {}, abort(){} }; },
};
vm.createContext(sandbox);

// appendice: apre una conversazione mai vista, verifica il log, e SIMULA un
// evento SSE "risposta" come farebbe lo stream vero → deve finire nel div.
const appendice = `
var TASK = "TASK_MAI_VISTO_" + Date.now();
apriConversazione(TASK);
var logEl = logPerConv.get(TASK);
var esitoLog = logEl ? "log ESISTE" : "log UNDEFINED";
var esSse = esPerConv.get(TASK);
esSse._listeners["risposta"]({ data: JSON.stringify({ testo: "risposta di prova dal server", ts: "2026-08-16T00:00:00.000Z" }) });
var esitoScritto = (logEl && logEl.children.length > 0) ? "risposta scritta nel log" : "log vuoto";
console.log("ESITO_LOG=" + esitoLog + "|" + esitoScritto);
`;
let esito = null;
try {
  vm.runInContext(script + appendice, sandbox);
} catch (e) {
  output.push("BOOTSTRAP_ERRORE: " + e.message);
}
const riga = output.find((l) => l.includes("ESITO_LOG="));
if (riga) esito = riga.split("=")[1] ?? null;

check("la pagina si carica e apre una conversazione nuova senza crash",
  esito !== null && !output.some((l) => l.includes("BOOTSTRAP_ERRORE")), output.join(" | "));
check("dopo apriConversazione su task mai visto il log ESISTE (fix get-or-create)",
  esito === "log ESISTE|risposta scritta nel log" || (esito ?? "").startsWith("log ESISTE"), esito ?? "nessun esito");
check("un evento SSE 'risposta' scrive davvero nel log (non vuoto per sempre)",
  (esito ?? "").includes("risposta scritta nel log"), esito ?? "");

console.log(`\nRISULTATO SCHEDA VUOTA: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
