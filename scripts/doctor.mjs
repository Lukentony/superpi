#!/usr/bin/env node
// Preflight locale: non legge né stampa valori di configurazione sensibili.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

const ROOT = join(homedir(), ".local", "state", "superpi");
const ROUTER_CONFIG =
  process.env.SUPERPI_ROUTER_CONFIG ?? join(homedir(), ".config", "superpi", "router.json");
const NODE_MIN = [22, 19, 0];

function versioneNodeValida() {
  const versione = process.versions.node.split(".").map(Number);
  for (let i = 0; i < NODE_MIN.length; i += 1) {
    if (versione[i] !== NODE_MIN[i]) return versione[i] > NODE_MIN[i];
  }
  return true;
}

function comandoDisponibile(comando, args = ["--version"]) {
  const result = spawnSync(comando, args, {
    stdio: "ignore",
    timeout: 5000,
  });
  return !result.error && result.status === 0;
}

function controllaComando(nome, { richiesto = false, args } = {}) {
  const ok = comandoDisponibile(nome, args);

  console.log(`${ok ? "OK" : richiesto ? "FAIL" : "WARN"} ${nome} CLI${ok ? " disponibile" : " non disponibile"}`);
  return ok || !richiesto;
}

function controllaDirectory(nome, percorso, privata = false) {
  try {
    const stat = statSync(percorso);
    const privataOk = !privata || (stat.mode & 0o777) === 0o700;
    console.log(
      `${stat.isDirectory() && privataOk ? "OK" : "WARN"} directory ${nome}${
        stat.isDirectory() && !privataOk ? " (permessi da verificare)" : ""
      }`,
    );
  } catch {
    console.log(`WARN directory ${nome} non presente`);
  }
}

function controllaConfig() {
  if (!existsSync(ROUTER_CONFIG)) {
    console.log("WARN configurazione router assente (opzionale)");
    return;
  }
  try {
    JSON.parse(readFileSync(ROUTER_CONFIG, "utf8"));
    console.log("OK configurazione router leggibile");
  } catch {
    console.log("WARN configurazione router non valida");
  }
}

let requiredOk = versioneNodeValida();
console.log(`${requiredOk ? "OK" : "FAIL"} Node.js ${process.versions.node}`);
requiredOk = controllaComando("pi", { richiesto: true }) && requiredOk;
controllaComando("tmux", { args: ["-V"] });
controllaComando("herdr");
controllaComando("tailscale");
controllaDirectory("stato", ROOT, true);
controllaDirectory("note", join(ROOT, "note"), true);
controllaDirectory("sessioni", join(ROOT, "sessions"), true);
controllaDirectory("workdir", process.env.SUPERPI_LAVORI_DIR ?? join(homedir(), "lavori-superpi"));
controllaConfig();

if (!requiredOk) process.exit(1);
