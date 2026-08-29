// Adapter del pannello sessioni (2026-08-27): Herdr come backend primario,
// tmux come fallback SOLO se Herdr non offre un'identità stabile per la
// ripresa (assente, non avviato o elenco illeggibile).
//
// Verificato dal vivo su Herdr 0.8.2:
//   herdr agent list              -> JSON result.agents[] con agent (kind),
//                                    pane_id, agent_session.value (PATH del
//                                    file di sessione: identità STABILE, molto
//                                    più solida della correlazione temporale
//                                    tmux), agent_status, foreground_cwd, cwd,
//                                    terminal_title(_stripped).
//   herdr agent read <target>     -> testo del terminale (snippet).
//   herdr pane process-info --pane <id> -> JSON con foreground_processes[]
//                                    (pid, cwd, name) del processo pi/claude.
//   herdr agent get <target>      -> JSON result.agent (stesso di list) o
//                                    errore agent_not_found (exit 1).
//
// Contratto con la pagina (INVARIATO): GET /sessioni ritorna
//   { lettaIl, etaLetturaMs, finestre:[{cmd,nome,pid,cwd,sessioneId,motivoNoId,
//     etaMs,etaLetturaMs,snippet}], claude:[{name,sessionId,status,pid,cwd,
//     avviatoIl,etaMs}] }
// e POST /riprendi riceve `finestra` = v.nome. Per Herdr `nome` è il pane_id
// (handle opaco stabile e unico); per il fallback tmux resta session:window.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  readFileSync,
  readlinkSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";

const SESSIONI_DEFAULT_DIR = join(homedir(), ".pi", "agent", "sessions");
const CORRELAZIONE_SOGLIA_MS = 15 * 60 * 1000; // due finestre nella stessa cwd a <15 min: ambigue

function esegui(cmd, args, timeoutMs = 5000) {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    };
  } catch (e) {
    return { ok: false, errore: e.message.split("\n")[0] };
  }
}

// ---------------------------------------------------------------------------
// Herdr
// ---------------------------------------------------------------------------

function herdrAgentList() {
  const r = esegui("herdr", ["agent", "list"], 5000);
  if (!r.ok) return null;
  try {
    const agents = JSON.parse(r.stdout)?.result?.agents;
    return Array.isArray(agents) ? agents : null;
  } catch {
    return null;
  }
}

function herdrAgentGet(target) {
  const r = esegui("herdr", ["agent", "get", target], 5000);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout)?.result?.agent ?? null;
  } catch {
    return null;
  }
}

function herdrProcessInfo(paneId) {
  const r = esegui("herdr", ["pane", "process-info", "--pane", paneId], 5000);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout)?.result?.process_info ?? null;
  } catch {
    return null;
  }
}

// Il file di sessione Herdr è <dir>/2026-08-25T16-38-17-223Z_<uuid>.jsonl:
// l'identità STABILE è l'uuid (per --session) e la directory (per --session-dir).
function sessioneIdDaPath(valore) {
  const m = basename(valore ?? "").match(/^.*_([0-9a-f-]{36})\.jsonl$/);
  return m ? m[1] : null;
}

function avvioDaPath(valore) {
  const m = basename(valore ?? "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/,
  );
  if (!m) return null;
  const t = Date.parse(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`,
  );
  return Number.isNaN(t) ? null : t;
}

// Una ripresa deve conservare il modello della sessione originale: senza
// questi dati creaFiglio ricadrebbe sul default Codex Luna. Il primo model_change o
// l'ultimo messaggio assistente sono fonti locali già presenti nel JSONL.
function modelloDaSessione(valore) {
  if (typeof valore !== "string") return null;
  let righe;
  try {
    righe = readFileSync(valore, "utf8").trim().split("\n").reverse();
  } catch {
    return null;
  }
  for (const riga of righe) {
    try {
      const e = JSON.parse(riga);
      if (
        e.type === "model_change" &&
        typeof e.provider === "string" &&
        typeof e.modelId === "string"
      ) {
        return { provider: e.provider, modello: e.modelId };
      }
      const m = e.message;
      if (
        m?.role === "assistant" &&
        typeof m.provider === "string" &&
        typeof m.model === "string"
      ) {
        return { provider: m.provider, modello: m.model };
      }
    } catch {
      /* riga non JSON: continua */
    }
  }
  return null;
}

function pidValido(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 1 && n !== process.pid ? n : null;
}

function cwdProcesso(pid) {
  try {
    return realpathSync(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    return null;
  }
}

function dirSessione(valore) {
  try {
    return realpathSync(dirname(valore));
  } catch {
    return null;
  }
}

function pidPerPaneHerdr(paneId, comando = "pi") {
  const info = herdrProcessInfo(paneId);
  if (!info?.foreground_processes) return null;
  const proc = info.foreground_processes.find(
    (p) => p.name === comando && pidValido(p.pid),
  );
  return proc ? pidValido(proc.pid) : null;
}

function snippetHerdr(target, maxRighe = 8, maxChar = 400) {
  const r = esegui(
    "herdr",
    [
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(maxRighe),
    ],
    3000,
  );
  if (!r.ok) return "";
  return tagliaSnippet(r.stdout, maxRighe, maxChar);
}

function tagliaSnippet(stdout, maxRighe, maxChar) {
  const righe = stdout
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  const ultime = righe.slice(-maxRighe).join("\n");
  return ultime.length > maxChar ? ultime.slice(-maxChar) : ultime;
}

function statoHerdr(target) {
  const a = herdrAgentGet(target);
  const s = a?.agent_status;
  return typeof s === "string" ? s : null;
}

// true = sta lavorando, false = ferma, null = non leggibile (il chiamante lo
// tratta come "lavorando": mai uccidere una finestra di cui non si sa nulla).
function staLavorandoHerdr(target) {
  const s = statoHerdr(target);
  if (s === "working" || s === "blocked" || s === "unknown") return true;
  if (s === "idle" || s === "done") return false;
  return null;
}

// ---------------------------------------------------------------------------
// tmux (fallback, identico al comportamento pre-Herdr)
// ---------------------------------------------------------------------------

function tmuxPanes() {
  return esegui(
    "tmux",
    [
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_name}|#{pane_pid}|#{pane_current_command}",
    ],
    5000,
  );
}

function snippetTmux(target, maxRighe = 8, maxChar = 400) {
  const r = esegui("tmux", ["capture-pane", "-p", "-t", target], 3000);
  if (!r.ok) return "";
  return tagliaSnippet(r.stdout, maxRighe, maxChar);
}

function pidFiglioPerComm(panePid, comm) {
  const r = esegui("pgrep", ["-P", String(panePid)]);
  if (!r.ok) return null;
  for (const p of r.stdout.trim().split("\n")) {
    const pid = Number(p);
    if (!pidValido(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === comm) return pid;
    } catch {
      /* processo sparito */
    }
  }
  return null;
}

function epochDiAvvio(pid) {
  const r = esegui("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (!r.ok || !r.stdout.trim()) return null;
  const t = Date.parse(r.stdout.trim());
  return Number.isNaN(t) ? null : t;
}

function sanitizzaCwd(cwd) {
  return "--" + cwd.slice(1).replaceAll("/", "-") + "--";
}

function correlazionaSessione(cwd, avviatoIl) {
  const dir = join(SESSIONI_DEFAULT_DIR, sanitizzaCwd(cwd));
  let file;
  try {
    file = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let migliore = null;
  let miglioreDist = Infinity;
  for (const f of file) {
    const m = f.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/,
    );
    if (!m) continue;
    const t = Date.parse(
      `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`,
    );
    if (Number.isNaN(t)) continue;
    const dist = Math.abs(t - avviatoIl);
    if (dist < miglioreDist) {
      migliore = { sessioneId: m[8], distanzaMs: dist, dir };
      miglioreDist = dist;
    }
  }
  return miglioreDist <= CORRELAZIONE_SOGLIA_MS ? migliore : null;
}

async function staLavorandoTmux(target, campioneGapMs) {
  const a = esegui("tmux", ["capture-pane", "-p", "-t", target], 3000);
  await new Promise((r) => setTimeout(r, campioneGapMs));
  const b = esegui("tmux", ["capture-pane", "-p", "-t", target], 3000);
  if (!a.ok || !b.ok) return null;
  return a.stdout !== b.stdout;
}

// ---------------------------------------------------------------------------
// Claude (elenco a parte, fonte invariata: non passa da tmux né da Herdr)
// ---------------------------------------------------------------------------

function claudeAgents(lettaIl) {
  const r = esegui("claude", ["agents", "--json"], 8000);
  if (!r.ok) return [];
  try {
    return JSON.parse(r.stdout).map((a) => ({
      sessionId: a.sessionId ?? null,
      name: a.name ?? null,
      status: a.status ?? null,
      pid: a.pid ?? null,
      cwd: a.cwd ?? null,
      avviatoIl: a.startedAt ? new Date(a.startedAt).toISOString() : null,
      etaMs: a.startedAt ? lettaIl - a.startedAt : null,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// API pubblica
// ---------------------------------------------------------------------------

function finestreHerdr(lettaIl) {
  const agents = herdrAgentList();
  if (!agents) return null;
  const finestre = [];
  for (const a of agents) {
    const cmd = a.agent;
    if (cmd !== "pi" && cmd !== "claude") continue; // contratto pagina: pi/claude
    const paneId = a.pane_id;
    if (!paneId) continue;
    const sessVal = a.agent_session?.value;
    const sessioneId = cmd === "pi" ? sessioneIdDaPath(sessVal) : null;
    const sessionePresente = typeof sessVal === "string" && existsSync(sessVal);
    const avvio = avvioDaPath(sessVal);
    const voce = {
      cmd,
      nome: paneId,
      pid: pidPerPaneHerdr(paneId, cmd),
      cwd: a.foreground_cwd ?? a.cwd ?? null,
      avviatoIl: avvio ? new Date(avvio).toISOString() : null,
      etaMs: avvio ? lettaIl - avvio : null,
      snippet: snippetHerdr(paneId),
      sessioneId,
      motivoNoId:
        cmd === "pi" && (!sessioneId || !sessionePresente)
          ? "nessun file di sessione stabile in Herdr"
          : null,
      sessionePresente,
      etaLetturaMs: 0,
      titolo: a.terminal_title_stripped ?? a.terminal_title ?? null,
      sorgente: "herdr",
    };
    finestre.push(voce);
  }
  // Herdr resta primario solo quando la sua identità è utilizzabile per la
  // ripresa di ogni pi: sessione stabile, PID e cwd. Se almeno un pi è
  // incompleto, il pannello intero torna a tmux (fallback dichiarato dal piano).
  const identitaStabile = finestre
    .filter((v) => v.cmd === "pi")
    .every((v) => v.sessioneId && v.sessionePresente && v.pid && v.cwd);
  return identitaStabile ? finestre : null;
}

function finestreTmux(lettaIl) {
  const finestre = [];
  const r = tmuxPanes();
  if (r.ok) {
    for (const riga of r.stdout.trim().split("\n")) {
      if (!riga.includes("|")) continue;
      const [nome, panePidStr, cmd] = riga.split("|");
      if (cmd !== "pi" && cmd !== "claude") continue;
      const panePid = Number(panePidStr);
      if (!panePid) continue;
      const voce = {
        cmd,
        nome,
        pid: null,
        cwd: null,
        avviatoIl: null,
        etaMs: null,
        snippet: "",
        sessioneId: null,
        motivoNoId: null,
        etaLetturaMs: 0,
        sorgente: "tmux",
      };
      const pid = pidFiglioPerComm(panePid, cmd);
      voce.pid = pid;
      if (pid) {
        try {
          voce.cwd = readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          voce.cwd = null;
        }
        const avvio = epochDiAvvio(pid);
        if (avvio) {
          voce.avviatoIl = new Date(avvio).toISOString();
          voce.etaMs = lettaIl - avvio;
        }
        if (cmd === "pi" && voce.cwd && avvio) {
          const corr = correlazionaSessione(voce.cwd, avvio);
          if (corr) voce.sessioneId = corr.sessioneId;
          else
            voce.motivoNoId =
              "nessun file di sessione correlabile (entro 15 min dall'avvio)";
        } else if (cmd === "pi") {
          voce.motivoNoId = "cwd o orario di avvio non leggibili";
        }
      } else {
        voce.motivoNoId = "processo non trovato";
      }
      voce.snippet = snippetTmux(nome);
      finestre.push(voce);
    }
  }
  return finestre;
}

export function leggiSessioni() {
  const lettaIl = Date.now();
  const finestre = finestreHerdr(lettaIl) ?? finestreTmux(lettaIl);
  return {
    lettaIl: new Date(lettaIl).toISOString(),
    etaLetturaMs: 0,
    finestre,
    claude: claudeAgents(lettaIl),
  };
}

// Risoluzione del target per POST /riprendi: prova Herdr (pane_id), poi tmux
// (session:window) come fallback. Ritorna {ok:true, ...} oppure
// {ok:false, status, motivo} con il codice HTTP già pronto per il chiamante.
export function risolviFinestra(finestra) {
  const a = herdrAgentGet(finestra);
  if (a) {
    const cmd = a.agent;
    if (cmd !== "pi") {
      return {
        ok: false,
        status: 400,
        motivo: `la finestra ${finestra} non è una sessione pi (cmd=${cmd}): il controllo è possibile solo per pi`,
      };
    }
    const sessVal = a.agent_session?.value;
    const sessioneId = sessioneIdDaPath(sessVal);
    if (!sessioneId) {
      return {
        ok: false,
        status: 400,
        motivo:
          "nessun file di sessione stabile in Herdr per questa finestra: impossibile riprenderla",
      };
    }
    if (sessVal && !existsSync(sessVal)) {
      return {
        ok: false,
        status: 409,
        motivo:
          "il file di sessione indicato da Herdr non esiste più: identità non stabile",
      };
    }
    const pid = pidPerPaneHerdr(finestra);
    if (!pid) {
      return {
        ok: false,
        status: 409,
        motivo: "processo pi della finestra non trovato (già terminato?)",
      };
    }
    // Herdr's cwd is the session adapter's declared identity. The caller
    // revalidates the live /proc cwd immediately before signalling or spawning;
    // consulting a host PID here would make deterministic fixtures depend on
    // an unrelated process that happens to reuse the same number.
    const cwd = a.foreground_cwd ?? a.cwd ?? null;
    const sessioneDir = dirSessione(sessVal);
    if (!cwd || !sessioneDir) {
      return {
        ok: false,
        status: 409,
        motivo: "cwd o directory della sessione non leggibile",
      };
    }
    const modello = modelloDaSessione(sessVal);
    return {
      ok: true,
      sorgente: "herdr",
      cmd: "pi",
      pid,
      cwd,
      sessioneId,
      sessioneDir,
      provider: modello?.provider ?? null,
      modello: modello?.modello ?? null,
      target: finestra,
    };
  }
  // fallback tmux: stesso comportamento pre-Herdr
  const r = tmuxPanes();
  let riga = null;
  if (r.ok)
    riga = r.stdout
      .trim()
      .split("\n")
      .find((l) => l.startsWith(finestra + "|"));
  if (!riga)
    return {
      ok: false,
      status: 404,
      motivo: `finestra non trovata: ${finestra}`,
    };
  const [, panePidStr, cmd] = riga.split("|");
  if (cmd !== "pi") {
    return {
      ok: false,
      status: 400,
      motivo: `la finestra ${finestra} non è una sessione pi (cmd=${cmd}): il controllo è possibile solo per pi`,
    };
  }
  const panePid = Number(panePidStr);
  const pid = pidFiglioPerComm(panePid, "pi");
  if (!pidValido(pid))
    return {
      ok: false,
      status: 409,
      motivo: "processo pi della finestra non trovato (già terminato?)",
    };
  const cwd = cwdProcesso(pid);
  if (!cwd)
    return { ok: false, status: 409, motivo: "cwd del processo non leggibile" };
  const avvio = epochDiAvvio(pid);
  const corr = avvio ? correlazionaSessione(cwd, avvio) : null;
  if (!corr?.sessioneId) {
    return {
      ok: false,
      status: 400,
      motivo:
        "nessun file di sessione correlabile a questa finestra (entro 15 min dall'avvio): impossibile riprenderla",
    };
  }
  const sessioneDir = dirSessione(join(corr.dir, "sessione.jsonl"));
  if (!sessioneDir)
    return {
      ok: false,
      status: 409,
      motivo: "directory della sessione non leggibile",
    };
  return {
    ok: true,
    sorgente: "tmux",
    cmd: "pi",
    pid,
    cwd,
    sessioneId: corr.sessioneId,
    sessioneDir,
    target: finestra,
  };
}

export function staLavorando(target, sorgente, campioneGapMs = 1500) {
  return sorgente === "herdr"
    ? Promise.resolve(staLavorandoHerdr(target))
    : staLavorandoTmux(target, campioneGapMs);
}
