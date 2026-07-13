const XLSX = require('xlsx');

// Reads an uploaded .xlsx/.xls file and pulls out its header row (the fields
// to fill) and whatever data rows already exist, so we can reproduce them on export.
function parseTemplate(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

  const headerRow = aoa[0] || [];
  const headers = headerRow.map((h) => String(h).trim()).filter((h) => h.length > 0);
  const existingRows = aoa.slice(1);

  return { sheetName, headers, existingRows };
}

// Rebuilds the workbook: original header + original rows + newly reviewed records.
function buildWorkbook(headers, existingRows, records, sheetName) {
  const aoa = [headers];
  for (const row of existingRows) aoa.push(row);
  for (const record of records) {
    aoa.push(headers.map((h) => (record[h] !== undefined ? record[h] : '')));
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName || 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseTemplate, buildWorkbook };
