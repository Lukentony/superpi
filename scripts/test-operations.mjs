#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { creaScriba, validaModalitaScriba } from "../src/scriba.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "superpi-operations-"));
let ok = 0;

function verifica(condizione, messaggio) {
  if (!condizione) throw new Error(messaggio);
  console.log(`  OK ${messaggio}`);
  ok += 1;
}

function evento(scriba, id, args, result) {
  scriba.onEvent({ type: "tool_execution_start", toolCallId: id, args });
  return JSON.parse(
    scriba.onEvent({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "bash",
      result,
      isError: false,
    }),
  );
}

try {
  const noteDir = join(temp, "scriba");
  const metadataFile = join(noteDir, "metadata.jsonl");
  const metadata = evento(
    creaScriba(metadataFile, { mode: "metadata" }),
    "m1",
    { token: "ARG_SECRET" },
    "RESULT_SECRET",
  );
  const persisted = readFileSync(metadataFile, "utf8");
  verifica(!("args" in metadata) && !("result" in metadata), "metadata esclude args e result");
  verifica(!persisted.includes("ARG_SECRET") && !persisted.includes("RESULT_SECRET"), "metadata non persiste valori tool");
  verifica((statSync(noteDir).mode & 0o777) === 0o700, "directory note modo 0700");
  verifica((statSync(metadataFile).mode & 0o777) === 0o600, "file note modo 0600");

  const fullFile = join(noteDir, "full.jsonl");
  const full = evento(creaScriba(fullFile, { mode: "full" }), "f1", { a: 1 }, "done");
  verifica(full.args.a === 1 && full.result === "done", "full conserva il formato storico");

  const offFile = join(noteDir, "off.jsonl");
  const off = evento(creaScriba(offFile, { mode: "off" }), "o1", { a: 1 }, "done");
  verifica(!existsSync(offFile) && off.toolName === "bash", "off non crea file ma restituisce metadati live");
  verifica(validaModalitaScriba("metadata") === "metadata", "modalità metadata valida");
  let invalid = false;
  try {
    validaModalitaScriba("unsafe");
  } catch {
    invalid = true;
  }
  verifica(invalid, "modalità sconosciuta rifiutata");

  const home = join(temp, "home");
  const state = join(home, ".local", "state", "superpi");
  const notes = join(state, "note");
  const sessions = join(state, "sessions");
  const external = join(temp, "external");
  const workdir = join(home, "lavori-superpi");
  mkdirSync(notes, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(external, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(notes, "note.jsonl"), "x");
  writeFileSync(join(sessions, "session.json"), "x");
  writeFileSync(join(external, "preserve"), "x");
  writeFileSync(join(workdir, "preserve"), "x");
  symlinkSync(external, join(notes, "external-link"));

  const cleanupScript = join(ROOT, "scripts", "cleanup-state.mjs");
  const denied = spawnSync(process.execPath, [cleanupScript], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  verifica(denied.status === 1 && existsSync(join(notes, "note.jsonl")), "cleanup richiede conferma esplicita");

  const cleaned = spawnSync(process.execPath, [cleanupScript], {
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      SUPERPI_CONFIRM_CLEANUP: "1",
    },
    encoding: "utf8",
  });
  verifica(cleaned.status === 0, "cleanup confermato termina con successo");
  verifica(!existsSync(join(notes, "note.jsonl")) && !existsSync(join(sessions, "session.json")), "cleanup rimuove note e sessioni");
  verifica(existsSync(join(external, "preserve")) && existsSync(join(workdir, "preserve")), "cleanup non segue symlink e non tocca workdir");
  verifica(lstatSync(notes).isDirectory() && lstatSync(sessions).isDirectory(), "cleanup conserva le directory di stato");

  const bin = join(temp, "bin");
  mkdirSync(bin);
  const fakePi = join(bin, "pi");
  writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
  chmodSync(fakePi, 0o755);
  const sentinel = "DO_NOT_PRINT_THIS_SECRET";
  const doctor = spawnSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs")], {
    env: {
      HOME: home,
      PATH: bin,
      SUPERPI_AUTH_PASSWORD: sentinel,
    },
    encoding: "utf8",
  });
  const doctorOutput = `${doctor.stdout}${doctor.stderr}`;
  verifica(doctor.status === 0 && doctorOutput.includes("OK pi CLI"), "doctor passa con Pi disponibile");
  verifica(!doctorOutput.includes(sentinel), "doctor non stampa valori di ambiente");

  console.log(`\nRISULTATO OPERATIONS: PASS (${ok} ok)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
