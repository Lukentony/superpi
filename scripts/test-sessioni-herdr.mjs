// Test adapter sessioni (2026-08-27) — deterministico, SENZA Herdr/tmux reali
// e SENZA spawn di figli: `herdr`, `tmux` e `claude` sono binari finti nel
// PATH, con output pilotato da file JSON nella cartella temporanea. Copre:
// elenco Herdr (schema, identità=sessioneId, pid, cwd, snippet, età), risolvi-
// zione del target per la ripresa (pi ok, claude rifiutato, identità assente),
// stato "sta lavorando" da agent_status, e fallback a tmux quando herdr non
// risponde.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "superpi-herdr-"));
const bin = join(dir, "bin");
mkdirSync(bin);

const fakeHerdr = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const emit = (o) => console.log(JSON.stringify(o));
const notFound = () => { console.error(JSON.stringify({ error: { code: "agent_not_found" } })); process.exit(1); };
if (args[0] === "agent" && args[1] === "list") {
  if (process.env.FAKE_HERDR_MODE === "fail") { console.error("connection refused"); process.exit(1); }
  const file = process.env.FAKE_HERDR_MODE === "unstable" ? "/agents-unstable.json" : "/agents.json";
  emit({ id: "cli:agent:list", result: { agents: JSON.parse(readFileSync(dir + file, "utf8")) }, type: "agent_list" });
} else if (args[0] === "agent" && args[1] === "get") {
  const t = args[2];
  try { emit({ id: "cli:agent:get", result: { agent: JSON.parse(readFileSync(dir + "/agent-" + t + ".json", "utf8")) }, type: "agent_info" }); }
  catch { notFound(); }
} else if (args[0] === "agent" && args[1] === "read") {
  const t = args[2];
  try { process.stdout.write(readFileSync(dir + "/snippet-" + t + ".txt", "utf8")); }
  catch { /* vuoto */ }
} else if (args[0] === "pane" && args[1] === "process-info") {
  let pane = null;
  for (let i = 0; i < args.length; i++) if (args[i] === "--pane") pane = args[i + 1];
  try { emit({ id: "cli:pane:process_info", result: { process_info: JSON.parse(readFileSync(dir + "/pi-" + pane + ".json", "utf8")) }, type: "pane_process_info" }); }
  catch { console.error(JSON.stringify({ error: { code: "pane_not_found" } })); process.exit(1); }
} else { process.exit(1); }
`;
const fakeTmux = `#!/bin/sh
case "$1" in
  list-panes) echo "test:win|999999|pi"; exit 0;;
  capture-pane) echo "snippet tmux"; exit 0;;
  *) exit 1;;
esac
`;
const fakeClaude = `#!/bin/sh
echo '[{"sessionId":"c1","name":"claude-sess","status":"running","pid":7,"cwd":"/tmp/x","startedAt":1750000000000}]';
exit 0;
`;

writeFileSync(join(bin, "herdr"), fakeHerdr);
writeFileSync(join(bin, "tmux"), fakeTmux);
writeFileSync(join(bin, "claude"), fakeClaude);
chmodSync(join(bin, "herdr"), 0o755);
chmodSync(join(bin, "tmux"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

// --- dati pilotati ---------------------------------------------------------
const sessDir = join(dir, "sessions", "--home-u-hive--");
mkdirSync(sessDir, { recursive: true });
const SESS_VALUE = join(sessDir, "2026-08-25T16-38-17-223Z_01a039c9-6d87-7c94-a6a5-ca2cb24213a8.jsonl");
writeFileSync(SESS_VALUE, [
  JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" }),
  JSON.stringify({ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-luna" } }),
].join("\n") + "\n");
const agentPi = (status, sessValue = SESS_VALUE, pane = "p4") => ({
  agent: "pi",
  agent_session: sessValue ? { agent: "pi", kind: "path", source: "herdr:pi", value: sessValue } : null,
  agent_status: status,
  cwd: "/home/u/hive",
  foreground_cwd: "/home/u/hive",
  pane_id: pane,
  terminal_title_stripped: "π - hive",
});
writeFileSync(join(dir, "agents.json"), JSON.stringify([
  agentPi("idle"),
  { agent: "claude", agent_session: { agent: "claude", kind: "path", source: "herdr:claude", value: "/home/u/.claude/foo.jsonl" }, agent_status: "idle", cwd: "/home/u/hive", foreground_cwd: "/home/u/hive", pane_id: "p5", terminal_title_stripped: "claude" },
]));
writeFileSync(join(dir, "agents-unstable.json"), JSON.stringify([agentPi("idle", null, "p7")]));
writeFileSync(join(dir, "agent-p4.json"), JSON.stringify(agentPi("idle")));
writeFileSync(join(dir, "agent-p5.json"), JSON.stringify({ agent: "claude", agent_session: { agent: "claude", kind: "path", source: "herdr:claude", value: "/home/u/.claude/foo.jsonl" }, agent_status: "idle", cwd: "/home/u/hive", foreground_cwd: "/home/u/hive", pane_id: "p5" }));
writeFileSync(join(dir, "agent-p6.json"), JSON.stringify(agentPi("working", SESS_VALUE, "p6")));
writeFileSync(join(dir, "agent-p7.json"), JSON.stringify(agentPi("idle", null, "p7")));
writeFileSync(join(dir, "pi-p4.json"), JSON.stringify({ foreground_process_group_id: 1, foreground_processes: [{ argv: ["pi"], cmdline: "pi", cwd: "/home/u/hive", name: "pi", pid: 4242 }], pane_id: "p4", shell_pid: 4240 }));
writeFileSync(join(dir, "snippet-p4.txt"), "riga 1\nriga 2\nultima riga del pane\n");

process.env.FAKE_DIR = dir;
process.env.PATH = bin + ":" + (process.env.PATH ?? "");
process.env.FAKE_HERDR_MODE = "ok";

const { leggiSessioni, risolviFinestra, staLavorando } = await import("../src/sessioni.mjs");

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}

console.log("[sessioni] === elenco Herdr (leggiSessioni) ===");
const lista = leggiSessioni();
check("1: struttura invariata (lettaIl + finestre + claude)", typeof lista.lettaIl === "string" && Array.isArray(lista.finestre) && Array.isArray(lista.claude), JSON.stringify(Object.keys(lista)));
check("1: pi e claude presenti", lista.finestre.some((v) => v.cmd === "pi") && lista.finestre.some((v) => v.cmd === "claude"));
const pi = lista.finestre.find((v) => v.cmd === "pi");
check("1: nome = pane_id (chiave stabile e risolvibile)", pi.nome === "p4", JSON.stringify(pi.nome));
check("1: sessioneId estratto dall'identità Herdr (uuid)", pi.sessioneId === "01a039c9-6d87-7c94-a6a5-ca2cb24213a8", JSON.stringify(pi.sessioneId));
check("1: pid dal process-info", pi.pid === 4242, JSON.stringify(pi.pid));
check("1: cwd da foreground_cwd", pi.cwd === "/home/u/hive", JSON.stringify(pi.cwd));
check("1: età dall'orario nel nome file (etaMs >= 0)", typeof pi.etaMs === "number" && pi.etaMs >= 0, JSON.stringify(pi.etaMs));
check("1: snippet presente e non vuoto", typeof pi.snippet === "string" && pi.snippet.length > 0 && pi.snippet.includes("riga"), JSON.stringify(pi.snippet));
check("1: pi con identità non ha motivoNoId", pi.motivoNoId === null);
const cl = lista.finestre.find((v) => v.cmd === "claude");
check("1: claude in finestre non ha sessioneId (non riprendibile)", cl.sessioneId === null);
check("1: elenco claude agents separato popolato", lista.claude.length === 1 && lista.claude[0].name === "claude-sess", JSON.stringify(lista.claude));

console.log("[sessioni] === risoluzione target per la ripresa (risolviFinestra) ===");
const ok = risolviFinestra("p4");
check("2: target pi -> ok con identità completa", ok.ok && ok.sorgente === "herdr" && ok.sessioneId === "01a039c9-6d87-7c94-a6a5-ca2cb24213a8" && ok.pid === 4242 && ok.cwd === "/home/u/hive", JSON.stringify(ok));
check("2: sessioneDir = cartella del file di sessione", ok.ok && ok.sessioneDir.endsWith("--home-u-hive--"), JSON.stringify(ok.sessioneDir));
check("2: ripresa conserva provider/modello della sessione", ok.ok && ok.provider === "openai-codex" && ok.modello === "gpt-5.6-luna", JSON.stringify({ provider: ok.provider, modello: ok.modello }));
const claude = risolviFinestra("p5");
check("2: target claude -> 400 (controllo solo per pi)", !claude.ok && claude.status === 400 && claude.motivo.includes("non è una sessione pi"), JSON.stringify(claude));
const noId = risolviFinestra("p7");
check("2: pi senza identità -> 400 (impossibile riprendere)", !noId.ok && noId.status === 400, JSON.stringify(noId));
const sconosciuto = risolviFinestra("w9:pZZZ");
check("2: target ignoto -> fallback tmux -> 404", !sconosciuto.ok && sconosciuto.status === 404, JSON.stringify(sconosciuto));

console.log("[sessioni] === stato 'sta lavorando' da agent_status (Herdr) ===");
check("3: idle -> false (ferma)", (await staLavorando("p4", "herdr")) === false);
check("3: working -> true (lavorando)", (await staLavorando("p6", "herdr")) === true);

console.log("[sessioni] === fallback a tmux quando l'identità Herdr non è stabile ===");
process.env.FAKE_HERDR_MODE = "unstable";
const unstable = leggiSessioni();
check("4: identità Herdr incompleta -> fallback tmux", unstable.finestre.some((v) => v.sorgente === "tmux"), JSON.stringify(unstable.finestre));
process.env.FAKE_HERDR_MODE = "fail";
const fb = leggiSessioni();
check("5: herdr giù -> si usa tmux (finestra pi presente)", fb.finestre.some((v) => v.cmd === "pi" && v.sorgente === "tmux"), JSON.stringify(fb.finestre));
check("5: tmux con pid inesistente -> motivoNoId 'processo non trovato' (mai un crash)", fb.finestre.some((v) => v.motivoNoId === "processo non trovato"), JSON.stringify(fb.finestre));
const fbRes = risolviFinestra("other:win");
check("5: risolviFinestra su tmux senza la finestra -> 404, nessun errore", !fbRes.ok && fbRes.status === 404, JSON.stringify(fbRes));
process.env.FAKE_HERDR_MODE = "ok";

console.log(`\nRISULTATO TEST SESSIONI-HERDR: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
