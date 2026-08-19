// Estensione "conduttore" — il figlio con cui si parla di superPi stesso.
// Verificata dal vivo il 2026-08-13 (scratch: strada A, 9/9 check) e spostata
// qui invariata. Caricata dal server con:
//   -e extensions/conduttore.ts --tools bash,leggi_conversazioni,manda_messaggio
// (il Passo 0 della costruzione ha verificato che --tools è un'allowlist che
// filtra ANCHE gli strumenti delle estensioni: vanno nominati esplicitamente).
// Il token CSRF arriva via env (SUPERPI_TOKEN) — mai nei log.
//
// GUARDIA: VOLUTAMENTE ASSENTE crea_conversazione. Aprire conversazioni nuove
// resta sempre un'azione di Luca attraverso il gate (POST /task, /riprendi),
// mai del conduttore — qualunque richiesta in quel senso va rifiutata.
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "leggi_conversazioni",
    label: "Leggi conversazioni",
    description:
      "Elenca le conversazioni attive sul server superPi (id, nome, stato). " +
      "Usa il server e il token CSRF dalle variabili d'ambiente SUPERPI_URL e SUPERPI_TOKEN.",
    parameters: Type.Object({}),
    async execute() {
      const url = process.env.SUPERPI_URL;
      const token = process.env.SUPERPI_TOKEN;
      if (!url || !token) {
        return { content: [{ type: "text", text: "ERRORE: SUPERPI_URL/SUPERPI_TOKEN non impostate" }], details: {} };
      }
      const r = await fetch(`${url}/conversazioni`, { headers: { "X-CSRF-Token": token } });
      if (!r.ok) {
        return { content: [{ type: "text", text: `ERRORE HTTP ${r.status}: ${await r.text()}` }], details: {} };
      }
      const data = await r.json();
      const conv = data.conversazioni ?? [];
      const righe = conv.map((c) => `- ${c.id} | ${c.nome} | stato=${c.stato} | dialogo=${c.dialogoInSospeso}`);
      return {
        content: [{ type: "text", text: `${conv.length} conversazioni:\n${righe.join("\n")}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "manda_messaggio",
    label: "Manda messaggio",
    description:
      "Manda un messaggio a UNA conversazione ESISTENTE sul server superPi, data la sua id. " +
      "Non crea conversazioni nuove.",
    parameters: Type.Object({
      id: Type.String({ description: "id della conversazione esistente" }),
      testo: Type.String({ description: "testo del messaggio" }),
    }),
    async execute(_toolCallId, params) {
      const url = process.env.SUPERPI_URL;
      const token = process.env.SUPERPI_TOKEN;
      if (!url || !token) {
        return { content: [{ type: "text", text: "ERRORE: SUPERPI_URL/SUPERPI_TOKEN non impostate" }], details: {} };
      }
      const r = await fetch(`${url}/messaggio`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({ taskId: params.id, testo: params.testo }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        return { content: [{ type: "text", text: `ERRORE HTTP ${r.status}: ${body.errore ?? ""}` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `messaggio inviato a ${params.id}: ${body.accodato ? "accodato" : "inviato"}` }],
        details: {},
      };
    },
  });
}
