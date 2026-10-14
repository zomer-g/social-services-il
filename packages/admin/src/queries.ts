export interface QueryItem {
  query: string;
  expected: string[];
}

/**
 * Reads pasted spreadsheet rows or a CSV file into queries. Columns are split
 * on tabs — what a paste from Excel or Google Sheets produces — or, for a .csv
 * file, on commas, with quoted fields honoured. Pasted text without tabs is one
 * query per line, commas and all.
 */
export function parseQueries(text: string, csv: boolean): QueryItem[] {
  // NUL never occurs in typed text, so "no delimiter" leaves each line whole.
  const delimiter = csv ? ',' : text.includes('\t') ? '\t' : '\0';
  const rows = parseDelimited(text.replace(/^﻿/, ''), delimiter);
  const items: QueryItem[] = [];
  rows.forEach((row, i) => {
    const query = (row[0] ?? '').trim();
    if (!query) return;
    // A header row, if there is one, is not a query.
    if (i === 0 && /^(query|search|term|שאילת[הא]|מונח|חיפוש|מחרוזת)/i.test(query)) return;
    const expected = row
      .slice(1)
      .join('|')
      .split(/[|;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (query.length >= 2) items.push({ query: query.slice(0, 500), expected });
  });
  return items;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
