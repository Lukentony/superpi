// Fase 4 — gate di ammissione, versione v1 (guida §6 v1: "solo un controllo
// quota+cwd prima dello spawn", non il gate multi-figlio di §4.6, quello è v2).
//
// Contratto: verificaGate() ritorna { ok: true } oppure { ok: false, motivo }
// — mai un'eccezione silenziosa, mai un rifiuto muto: ogni rifiuto dice il
// problema esatto e cosa allentare (principio della guida §4.6).
//
// Due controlli, in ordine:
//   1. cwd sicura: realpath della cwd (i path relativi e con ".." risolvono
//      correttamente) mai uguale a $HOME esatta, mai dentro la radice di hive.
//      permettiHive = true salta SOLO i controlli su hive (per /riprendi:
//      la sessione esisteva già, aperta da Luca — deciso 2026-08-13); il
//      controllo $HOME esatta resta SEMPRE attivo, in ogni caso, senza eccezioni.
//   2. quota: OpenCode Go rolling 5h non oltre la soglia (default 80%).
//      Quota non determinabile → rifiuto esplicito (fail-closed), mai un
//      passaggio silenzioso.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { ottieniQuotaGo } from "./quota-go.mjs";
import { verificaOpenRouter, OPENROUTER_MODELLO } from "./quota-openrouter.mjs";

export function verificaCwd(cwd, { homeDir = homedir(), hiveRoot = join(homedir(), "hive"), permettiHive = false } = {}) {
  let reale;
  try {
    reale = realpathSync(resolve(String(cwd)));
  } catch {
    return {
      ok: false,
      motivo: `cwd non risolvibile: "${cwd}" (path inesistente o non accessibile)`,
    };
  }
  let homeReale;
  try {
    homeReale = realpathSync(homeDir);
  } catch {
    return {
      ok: false,
      motivo: `homeDir non risolvibile: "${homeDir}" — impossibile verificare la cwd`,
    };
  }
  if (reale === homeReale) {
    return {
      ok: false,
      motivo: `cwd è $HOME esatta ("${reale}") — i figli lavorano fuori da $HOME`,
    };
  }
  // La radice di hive e tutto il suo albero: se hiveRoot non esiste sulla
  // macchina non c'è nulla da proteggere, il controllo salta. Con
  // permettiHive: true il controllo hive è saltato (solo per /riprendi —
  // deciso con Luca 2026-08-13; /task non usa mai permettiHive).
  if (!permettiHive) {
    try {
      const hiveReale = realpathSync(hiveRoot);
      if (reale === hiveReale) {
        return {
          ok: false,
          motivo: `cwd è la radice di hive ("${reale}") — i figli lavorano fuori dal vault`,
        };
      }
      if (reale.startsWith(hiveReale + "/")) {
        return {
          ok: false,
          motivo: `cwd è dentro hive ("${reale}") — i figli lavorano fuori dal vault`,
        };
      }
    } catch {
      /* hiveRoot inesistente: niente da proteggere */
    }
  }
  return { ok: true };
}

export function verificaQuota(uso, { sogliaPercentuale = 80 } = {}) {
  if (!uso?.rolling || typeof uso.rolling.percentuale !== "number") {
    return {
      ok: false,
      motivo: "quota Go non determinabile (dato rolling mancante o illeggibile)",
    };
  }
  const p = uso.rolling.percentuale;
  if (p > sogliaPercentuale) {
    return {
      ok: false,
      motivo: `quota OpenCode Go rolling 5h al ${p}% (soglia ${sogliaPercentuale}%) — attendi il reset (${uso.rolling.reset_in}s) o allenta la soglia`,
    };
  }
  return {
    ok: true,
    quota: { percentuale: p, reset_in: uso.rolling.reset_in, aggiornato: uso.aggiornato },
  };
}

// I due controlli insieme + riserva OpenRouter (2026-08-18). OttieniQuota è
// iniettabile per i test (di default legge la quota vera da opencode.ai);
// verificaRiserva pure (di default verifica OpenRouter per davvero).
// Ordine: 1) cwd (invariato, PRIMA di tutto); 2) quota OpenCode Go ESATTAMENTE
// come oggi — sotto soglia il comportamento è identico al passato, nessuna
// chiamata a OpenRouter; 3) SOLO se la quota primaria fallisce (sopra soglia o
// non determinabile) si prova la riserva OpenRouter; 4) se anche la riserva
// fallisce: rifiuto fail-closed col motivo di oggi (mai un passaggio
// silenzioso). Quando la riserva passa, il risultato porta provider e modello
// da usare per lo spawn del figlio.
export async function verificaGate({
  cwd,
  homeDir,
  hiveRoot,
  sogliaPercentuale = 80,
  permettiHive = false,
  ottieniQuota = ottieniQuotaGo,
  verificaRiserva = verificaOpenRouter,
} = {}) {
  const c = verificaCwd(cwd, { homeDir, hiveRoot, permettiHive });
  if (!c.ok) return c;
  let uso = null;
  let erroreQuota = null;
  try {
    uso = await ottieniQuota();
  } catch (e) {
    erroreQuota = e;
  }
  const esitoPrimario = uso
    ? verificaQuota(uso, { sogliaPercentuale })
    : { ok: false, motivo: `quota Go non determinabile: ${erroreQuota instanceof Error ? erroreQuota.message : String(erroreQuota)}` };
  if (esitoPrimario.ok) return esitoPrimario; // caso comune: OpenCode Go, invariato
  // quota primaria esaurita o non determinabile: prova la riserva
  const riserva = await verificaRiserva();
  if (riserva.ok) {
    return { ok: true, provider: "openrouter", modello: OPENROUTER_MODELLO, saldoResiduo: riserva.saldoResiduo };
  }
  return esitoPrimario; // fail-closed come oggi, col motivo della quota primaria
}
