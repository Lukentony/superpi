// Passo 0 — verifica dal vivo di RpcClient (guida hive/appunti/superpi-guida-2026-08-10.md §4.1).
// Figlio: mai in $HOME, mai in hive. CWD e session-dir in .test-run/.
import { RpcClient } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SESSION_DIR, CWD_DIR } from "./_paths.mjs";

mkdirSync(CWD_DIR, { recursive: true });
mkdirSync(SESSION_DIR, { recursive: true });

// dist/cli.js non è nella exports map del pacchetto: risolto come path del
// filesystem a partire dall'export "." (dist/index.js). Vedi src/spawner.mjs.
const INDEX_PATH = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const CLI_PATH = join(dirname(INDEX_PATH), "cli.js");

const client = new RpcClient({
  cliPath: CLI_PATH,
  cwd: CWD_DIR,
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  args: ["--session-id", crypto.randomUUID(), "-n", "verifica-rpcclient", "--session-dir", SESSION_DIR],
});

const events = [];
const t0 = Date.now();

// Timeout esterno JS di sicurezza (oltre a waitForIdle e al timeout shell):
// bug noto — pi --mode rpc con le estensioni globali a volte non esce da solo.
const hardTimer = setTimeout(() => {
  console.error("HARD TIMEOUT: nessun agent_settled entro 90s, esco forzatamente");
  process.exit(3);
}, 90000);

const ordineAtteso = ["agent_start", "turn_start", "message_start", "message_end", "agent_settled"];

try {
  await client.start();
  client.onEvent((e) => {
    events.push(e.type);
    console.log(`${String(Date.now() - t0).padStart(6)}ms ${e.type}`);
  });
  await client.prompt("Rispondi con esattamente la parola PONG e nient'altro.");
  const waitStart = Date.now();
  await client.waitForIdle(30000);
  const waitMs = Date.now() - waitStart;
  console.log(`\nwaitForIdle ritornato in ${waitMs}ms (senza eccezioni)`);

  let i = 0;
  for (const t of events) if (t === ordineAtteso[i]) i++;
  const ordineOk = i === ordineAtteso.length;
  console.log(`Eventi attesi nell'ordine relativo: ${ordineOk ? "SÌ" : "NO"} (${i}/${ordineAtteso.length})`);
  if (!ordineOk) console.log(`   stream ricevuto: ${events.join(", ")}`);

  const hasSettled = events.includes("agent_settled");
  console.log(`agent_settled ricevuto: ${hasSettled ? "SÌ" : "NO"}`);

  const last = await client.getLastAssistantText();
  console.log(`Ultimo testo assistente: ${JSON.stringify(last)}`);

  const ok = ordineOk && hasSettled;
  console.log(`\nRISULTATO PASSO 0: ${ok ? "PASS" : "FAIL"}`);
  await client.stop();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(`ECCEZIONE: ${err.message}`);
  console.error(`stderr del figlio: ${client.getStderr()}`);
  process.exit(2);
} finally {
  clearTimeout(hardTimer);
}
