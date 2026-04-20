'use strict';

/**
 * Plan regional del LNS integrado: **solo US915** (ISM 902–928 MHz), alineado con **FSB2**
 * (canales 125 kHz **8–15** y, en la práctica, **500 kHz 65–70** / DR4 en la misma subbanda).
 * RX2 de referencia para `imme` / ventanas: 923.3 MHz / SF12BW500.
 *
 * `SYSCOM_LNS_PLAN` y valores no-US se ignoran (aviso en consola la primera vez).
 * `SYSCOM_LNS_RX2_FREQ` puede ajustarse pero se **recorta** al rango 902–928 MHz.
 */

const US915_FREQ_MIN = 902;
const US915_FREQ_MAX = 928;

const US915_RX2 = {
  freq: 923.3,
  datr: 'SF12BW500',
  codr: '4/5',
};

let warnedNonUsPlan = false;

function warnIfNonUsPlanEnv() {
  const raw = process.env.SYSCOM_LNS_PLAN;
  if (raw == null || String(raw).trim() === '' || warnedNonUsPlan) return;
  const s = String(raw)
    .trim()
    .toUpperCase();
  const isUs =
    s === 'US915' ||
    s === 'US902' ||
    s === 'US902-928' ||
    s.startsWith('US902-928') ||
    s.startsWith('US915');
  if (!isUs) {
    warnedNonUsPlan = true;
    console.warn(
      `[LNS] Esta instalación usa únicamente US915 (${US915_FREQ_MIN}–${US915_FREQ_MAX} MHz). Se ignora SYSCOM_LNS_PLAN=${JSON.stringify(raw)}.`
    );
  }
}

function getLorawanRegionalPlan() {
  warnIfNonUsPlanEnv();
  return { id: 'US915', rx2: US915_RX2 };
}

function envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function clampUs915Mhz(freq) {
  const f = Number(freq);
  if (!Number.isFinite(f)) return US915_RX2.freq;
  if (f < US915_FREQ_MIN || f > US915_FREQ_MAX) {
    const clamped = Math.min(US915_FREQ_MAX, Math.max(US915_FREQ_MIN, f));
    console.warn(
      `[LNS] SYSCOM_LNS_RX2_FREQ=${f} MHz fuera de US915 (${US915_FREQ_MIN}–${US915_FREQ_MAX} MHz); usando ${clamped} MHz.`
    );
    return clamped;
  }
  return f;
}

/** Parámetros RX2 / `imme` para `txpk`; `SYSCOM_LNS_RX2_FREQ` se recorta a 902–928 MHz. */
function rx2DefaultsFromEnvAndPlan() {
  const { rx2 } = getLorawanRegionalPlan();
  let freq =
    process.env.SYSCOM_LNS_RX2_FREQ != null && String(process.env.SYSCOM_LNS_RX2_FREQ).trim() !== ''
      ? envFloat('SYSCOM_LNS_RX2_FREQ', rx2.freq)
      : rx2.freq;
  freq = clampUs915Mhz(freq);
  const datr =
    process.env.SYSCOM_LNS_RX2_DATR != null && String(process.env.SYSCOM_LNS_RX2_DATR).trim() !== ''
      ? String(process.env.SYSCOM_LNS_RX2_DATR)
      : rx2.datr;
  const codr =
    process.env.SYSCOM_LNS_RX2_CODR != null && String(process.env.SYSCOM_LNS_RX2_CODR).trim() !== ''
      ? String(process.env.SYSCOM_LNS_RX2_CODR)
      : rx2.codr;
  return { planId: 'US915', freq, datr, codr };
}

/**
 * Aviso en runtime: uplink fuera del ISM US915 o en banda típica EU.
 * @param {{ freq?: number }} rxpk
 */
function warnUplinkFreqMismatchedPlan(rxpk) {
  if (!rxpk || rxpk.freq == null) return;
  const f = Number(rxpk.freq);
  if (!Number.isFinite(f)) return;
  if (f >= 863 && f <= 870) {
    console.warn(
      '[LNS] Uplink ~863–870 MHz (típico EU868); este despliegue es solo US915 (902–928 MHz). Revise el gateway o el canal del nodo.'
    );
    return;
  }
  if (f < US915_FREQ_MIN || f > US915_FREQ_MAX) {
    console.warn(
      `[LNS] Uplink ${f} MHz fuera del ISM US915 (${US915_FREQ_MIN}–${US915_FREQ_MAX} MHz). Revise plan de canales del gateway.`
    );
    return;
  }

  warnUplinkOutsideUs915Fsb2(f);
}

/**
 * Aviso si el uplink parece fuera de la subbanda FSB2 (125 kHz canales 8–15 o 500 kHz 65–70).
 * @param {number} f MHz
 */
function warnUplinkOutsideUs915Fsb2(f) {
  const tol125 = 0.15;
  const ch125 = Math.round((f - 902.3) / 0.2);
  if (ch125 >= 0 && ch125 <= 63) {
    const center = 902.3 + ch125 * 0.2;
    if (Math.abs(f - center) <= tol125) {
      if (ch125 < 8 || ch125 > 15) {
        console.warn(
          `[LNS] Uplink ${f} MHz en canal 125 kHz ~${ch125}. Esta instalación usa FSB2 (canales 8–15 a 125 kHz y 65–70 a 500 kHz). Revise gateway y dispositivo.`
        );
      }
      return;
    }
  }

  const tol500 = 0.3;
  for (let ch = 64; ch <= 71; ch += 1) {
    const center = 903.0 + (ch - 64) * 1.6;
    if (Math.abs(f - center) <= tol500) {
      if (ch < 65 || ch > 70) {
        console.warn(
          `[LNS] Uplink ${f} MHz en canal 500 kHz ${ch}; FSB2 usa 125 kHz 8–15 y 500 kHz 65–70. Revise el plan del gateway.`
        );
      }
      return;
    }
  }
}

module.exports = {
  getLorawanRegionalPlan,
  rx2DefaultsFromEnvAndPlan,
  warnUplinkFreqMismatchedPlan,
  US915_RX2,
  US915_FREQ_MIN,
  US915_FREQ_MAX,
};
