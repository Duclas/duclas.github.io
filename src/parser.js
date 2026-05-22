const DATE_SOURCE = String.raw`\b\d{1,2}\.\d{1,2}\.(?:\d{2,4})?\b`;
const DATE_PATTERN = new RegExp(DATE_SOURCE);
const DATE_SCAN_PATTERN = new RegExp(DATE_SOURCE, "g");
const EURO_AMOUNT_SOURCE = String.raw`[-+]?\s?\d{1,3}(?:\.\d{3})*,\d{2}[-+]?|[-+]?\s?\d+,\d{2}[-+]?`;
const AMOUNT_PATTERN = new RegExp(EURO_AMOUNT_SOURCE, "g");
const AMOUNT_DETECT_PATTERN = new RegExp(EURO_AMOUNT_SOURCE);
const BALANCE_KEYWORDS = /(konto\s*stand|kontostand|saldo|endsaldo|abschluss|neuer\s+stand)/i;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDuplicateText(value) {
  return cleanText(value).toLowerCase();
}

function normalizeAmount(value) {
  const cleaned = cleanText(value).replace(/\s+/g, "");
  const match = cleaned.match(new RegExp(EURO_AMOUNT_SOURCE));
  return match ? match[0] : "";
}

function hasAmount(value) {
  return AMOUNT_DETECT_PATTERN.test(cleanText(value));
}

function parseDateKey(value) {
  const match = cleanText(value).match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (!match) {
    return null;
  }

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const rawYear = match[3] ?? "0";
  const parsedYear = Number.parseInt(rawYear, 10);
  const year = rawYear.length === 2 ? 2000 + parsedYear : parsedYear;

  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null;
  }

  return year * 10000 + month * 100 + day;
}

function extractLastDate(value) {
  const matches = cleanText(value).match(DATE_SCAN_PATTERN);
  return matches?.at(-1) ?? "";
}

function duplicateBookingKey(row) {
  if (row._kind === "balance") {
    return "";
  }

  const date = cleanText(row.datum);
  const explanation = normalizeDuplicateText(row.erlaeuterung);
  const amount = normalizeAmount(row.betragEur);

  if (!date || !explanation || !amount) {
    return "";
  }

  return [date, explanation, amount].join("\u001f");
}

function withRowWarning(row, warning) {
  const warnings = row._warnings ?? [];
  if (warnings.some((existing) => existing.type === warning.type && existing.message === warning.message)) {
    return row;
  }

  return {
    ...row,
    _warnings: [...warnings, warning]
  };
}

function itemX(item) {
  return Number(item?.transform?.[4] ?? item?.x ?? 0);
}

function itemY(item) {
  return Number(item?.transform?.[5] ?? item?.y ?? 0);
}

function itemWidth(item) {
  return Number(item?.width ?? 0);
}

function joinParts(parts) {
  return cleanText(parts.filter(Boolean).join(" "));
}

function isTableHeaderLine(text) {
  const lower = cleanText(text).toLowerCase();
  return lower.includes("datum")
    && (lower.includes("erlaeuterung") || lower.includes("erläuterung"))
    && lower.includes("betrag");
}

export function groupTextItemsIntoLines(items, yTolerance = 3) {
  const normalized = items
    .map((item) => ({
      text: cleanText(item.str ?? item.text ?? ""),
      x: itemX(item),
      y: itemY(item),
      width: itemWidth(item)
    }))
    .filter((item) => item.text);

  normalized.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const item of normalized) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= yTolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
  }

  return lines
    .map((line) => {
      const sortedItems = [...line.items].sort((a, b) => a.x - b.x);
      return {
        y: line.y,
        items: sortedItems,
        text: joinParts(sortedItems.map((item) => item.text))
      };
    })
    .sort((a, b) => b.y - a.y);
}

export function detectTableLayout(lines) {
  for (const line of lines) {
    if (!isTableHeaderLine(line.text)) {
      continue;
    }

    const datum = line.items.find((item) => /datum/i.test(item.text));
    const explanation = line.items.find((item) => /erl(ae|ä)uterung/i.test(item.text));
    const amount = line.items.find((item) => /betrag/i.test(item.text));

    if (datum && explanation && amount) {
      return {
        headerY: line.y,
        dateEndX: (datum.x + explanation.x) / 2,
        amountStartX: Math.max(explanation.x + 20, amount.x - 12),
        headerText: line.text
      };
    }
  }

  return null;
}

function lineToColumns(line, layout) {
  if (!layout) {
    return null;
  }

  const dateParts = [];
  const explanationParts = [];
  const amountParts = [];

  for (const item of line.items) {
    const centerX = item.x + item.width / 2;
    if (centerX < layout.dateEndX) {
      dateParts.push(item.text);
    } else if (centerX >= layout.amountStartX) {
      amountParts.push(item.text);
    } else {
      explanationParts.push(item.text);
    }
  }

  return {
    dateText: joinParts(dateParts),
    explanationText: joinParts(explanationParts),
    amountText: joinParts(amountParts),
    lineText: line.text
  };
}

function parseByLayout(line, layout) {
  const columns = lineToColumns(line, layout);
  if (!columns) {
    return null;
  }

  const date = columns.dateText.match(DATE_PATTERN)?.[0] ?? "";
  const amount = normalizeAmount(columns.amountText);
  const explanation = cleanText(columns.explanationText);

  if (!date || !amount) {
    return { date, amount, explanation, continuation: explanation || columns.lineText };
  }

  return { date, explanation, amount };
}

function parseByText(lineText) {
  const dateMatch = lineText.match(DATE_PATTERN);
  if (!dateMatch || dateMatch.index == null) {
    return null;
  }

  if (dateMatch.index > 2) {
    return null;
  }

  const amountMatches = [...lineText.matchAll(AMOUNT_PATTERN)];
  if (!amountMatches.length) {
    return null;
  }

  const amountMatch = amountMatches[amountMatches.length - 1];
  const date = dateMatch[0];
  const amount = normalizeAmount(amountMatch[0]);
  const start = dateMatch.index + date.length;
  const end = amountMatch.index ?? lineText.length;
  const explanation = cleanText(lineText.slice(start, end));

  return { date, explanation, amount };
}

function looksLikeFooter(lineText) {
  return /^(summe|saldo|kontostand|alter\s+kontostand|neuer\s+kontostand|uebertrag|übertrag)\b/i.test(lineText);
}

export function extractTransactionsFromLines(lines) {
  const layout = detectTableLayout(lines);
  const transactions = [];
  let inTable = !layout;

  for (const line of lines) {
    if (isTableHeaderLine(line.text)) {
      inTable = true;
      continue;
    }

    if (!inTable || !line.text || looksLikeFooter(line.text)) {
      continue;
    }

    const parsedByLayout = parseByLayout(line, layout);
    const parsed = parsedByLayout?.date && parsedByLayout?.amount ? parsedByLayout : parseByText(line.text);

    if (parsed?.date && parsed?.amount) {
      transactions.push({
        datum: parsed.date,
        erlaeuterung: parsed.explanation,
        betragEur: parsed.amount
      });
      continue;
    }

    const continuation = cleanText(parsedByLayout?.continuation ?? line.text);
    if (transactions.length && continuation && !BALANCE_KEYWORDS.test(continuation) && !hasAmount(continuation)) {
      const last = transactions[transactions.length - 1];
      last.erlaeuterung = cleanText(`${last.erlaeuterung} ${continuation}`);
    }
  }

  return transactions;
}

export function extractBalanceFromLines(lines) {
  const reversed = [...lines].reverse();

  for (const line of reversed) {
    if (!BALANCE_KEYWORDS.test(line.text)) {
      continue;
    }

    const amounts = [...line.text.matchAll(AMOUNT_PATTERN)].map((match) => normalizeAmount(match[0])).filter(Boolean);
    if (amounts.length) {
      return {
        value: amounts[amounts.length - 1],
        date: extractLastDate(line.text),
        source: line.text,
        confidence: "keyword"
      };
    }
  }

  for (const line of reversed.slice(0, 25)) {
    const amounts = [...line.text.matchAll(AMOUNT_PATTERN)].map((match) => normalizeAmount(match[0])).filter(Boolean);
    if (amounts.length) {
      return {
        value: amounts[amounts.length - 1],
        date: extractLastDate(line.text),
        source: line.text,
        confidence: "fallback"
      };
    }
  }

  return {
    value: "",
    date: "",
    source: "",
    confidence: "missing"
  };
}

function resolveBalanceDate(balance, lines, transactions) {
  if (balance.date) {
    return balance.date;
  }

  for (const line of [...lines].reverse().slice(0, 25)) {
    const date = extractLastDate(line.text);
    if (date) {
      return date;
    }
  }

  return transactions
    .map((transaction) => ({
      date: transaction.datum,
      key: parseDateKey(transaction.datum)
    }))
    .filter((entry) => entry.key != null)
    .sort((a, b) => b.key - a.key)[0]?.date ?? "";
}

export function buildRowsForStatement(fileName, pages) {
  const lines = pages.flatMap((page) => page.lines);
  const transactions = extractTransactionsFromLines(lines);
  const balance = extractBalanceFromLines(lines);
  const balanceDate = resolveBalanceDate(balance, lines, transactions);
  const transactionRows = transactions.map((transaction) => ({
    ...transaction,
    _kind: "transaction",
    _sourceFile: fileName
  }));
  const balanceRow = balance.value
    ? [{
      datum: balanceDate,
      erlaeuterung: balanceDate ? `Kontostand ${balanceDate}` : "Kontostand",
      betragEur: balance.value,
      _kind: "balance",
      _sourceFile: fileName
    }]
    : [];

  return {
    fileName,
    balance: {
      ...balance,
      date: balanceDate
    },
    transactions: [...transactionRows, ...balanceRow]
  };
}

export function createCsv(rows) {
  const header = ["Datum", "Erläuterung", "Betrag EUR"];
  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (/[;"\r\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };

  return [
    header.map(escapeCell).join(";"),
    ...rows.map((row) => [row.datum, row.erlaeuterung, row.betragEur].map(escapeCell).join(";"))
  ].join("\r\n");
}

export function sortRowsByDate(rows) {
  return rows
    .map((row, index) => ({
      row,
      index,
      dateKey: parseDateKey(row.datum)
    }))
    .sort((a, b) => {
      if (a.dateKey == null && b.dateKey == null) {
        return a.index - b.index;
      }
      if (a.dateKey == null) {
        return 1;
      }
      if (b.dateKey == null) {
        return -1;
      }
      return a.dateKey - b.dateKey || a.index - b.index;
    })
    .map((entry) => entry.row);
}

export function annotateDuplicateBookings(rows) {
  const output = rows.map((row) => row._warnings?.length
    ? { ...row, _warnings: [...row._warnings] }
    : { ...row });
  const groups = new Map();

  for (const [index, row] of output.entries()) {
    const key = duplicateBookingKey(row);
    if (!key) {
      continue;
    }

    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }

  const warnings = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const first = output[group[0]];
    const message = `Doppelte Buchung: ${first.datum} | ${first.erlaeuterung} | ${first.betragEur}`;
    warnings.push(message);

    for (const index of group) {
      output[index] = withRowWarning(output[index], {
        type: "duplicate-booking",
        message
      });
    }
  }

  return { rows: output, warnings };
}

export function rowsForWorkbook(rows) {
  return rows.map((row) => ({
    Datum: row.datum,
    "Erläuterung": row.erlaeuterung,
    "Betrag EUR": row.betragEur,
    __highlight: Boolean(row._warnings?.length)
  }));
}
