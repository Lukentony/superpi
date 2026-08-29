// Three chat regressions in pagina.html: user styling, ordering, and deduplication.
// found during manual resume testing:
//  1. il messaggio dell'utente non aveva colore (usava .grezzo, confuso col
//     rumore tecnico) -> classe .utente propria (bordo azzurro, terzo stile)
//  2. l'ultima risposta si ripeteva a ogni riapertura della scheda (lo snapshot
//     di /eventi/<id> rimanda ultimaRisposta; il log non si svuota) -> dedup su
//     ts (risposte) e id (dialoghi), verificato con DOM-finto 1->1->1
//  3. il campo di scrittura stava sopra il log -> #chat spostato dopo #log-conv
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

// ---- check statici (1 e 3) ----
check("1: classe .utente definita nel CSS (terzo stile, non verde/grezzo)", /\.utente\s*\{/.test(html), "");
const cssUtente = html.match(/\.utente\s*\{[^}]*\}/)?.[0] ?? "";
check("1: .utente usa un colore/bordo distinto dalla risposta (blu, non verde)", /var\(--blu\)/.test(cssUtente) && !/var\(--verde\)/.test(cssUtente), cssUtente.slice(0, 80));
check("1: il messaggio inviato usa la classe .utente", /className\s*=\s*"utente"/.test(script), "");
const iLog = html.indexOf('id="log-conv"');
const iChat = html.indexOf('id="chat"');
check("3: nel markup #log-conv viene PRIMA di #chat (input in fondo)", iLog > -1 && iChat > -1 && iLog < iChat, `log=${iLog} chat=${iChat}`);

// ---- check 2 con DOM-finto: la risposta NON si duplica alle riaperture ----
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
const out = [];
const sandbox = {
  console: { log: (...a) => out.push(a.join(" ")), error: (...a) => out.push("E:" + a.join(" ")) },
  document: {
    getElementById(id){ if (!elems[id]) elems[id] = mkEl(id); return elems[id]; },
    querySelector(sel){ if (sel.startsWith("meta")) return { content: "0000000000000000000000000000000000000000000000000000000000000000" }; return null; },
    querySelectorAll(){ return []; },
    createElement(){ return mkEl("created"); },
  },
  EventSource: function(url){ this.url=url; this._listeners={}; this.addEventListener=(t,f)=>{this._listeners[t]=f;}; this.close=()=>{}; },
  setInterval(){ return 0; }, clearInterval(){}, setTimeout(){ return 0; },
  Date, JSON, Map, Set, AbortController: function(){ return { signal:{}, abort(){} }; },
};
vm.createContext(sandbox);
const appendice = `
var T = "T-DUP";
var TS = "2026-08-18T10:00:00.000Z";
apriConversazione(T);
var logEl = logPerConv.get(T);
var es1 = esPerConv.get(T);
es1._listeners["risposta"]({ data: JSON.stringify({ testo: "una risposta", ts: TS }) });
var c1 = Array.from(logEl.children).filter(function(c){ return c.className === "risposta"; }).length;
chiudiStream(T); convAttiva = null; mostraVista("home");
apriConversazione(T);
var es2 = esPerConv.get(T);
es2._listeners["risposta"]({ data: JSON.stringify({ testo: "una risposta", ts: TS }) });
var c2 = Array.from(logEl.children).filter(function(c){ return c.className === "risposta"; }).length;
chiudiStream(T); convAttiva = null; mostraVista("home");
apriConversazione(T);
var es3 = esPerConv.get(T);
es3._listeners["risposta"]({ data: JSON.stringify({ testo: "una risposta", ts: TS }) });
var c3 = Array.from(logEl.children).filter(function(c){ return c.className === "risposta"; }).length;
console.log("DUP:" + c1 + "|" + c2 + "|" + c3);
`;
try { vm.runInContext(script + appendice, sandbox); }
catch (e) { out.push("ERRORE:" + e.message); }
const dup = (out.find((l) => l.includes("DUP:")) ?? "").split("DUP:")[1] ?? "?";
check("2: risposta presente dopo l'APERTURA (1)", dup.split("|")[0] === "1", dup);
check("2: NON duplicata alla prima riapertura (1, non 2)", dup.split("|")[1] === "1", dup);
check("2: NON duplicata alla terza apertura (1, non 3)", dup.split("|")[2] === "1", dup);

console.log(`\nRISULTATO TRE BUG: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
