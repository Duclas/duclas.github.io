const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADERS = ["Datum", "Erläuterung", "Betrag EUR", "Kontostand"];

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function columnName(index) {
  let dividend = index + 1;
  let name = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return name;
}

function cellXml(value, rowIndex, columnIndex) {
  const reference = `${columnName(columnIndex)}${rowIndex}`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function worksheetXml(rows) {
  const allRows = [HEADERS, ...rows.map((row) => HEADERS.map((header) => row[header] ?? ""))];
  const sheetRows = allRows
    .map((row, index) => {
      const rowIndex = index + 1;
      return `<row r="${rowIndex}">${row.map((value, columnIndex) => cellXml(value, rowIndex, columnIndex)).join("")}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <cols>
    <col min="1" max="1" width="13" customWidth="1"/>
    <col min="2" max="2" width="72" customWidth="1"/>
    <col min="3" max="4" width="16" customWidth="1"/>
  </cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Kontoauszuege" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function workbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const data = new Uint8Array(2);
  new DataView(data.buffer).setUint16(0, value, true);
  return data;
}

function uint32(value) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return data;
}

function concatParts(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function localHeader(entry) {
  const name = encoder.encode(entry.name);
  return concatParts([
    uint32(0x04034b50),
    uint16(20),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(entry.crc),
    uint32(entry.data.length),
    uint32(entry.data.length),
    uint16(name.length),
    uint16(0),
    name
  ]);
}

function centralHeader(entry) {
  const name = encoder.encode(entry.name);
  return concatParts([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(entry.crc),
    uint32(entry.data.length),
    uint32(entry.data.length),
    uint16(name.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0),
    uint32(entry.offset),
    name
  ]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return concatParts([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entryCount),
    uint16(entryCount),
    uint32(centralSize),
    uint32(centralOffset),
    uint16(0)
  ]);
}

export function createXlsxBytes(rows) {
  const files = [
    { name: "[Content_Types].xml", text: contentTypesXml() },
    { name: "_rels/.rels", text: rootRelsXml() },
    { name: "xl/workbook.xml", text: workbookXml() },
    { name: "xl/_rels/workbook.xml.rels", text: workbookRelsXml() },
    { name: "xl/worksheets/sheet1.xml", text: worksheetXml(rows) }
  ];

  let offset = 0;
  const entries = files.map((file) => {
    const data = encoder.encode(file.text);
    const entry = {
      name: file.name,
      data,
      crc: crc32(data),
      offset
    };
    offset += localHeader(entry).length + data.length;
    return entry;
  });

  const localParts = entries.flatMap((entry) => [localHeader(entry), entry.data]);
  const centralParts = entries.map((entry) => centralHeader(entry));
  const central = concatParts(centralParts);
  const end = endOfCentralDirectory(entries.length, central.length, offset);

  return concatParts([...localParts, central, end]);
}

export function createXlsxBlob(rows) {
  return new Blob([createXlsxBytes(rows)], { type: XLSX_MIME });
}
