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

/**
 * @param {Array<{ type?: string, deviceLabel?: string, date?: string, value?: string, variableLabel?: string }>} rows
 * @param {{ title?: string, rangeLabel?: string }} meta
 */
export function downloadReportPdf(rows, meta = {}, filenameBase = 'reporte_syscom') {
  const doc = new jsPDF({ orientation: rows.length > 40 ? 'landscape' : 'portrait' });
  doc.setFontSize(14);
  doc.text(meta.title || 'Reporte de telemetría', 14, 16);
  doc.setFontSize(9);
  let y = 22;
  if (meta.rangeLabel) {
    doc.text(`Periodo: ${meta.rangeLabel}`, 14, y);
    y += 5;
  }

  const tableBody = rows.map((r) => {
    if (isSeparatorRow(r)) {
      const label = [r.deviceLabel, r.variableLabel].filter(Boolean).join(' · ');
      return [
        {
          content: `── ${label} ──`,
          colSpan: 3,
          styles: {
            fillColor: PDF_SEP_FILL,
            textColor: PDF_SEP_TEXT,
            fontStyle: 'bold',
            halign: 'center',
          },
        },
      ];
    }
    return [r.deviceLabel, r.date, r.value];
  });

  doc.autoTable({
    startY: y + 2,
    head: [['Dispositivo', 'Fecha', 'Valor']],
    body: tableBody,
    theme: 'striped',
    headStyles: { fillColor: PDF_SEP_FILL },
    styles: { fontSize: 8 },
    didParseCell(data) {
      const row = rows[data.row.index];
      if (row && isSeparatorRow(row) && !data.cell.colSpan) {
        data.cell.styles.fillColor = PDF_SEP_FILL;
        data.cell.styles.textColor = PDF_SEP_TEXT;
      }
    },
  });
  doc.save(`${filenameBase}.pdf`);
}

/** Filas de datos (sin separadores) para contadores. */
export function countReportDataRows(rows) {
  return rows.filter((r) => !isSeparatorRow(r)).length;
}
