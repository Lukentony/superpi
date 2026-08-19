// Fase 2 — scriba: presa d'appunti deterministica
// (guida hive/appunti/superpi-guida-2026-08-10.md §4.4).
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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function creaScriba(filePath, log = () => {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const argsPerCall = new Map(); // toolCallId -> args (dal tool_execution_start)
  return {
    filePath,
    onEvent(e) {
      if (e.type === "tool_execution_start") {
        argsPerCall.set(e.toolCallId, e.args);
        return undefined;
      }
      if (e.type !== "tool_execution_end") return undefined;
      const riga = JSON.stringify({
        ts: new Date().toISOString(),
        toolName: e.toolName,
        args: argsPerCall.get(e.toolCallId) ?? null,
        result: e.result,
        isError: e.isError,
      });
      appendFileSync(filePath, riga + "\n");
      log(`[scriba] ${e.toolName} isError=${e.isError}`);
      return riga;
    },
  };
}
