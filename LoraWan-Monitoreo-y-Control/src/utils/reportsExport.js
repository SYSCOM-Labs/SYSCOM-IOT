import jsPDF from 'jspdf';
import 'jspdf-autotable';

/** dd/mm/aaaa */
export function formatReportDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  const d = new Date(n);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function formatReportValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function csvEscape(cell) {
  const s = cell == null ? '' : String(cell);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {{ deviceLabel: string, date: string, value: string }[]} rows
 */
export function downloadReportCsv(rows, filenameBase = 'reporte_syscom') {
  const header = ['Dispositivo', 'Fecha', 'Valor'];
  const lines = [
    header.map(csvEscape).join(','),
    ...rows.map((r) => [r.deviceLabel, r.date, r.value].map(csvEscape).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {{ deviceLabel: string, date: string, value: string }[]} rows
 * @param {{ title?: string, variableLabel?: string, rangeLabel?: string }} meta
 */
export function downloadReportPdf(rows, meta = {}, filenameBase = 'reporte_syscom') {
  const doc = new jsPDF({ orientation: rows.length > 40 ? 'landscape' : 'portrait' });
  doc.setFontSize(14);
  doc.text(meta.title || 'Reporte de telemetría', 14, 16);
  doc.setFontSize(9);
  let y = 22;
  if (meta.variableLabel) {
    doc.text(`Variable: ${meta.variableLabel}`, 14, y);
    y += 5;
  }
  if (meta.rangeLabel) {
    doc.text(`Periodo: ${meta.rangeLabel}`, 14, y);
    y += 5;
  }
  doc.autoTable({
    startY: y + 2,
    head: [['Dispositivo', 'Fecha', 'Valor']],
    body: rows.map((r) => [r.deviceLabel, r.date, r.value]),
    theme: 'striped',
    headStyles: { fillColor: [59, 130, 246] },
    styles: { fontSize: 8 },
  });
  doc.save(`${filenameBase}.pdf`);
}
