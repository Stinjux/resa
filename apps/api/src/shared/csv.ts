// CSV compatible Excel (séparateur « ; », BOM UTF-8).

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Protection contre l'injection de formules dans les tableurs.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const toCsv = (lines: unknown[][]) => '\ufeff' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n');

/** Montant en unités mineures → « 1234,50 ». */
export const csvMoney = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');
