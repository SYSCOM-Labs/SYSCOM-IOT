/**
 * Envía un datagrama UDP en bruto (hex) — útil para probar reachability GWMP.
 *
 * Ejemplo mínimo PULL_DATA (12 B): versión 02, token 01 02, id 02, MAC8 ceros.
 *   node scripts/lns-udp-send-raw.mjs 172.16.100.84 1700 020102020000000000000000
 *
 * No sustituye al LNS: el GW_TX_ACK (0x05) lo envía el gateway tras un PULL_RESP real.
 */
import dgram from 'node:dgram';

const host = process.argv[2] || '172.16.100.84';
const port = Number(process.argv[3] || 1700);
const hex = (process.argv[4] || '020102020000000000000000').replace(/\s/g, '');
if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
  console.error('Uso: node scripts/lns-udp-send-raw.mjs <host> <port> <hex_par_bytes>');
  process.exit(1);
}
const buf = Buffer.from(hex, 'hex');
const s = dgram.createSocket('udp4');
s.send(buf, port, host, (err) => {
  if (err) console.error(err);
  else console.log('Enviados', buf.length, 'B a', host + ':' + port);
  s.close();
});
