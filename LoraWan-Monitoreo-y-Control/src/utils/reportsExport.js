import jsPDF from 'jspdf';
import { autoTable } from 'jspdf-autotable';

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

/** Orden alfabético con números naturales (Sec 2 antes de Sec 10). */
export function compareReportDeviceLabels(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function csvEscape(cell) {
  const s = cell == null ? '' : String(cell);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function isSeparatorRow(r) {
  return r && r.type === 'separator';
}

function pdfCellText(value, maxLen = 120) {
  const s = value == null ? '' : String(value);
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function runAutoTable(doc, options) {
  if (typeof doc.autoTable === 'function') {
    doc.autoTable(options);
    return;
  }
  autoTable(doc, options);
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/**
 * @param {Array<{ type?: string, deviceLabel?: string, date?: string, value?: string, variableLabel?: string }>} rows
 */
export function downloadReportCsv(rows, filenameBase = 'reporte_syscom') {
  const header = ['Dispositivo', 'Fecha', 'Valor'];
  const bodyLines = rows.map((r) => {
    if (isSeparatorRow(r)) {
      const label = [r.deviceLabel, r.variableLabel].filter(Boolean).join(' · ');
      return [`── ${label} ──`, '', ''].map(csvEscape).join(',');
    }
    return [r.deviceLabel, r.date, r.value].map(csvEscape).join(',');
  });
  const lines = [header.map(csvEscape).join(','), ...bodyLines];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const PDF_SEP_FILL = [59, 130, 246];
const PDF_SEP_TEXT = [255, 255, 255];
const SEP_CELL_STYLES = {
  fillColor: PDF_SEP_FILL,
  textColor: PDF_SEP_TEXT,
  fontStyle: 'bold',
  halign: 'center',
};

/**
 * @param {Array<{ type?: string, deviceLabel?: string, date?: string, value?: string, variableLabel?: string }>} rows
 * @param {{ title?: string, rangeLabel?: string }} meta
 */
export async function downloadReportPdf(rows, meta = {}, filenameBase = 'reporte_syscom') {
  await yieldToBrowser();

  const dataRows = rows.filter((r) => !isSeparatorRow(r));
  const orientation = dataRows.length > 35 ? 'landscape' : 'portrait';
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });

  doc.setFontSize(14);
  doc.text(pdfCellText(meta.title || 'Reporte de telemetría', 80), 14, 16);
  doc.setFontSize(9);
  let y = 22;
  if (meta.rangeLabel) {
    doc.text(`Periodo: ${pdfCellText(meta.rangeLabel, 100)}`, 14, y);
    y += 5;
  }

  /** Filas uniformes de 3 celdas (evita fallos de colspan en jspdf-autotable 5). */
  const tableBody = rows.map((r) => {
    if (isSeparatorRow(r)) {
      const label = [r.deviceLabel, r.variableLabel].filter(Boolean).join(' · ');
      const text = `── ${label} ──`;
      return [
        { content: text, styles: { ...SEP_CELL_STYLES, halign: 'left' } },
        { content: '', styles: SEP_CELL_STYLES },
        { content: '', styles: SEP_CELL_STYLES },
      ];
    }
    return [
      pdfCellText(r.deviceLabel, 80),
      pdfCellText(r.date, 24),
      pdfCellText(r.value, 80),
    ];
  });

  await yieldToBrowser();

  runAutoTable(doc, {
    startY: y + 2,
    head: [['Dispositivo', 'Fecha', 'Valor']],
    body: tableBody,
    theme: 'striped',
    headStyles: { fillColor: PDF_SEP_FILL },
    styles: { fontSize: 8, overflow: 'linebreak' },
    columnStyles: {
      0: { cellWidth: orientation === 'landscape' ? 110 : 75 },
      1: { cellWidth: 28 },
      2: { cellWidth: 'auto' },
    },
  });

  await yieldToBrowser();
  doc.save(`${filenameBase}.pdf`);
}

/** Filas de datos (sin separadores) para contadores. */
export function countReportDataRows(rows) {
  return rows.filter((r) => !isSeparatorRow(r)).length;
}
