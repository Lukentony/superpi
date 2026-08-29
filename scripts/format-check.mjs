#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
}

function checkFile(file) {
  const path = join(ROOT, file);
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return [];

  const text = bytes.toString("utf8");
  const problems = [];
  if (text.includes("\r\n")) problems.push("CRLF");
  if (/[\r]/.test(text.replaceAll("\r\n", ""))) problems.push("bare CR");

  const trailing = text.split("\n").findIndex((line) => /[ \t]+$/.test(line));
  if (trailing !== -1) problems.push(`trailing whitespace alla riga ${trailing + 1}`);
  if (text.length > 0 && !text.endsWith("\n")) problems.push("newline finale mancante");

  if (extname(file) === ".json") {
    try {
      const parsed = JSON.parse(text);
      const canonical = `${JSON.stringify(parsed, null, 2)}\n`;
      if (canonical !== text) problems.push("JSON non formattato con indentazione di 2 spazi");
    } catch (error) {
      problems.push(`JSON non valido: ${error.message}`);
    }
  }
  return problems;
}

let ok = true;
for (const file of trackedFiles()) {
  const problems = checkFile(file);
  if (problems.length) {
    ok = false;
    for (const problem of problems) console.error(`  FAIL ${file}: ${problem}`);
  }
}

if (!ok) process.exit(1);
console.log("[format:check] PASS (whitespace, newline e invarianti JSON)");
