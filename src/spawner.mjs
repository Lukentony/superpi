// Fase 1 — spawner: wrapping di RpcClient con identità decisa dal chiamante
// e timeout configurabile (guida hive/appunti/superpi-guida-2026-08-10.md §4.1, §6 Fase 1).
//
// Ogni operazione (start/prompt/waitForIdle) è avvolta in un timeout esterno,
// oltre a quelli interni di waitForIdle: bug noto — pi --mode rpc con le
// estensioni globali a volte non esce da solo.
import { RpcClient } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// RpcClient, senza cliPath esplicito, cerca dist/cli.js relativo alla cwd del
// FIGLIO, non alla posizione del pacchetto — non è nei tipi, scoperto da un
// MODULE_NOT_FOUND al primo run vero in questo repo. dist/cli.js non è nella
// exports map del pacchetto (solo ".", "./rpc-entry", "./client"): risolto
// come path del filesystem a partire dall'export "." (dist/index.js), mai
// importato come modulo.
const INDEX_PATH = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const CLI_PATH = join(dirname(INDEX_PATH), "cli.js");

// Timeout esterno su una promise: se scade, rifiuta e invoca onTimeout (es. stop()).
export function conTimeout(promise, ms, desc, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT ${ms}ms: ${desc}`));
      if (onTimeout) onTimeout().catch(() => {});
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Identità decisa dal chiamante: sessionId (UUID v4) e nome leggibile.
// Se il chiamante non passa sessionId, lo genera lui con crypto.randomUUID().
// resumeSessionId: riprende una sessione ESISTENTE con --session <id> INVECE di
// --session-id <id> (i due flag non sono combinabili — verificato dal vivo il
// 2026-08-12: "--session-id cannot be combined with --session").
export function creaFiglio({
  cwd,
  nome,
  sessionId,
  sessionDir,
  provider = "opencode-go",
  model = "deepseek-v4-flash",
  timeoutMs = 300000,
  resumeSessionId = null,
  extraArgs = [],
  env = undefined,
}) {
  const id = sessionId ?? crypto.randomUUID();
  const args = resumeSessionId
    ? ["--session", resumeSessionId, "-n", nome, "--session-dir", sessionDir, ...extraArgs]
    : ["--session-id", id, "-n", nome, "--session-dir", sessionDir, ...extraArgs];
  const client = new RpcClient({
    cliPath: CLI_PATH,
    cwd,
    provider,
    model,
    args,
    env,
  });
  return { client, sessionId: id, nome, timeoutMs };
}

export async function avviaFiglio(figlio, timeoutMs = figlio.timeoutMs) {
  await conTimeout(figlio.client.start(), timeoutMs, `start() del figlio ${figlio.nome}`);
  return figlio;
}

export async function promptFiglio(figlio, messaggio, timeoutMs = figlio.timeoutMs) {
  await conTimeout(figlio.client.prompt(messaggio), timeoutMs, `prompt() del figlio ${figlio.nome}`);
}

export async function attendiIdle(figlio, timeoutMs = figlio.timeoutMs) {
  await conTimeout(
    figlio.client.waitForIdle(timeoutMs),
    timeoutMs + 5000,
    `waitForIdle() del figlio ${figlio.nome}`,
  );
}

export async function fermaFiglio(figlio) {
  try {
    await conTimeout(figlio.client.stop(), 10000, `stop() del figlio ${figlio.nome}`);
  } catch {
    // processo già morto o stop già in corso: ok
  }
}
