import {
  annotateDuplicateBookings,
  buildRowsForStatement,
  createCsv,
  groupTextItemsIntoLines,
  rowsForWorkbook,
  sortRowsByDate
} from "./parser.js?v=duplicate-warnings-20260522";
import { createXlsxBlob } from "./xlsx.js?v=duplicate-warnings-20260522";

import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const elements = {
  dropzone: document.querySelector("[data-dropzone]"),
  fileInput: document.querySelector("[data-file-input]"),
  fileList: document.querySelector("[data-file-list]"),
  scanButton: document.querySelector("[data-scan]"),
  clearButton: document.querySelector("[data-clear]"),
  csvButton: document.querySelector("[data-export-csv]"),
  xlsxButton: document.querySelector("[data-export-xlsx]"),
  status: document.querySelector("[data-status]"),
  summary: document.querySelector("[data-summary]"),
  tableBody: document.querySelector("[data-table-body]"),
  emptyState: document.querySelector("[data-empty-state]")
};

let selectedFiles = [];
let exportRows = [];
let statementResults = [];
let scanWarnings = [];

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(message, tone = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function updateButtons() {
  elements.scanButton.disabled = selectedFiles.length === 0;
  elements.clearButton.disabled = selectedFiles.length === 0 && exportRows.length === 0;
  elements.csvButton.disabled = exportRows.length === 0;
  elements.xlsxButton.disabled = exportRows.length === 0;
}

function renderFileList() {
  elements.fileList.innerHTML = "";
  if (!selectedFiles.length) {
    const item = document.createElement("li");
    item.textContent = "Keine Dateien ausgewahlt";
    item.className = "muted-row";
    elements.fileList.append(item);
    return;
  }

  selectedFiles.forEach((file) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const meta = document.createElement("span");
    name.textContent = file.name;
    meta.textContent = formatBytes(file.size);
    item.append(name, meta);
    elements.fileList.append(item);
  });
}

function renderResults() {
  elements.tableBody.innerHTML = "";
  elements.emptyState.hidden = exportRows.length > 0;

  for (const row of exportRows.slice(0, 250)) {
    const tr = document.createElement("tr");
    if (row._warnings?.length) {
      tr.dataset.warning = "true";
      tr.title = row._warnings.map((warning) => warning.message).join(" | ");
    }
    [row.datum, row.erlaeuterung, row.betragEur].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    });
    elements.tableBody.append(tr);
  }

  const balances = statementResults
    .map((result) => `${result.fileName}: ${result.balance.value ? `${result.balance.value} (${result.balance.date || "Datum nicht erkannt"})` : "nicht erkannt"}`)
    .join(" | ");
  elements.summary.textContent = exportRows.length
    ? `${exportRows.length} Exportzeilen aus ${statementResults.length} PDF(s). Kontostand: ${balances}${scanWarnings.length ? ` Warnungen: ${scanWarnings.join(" ")}` : ""}`
    : "Noch keine Zeilen extrahiert.";
}

function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
  selectedFiles = [...selectedFiles, ...incoming];
  elements.fileInput.value = "";
  renderFileList();
  updateButtons();
  setStatus(selectedFiles.length ? `${selectedFiles.length} PDF(s) bereit.` : "Bitte eine oder mehrere PDF-Dateien auswahlen.");
}

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readPdf(file) {
  const buffer = await file.arrayBuffer();
  const fileHash = await sha256Hex(buffer);
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    setStatus(`${file.name}: Seite ${pageNumber}/${pdf.numPages} wird gelesen...`);
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent({ includeMarkedContent: false });
    pages.push({
      pageNumber,
      lines: groupTextItemsIntoLines(textContent.items)
    });
  }

  await pdf.destroy();
  const result = buildRowsForStatement(file.name, pages);
  return {
    ...result,
    fileHash,
    transactions: result.transactions.map((row) => ({
      ...row,
      _fileHash: fileHash,
      _sourceFile: file.name
    }))
  };
}

function annotateDuplicatePdfRows(rows) {
  const groups = new Map();

  for (const result of statementResults) {
    const group = groups.get(result.fileHash) ?? [];
    group.push(result.fileName);
    groups.set(result.fileHash, group);
  }

  const duplicateHashes = new Map([...groups.entries()].filter(([, names]) => names.length > 1));
  const warnings = [...duplicateHashes.values()].map((names) => `Identische PDFs: ${names.join(", ")}`);

  const annotatedRows = rows.map((row) => {
    const names = duplicateHashes.get(row._fileHash);
    if (!names) {
      return row;
    }

    const existingWarnings = row._warnings ?? [];
    return {
      ...row,
      _warnings: [
        ...existingWarnings,
        {
          type: "duplicate-pdf",
          message: `Zeile aus identischer PDF-Gruppe: ${names.join(", ")}`
        }
      ]
    };
  });

  return { rows: annotatedRows, warnings };
}

function rebuildExportRows() {
  let rows = statementResults.flatMap((result) => result.transactions.map((row) => ({
    ...row,
    _warnings: []
  })));

  const pdfDuplicates = annotateDuplicatePdfRows(rows);
  const bookingDuplicates = annotateDuplicateBookings(pdfDuplicates.rows);

  exportRows = sortRowsByDate(bookingDuplicates.rows);
  scanWarnings = [...pdfDuplicates.warnings, ...bookingDuplicates.warnings];
}

async function scanFiles() {
  if (!selectedFiles.length) {
    return;
  }

  exportRows = [];
  statementResults = [];
  scanWarnings = [];
  updateButtons();
  renderResults();
  elements.scanButton.disabled = true;

  try {
    for (const file of selectedFiles) {
      const result = await readPdf(file);
      statementResults.push(result);
      rebuildExportRows();
      renderResults();
    }

    if (!exportRows.length) {
      setStatus("Keine Zeilen erkannt. Pruefe, ob die PDFs Text enthalten und nicht nur gescannte Bilder sind.", "warn");
    } else if (scanWarnings.length) {
      setStatus(`Warnung: ${scanWarnings.length} Duplikat-Hinweis(e). Export ist moeglich; markierte Zeilen werden in XLSX rot hinterlegt.`, "error");
    } else {
      setStatus(`${exportRows.length} Exportzeilen erkannt. Export ist bereit.`, "ok");
    }
  } catch (error) {
    console.error(error);
    setStatus(`Fehler beim Lesen: ${error.message}`, "error");
  } finally {
    updateButtons();
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const csv = `\ufeff${createCsv(exportRows)}`;
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "kontoauszuege.csv");
}

function exportXlsx() {
  downloadBlob(createXlsxBlob(rowsForWorkbook(exportRows)), "kontoauszuege.xlsx");
}

function clearAll() {
  selectedFiles = [];
  exportRows = [];
  statementResults = [];
  scanWarnings = [];
  elements.fileInput.value = "";
  renderFileList();
  renderResults();
  setStatus("Bereit. PDFs bleiben lokal in diesem Browser.");
  updateButtons();
}

elements.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
elements.scanButton.addEventListener("click", scanFiles);
elements.clearButton.addEventListener("click", clearAll);
elements.csvButton.addEventListener("click", exportCsv);
elements.xlsxButton.addEventListener("click", exportXlsx);

elements.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropzone.dataset.dragging = "true";
});

elements.dropzone.addEventListener("dragleave", () => {
  elements.dropzone.dataset.dragging = "false";
});

elements.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropzone.dataset.dragging = "false";
  addFiles(event.dataTransfer.files);
});

renderFileList();
renderResults();
setStatus("Bereit. PDFs bleiben lokal in diesem Browser.");
updateButtons();
