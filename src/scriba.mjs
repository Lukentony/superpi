// Deterministic scribe: append-only notes for child tool events.
//
// Per ogni tool_execution_end ricevuto via onEvent(), appende una riga JSONL
// su un file per sessione:
//   {"ts": "<ISO 8601>", "toolName": "...", "args": {...}, "result": {...}, "isError": false}
//
// Gli args non stanno sull'evento tool_execution_end (che porta solo
// result/isError): vengono presi dal tool_execution_start accoppiato via
// toolCallId — stesso meccanismo dell'interactive mode di Pi. Zero
// interpretazione: nessun modello nel mezzo.
//
// Formato append-only, mai riscritto. La scrittura è sincrona (appendFileSync)
// così una riga è su disco nel momento in cui l'evento è stato ricevuto.
// onEvent ritorna la riga JSONL scritta (o undefined): il chiamante può
// inoltrarla identica altrove (es. lo stream SSE della pagina, Fase 9).
import { appendFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

const MODALITA_SCRIBA = new Set(["metadata", "full", "off"]);

export function validaModalitaScriba(mode) {
  if (!MODALITA_SCRIBA.has(mode)) {
    throw new Error(
      `Modalità scriba non valida: ${String(mode)} (validi: metadata, full, off)`,
    );
  }
  return mode;
}

// Le chiamate dirette mantengono il formato full storico; il server sceglie
// esplicitamente metadata per non persistere args e result.
export function creaScriba(filePath, log = () => {}, options = {}) {
  if (typeof log === "object" && log !== null) {
    options = log;
    log = () => {};
  }
  if (typeof log !== "function") throw new TypeError("log deve essere una funzione");
  const mode = validaModalitaScriba(
    typeof options === "string" ? options : options?.mode ?? "full",
  );
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const argsPerCall = new Map(); // toolCallId -> args (dal tool_execution_start)
  return {
    filePath,
    mode,
    onEvent(e) {
      if (e.type === "tool_execution_start") {
        if (mode === "full") argsPerCall.set(e.toolCallId, e.args);
        return undefined;
      }
      if (e.type !== "tool_execution_end") return undefined;
      const metadati = {
        ts: new Date().toISOString(),
        toolName: e.toolName,
        isError: e.isError,
      };
      const riga = JSON.stringify(
        mode === "full"
          ? {
              ts: metadati.ts,
              toolName: metadati.toolName,
              args: argsPerCall.get(e.toolCallId) ?? null,
              result: e.result,
              isError: metadati.isError,
            }
          : metadati,
      );
      argsPerCall.delete(e.toolCallId);
      if (mode !== "off") {
        appendFileSync(filePath, riga + "\n", { mode: 0o600 });
        chmodSync(filePath, 0o600);
      }
      log(`[scriba] ${e.toolName} isError=${e.isError}`);
      return riga;
    },
  };
}
