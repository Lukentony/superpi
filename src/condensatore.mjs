// Deterministic condenser: derives a compact state from the append-only tool log.
//
// Legge il file grezzo dello scriba e produce:
//   {obiettivo, fatto, in_corso, bloccato_su, eta_ultimo_evento}
//
// Mai una domanda al figlio ("riassumi cosa hai fatto"): input = solo il grezzo
// + l'obiettivo dichiarato dal chiamante + il fatto osservato dal chiamante che
// il figlio è settled (agent_settled ricevuto). Nessun modello nel mezzo: il
// condensato è derivato deterministicamente dal grezzo, verificabile a ritroso
// riga per riga. I campi testo sono troncati in modo difensivo (CAP): il grezzo
// resta la fonte completa.
import { readFileSync } from "node:fs";

const CAP = 500;

function corto(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > CAP ? s.slice(0, CAP) + "…" : s;
}

export function condensa({ noteFile, obiettivo, settled = false }) {
  let righe;
  try {
    righe = readFileSync(noteFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((r) => JSON.parse(r));
  } catch (e) {
    if (e.code === "ENOENT") {
      // Nessun tool eseguito (es. un figlio ripreso che risponde solo con
      // testo): il file note non è mai stato creato — grezzo vuoto legittimo,
      // non un errore. Corretto il 2026-08-12 (prima: "ERRORE LETTURA GREZZO"
      // anche per un task senza tool call).
      righe = [];
    } else {
      return {
        obiettivo,
        fatto: [],
        in_corso: null,
        bloccato_su: `ERRORE LETTURA GREZZO: ${e.message}`,
        eta_ultimo_evento: null,
      };
    }
  }

  const fatto = [];
  let bloccato_su = null;
  let eta_ultimo_evento = null;
  for (const r of righe) {
    if (r.ts) eta_ultimo_evento = r.ts;
    if (r.isError) {
      // l'ultimo errore vince: è ciò su cui il figlio è bloccato
      bloccato_su = `${r.toolName} ha fallito: ${corto(r.result)}`;
    } else {
      fatto.push({ ts: r.ts, toolName: r.toolName, args: r.args });
    }
  }

  // in_corso: con il solo grezzo non si può sapere se il figlio sta ancora
  // lavorando — lo dice il chiamante (settled = agent_settled ricevuto dopo
  // l'ultimo evento). Se non settled, l'ultimo tool eseguito è l'attività
  // in corso o interrotta; la sua età è in eta_ultimo_evento.
  const in_corso = settled ? null : fatto.length ? fatto[fatto.length - 1] : null;

  return { obiettivo, fatto, in_corso, bloccato_su, eta_ultimo_evento };
}
