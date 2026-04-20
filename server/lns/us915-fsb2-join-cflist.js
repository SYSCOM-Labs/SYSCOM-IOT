'use strict';

/**
 * CFList de 16 bytes en Join-Accept (LoRaWAN US902-928, RP002 / TS001):
 * ChMask0…ChMask4 (uint16 LE) + 6 B RFU = 0.
 *
 * FSB2: habilita canales 125 kHz **8–15** (ChMask0 = 0xFF00) y 500 kHz **65–70**
 * (ChMask4 = 0x007E; bits 1..6 = canales 65..70 con bit0 = ch64).
 *
 * Desactivar Join-Accept con máscara: `SYSCOM_LNS_JOIN_CFLIST=0` (p. ej. nodos que rechazan CFList).
 */

function joinCflistFsb2Enabled() {
  const raw = process.env.SYSCOM_LNS_JOIN_CFLIST;
  if (raw == null || String(raw).trim() === '') return true;
  const s = String(raw).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return true;
}

/** @returns {Buffer} 16 bytes (ChMask0–4 LE + RFU) o buffer vacío si deshabilitado. */
function buildUs915Fsb2JoinCFList() {
  if (!joinCflistFsb2Enabled()) return Buffer.alloc(0);
  const b = Buffer.alloc(16, 0);
  b.writeUInt16LE(0xff00, 0); // canales 125 kHz 8–15
  b.writeUInt16LE(0x007e, 8); // canales 500 kHz 65–70
  return b;
}

module.exports = { buildUs915Fsb2JoinCFList, joinCflistFsb2Enabled };
