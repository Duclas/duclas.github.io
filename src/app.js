import {
  buildRowsForStatement,
  createCsv,
  groupTextItemsIntoLines,
  rowsForWorkbook,
  sortRowsByDate
} from "./parser.js?v=three-cols-sort-20260522";
import { createXlsxBlob } from "./xlsx.js?v=three-cols-sort-20260522";

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
    ? `${exportRows.length} Exportzeilen aus ${statementResults.length} PDF(s). Kontostand: ${balances}`
    : "Noch keine Zeilen extrahiert.";
}

function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
  const byKey = new Map(selectedFiles.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]));

  for (const file of incoming) {
    byKey.set(`${file.name}:${file.size}:${file.lastModified}`, file);
  }

  selectedFiles = [...byKey.values()];
  renderFileList();
  updateButtons();
  setStatus(selectedFiles.length ? `${selectedFiles.length} PDF(s) bereit.` : "Bitte eine oder mehrere PDF-Dateien auswahlen.");
}

async function readPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
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
  return buildRowsForStatement(file.name, pages);
}

async function scanFiles() {
  if (!selectedFiles.length) {
    return;
  }

  exportRows = [];
  statementResults = [];
  updateButtons();
  renderResults();
  elements.scanButton.disabled = true;

  try {
    for (const file of selectedFiles) {
      const result = await readPdf(file);
      statementResults.push(result);
      exportRows.push(...result.transactions);
      exportRows = sortRowsByDate(exportRows);
      renderResults();
    }

    if (!exportRows.length) {
      setStatus("Keine Zeilen erkannt. Pruefe, ob die PDFs Text enthalten und nicht nur gescannte Bilder sind.", "warn");
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
