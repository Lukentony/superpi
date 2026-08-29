#!/usr/bin/env node
// Cleanup esplicito: non attraversa mai la directory dei workdir.
import { homedir } from "node:os";
import { join } from "node:path";
import { lstatSync, readdirSync, rmSync } from "node:fs";

if (process.env.SUPERPI_CONFIRM_CLEANUP !== "1") {
  console.error("Cleanup annullato: imposta SUPERPI_CONFIRM_CLEANUP=1 per confermare.");
  process.exit(1);
}

const stateDir = join(homedir(), ".local", "state", "superpi");
const targets = ["note", "sessions"];
let removed = 0;

try {
  if (!lstatSync(stateDir).isDirectory()) {
    console.log("Cleanup saltato: la directory di stato non è valida.");
    process.exit(0);
  }
} catch {
  console.log("Nessuna directory di stato da pulire.");
  process.exit(0);
}

for (const name of targets) {
  const directory = join(stateDir, name);
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    console.log(`Nessuna directory ${name} da pulire.`);
    continue;
  }
  if (!stat.isDirectory()) {
    console.log(`Salto ${name}: non è una directory.`);
    continue;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    console.log(`Rimuovo ${name}/${entry.name}`);
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
}

console.log(`Cleanup completato: ${removed} elemento/i rimosso/i.`);
