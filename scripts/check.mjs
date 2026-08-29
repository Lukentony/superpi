#!/usr/bin/env node
// Repository gate: syntax, JSON, shell syntax, and tracked secret-looking
// filenames. It intentionally uses only the standard library and git.
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function run(command, args, label) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "pipe" });
    console.log(`  OK ${label}`);
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
    return false;
  }
  return true;
}

let ok = true;
let files;
try {
  files = trackedFiles();
} catch (error) {
  console.error(`FAIL git ls-files: ${error.message}`);
  process.exit(1);
}

const javascript = files.filter((file) => [".mjs", ".js", ".cjs"].includes(extname(file)));
console.log(`[check] node --check (${javascript.length} file)`);
for (const file of javascript) ok = run(process.execPath, ["--check", file], file) && ok;

const shell = files.filter((file) => extname(file) === ".sh");
console.log(`[check] bash -n (${shell.length} file)`);
for (const file of shell) ok = run("bash", ["-n", file], file) && ok;

const json = files.filter((file) => extname(file) === ".json");
console.log(`[check] JSON.parse (${json.length} file)`);
for (const file of json) {
  try {
    JSON.parse(readFileSync(join(ROOT, file), "utf8"));
    console.log(`  OK ${file}`);
  } catch (error) {
    console.error(`  FAIL ${file}: ${error.message}`);
    ok = false;
  }
}

const safeExample = /\.(example|sample|template)$/i;
const secretLooking = files.filter((file) => {
  const name = basename(file);
  if (safeExample.test(name)) return false;
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /(?:secret|credential|password|token|private[-_]?key)/i.test(name) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|netrc|npmrc)$/i.test(name)
  );
});
console.log("[check] tracked secret-looking filenames");
if (secretLooking.length) {
  console.error(`  FAIL ${secretLooking.join(", ")}`);
  ok = false;
} else {
  console.log("  OK nessun file secret-looking tracciato");
}

if (!ok) process.exit(1);
console.log("[check] PASS");
