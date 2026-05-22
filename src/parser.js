const DATE_PATTERN = /\b\d{1,2}\.\d{1,2}\.(?:\d{2,4})?\b/;
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

function normalizeAmount(value) {
  const cleaned = cleanText(value).replace(/\s+/g, "");
  const match = cleaned.match(new RegExp(EURO_AMOUNT_SOURCE));
  return match ? match[0] : "";
}

function hasAmount(value) {
  return AMOUNT_DETECT_PATTERN.test(cleanText(value));
}

function parseEuroCents(value) {
  const cleaned = normalizeAmount(value).replace(/\s+/g, "");
  if (!cleaned) {
    return null;
  }

  const negative = cleaned.startsWith("-") || cleaned.endsWith("-");
  const unsigned = cleaned.replaceAll("+", "").replaceAll("-", "");
  const [euroPart, centPart] = unsigned.split(",");
  const euros = Number.parseInt(euroPart.replaceAll(".", ""), 10);
  const cents = Number.parseInt(centPart, 10);

  if (!Number.isFinite(euros) || !Number.isFinite(cents)) {
    return null;
  }

  const total = euros * 100 + cents;
  return negative ? -total : total;
}

function formatEuroCents(value) {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const euros = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${euros},${cents}`;
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
        source: line.text,
        confidence: "fallback"
      };
    }
  }

  return {
    value: "",
    source: "",
    confidence: "missing"
  };
}

export function buildRowsForStatement(fileName, pages) {
  const lines = pages.flatMap((page) => page.lines);
  const transactions = extractTransactionsFromLines(lines);
  const balance = extractBalanceFromLines(lines);
  let runningBalance = parseEuroCents(balance.value);
  const transactionsWithBalances = [...transactions];

  for (let index = transactionsWithBalances.length - 1; index >= 0; index -= 1) {
    const transaction = transactionsWithBalances[index];
    transactionsWithBalances[index] = {
      ...transaction,
      kontostand: runningBalance == null ? balance.value : formatEuroCents(runningBalance)
    };

    const amount = parseEuroCents(transaction.betragEur);
    if (runningBalance != null && amount != null) {
      runningBalance -= amount;
    }
  }

  return {
    fileName,
    balance,
    transactions: transactionsWithBalances
  };
}

export function createCsv(rows) {
  const header = ["Datum", "Erläuterung", "Betrag EUR", "Kontostand"];
  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (/[;"\r\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };

  return [
    header.map(escapeCell).join(";"),
    ...rows.map((row) => [row.datum, row.erlaeuterung, row.betragEur, row.kontostand].map(escapeCell).join(";"))
  ].join("\r\n");
}

export function rowsForWorkbook(rows) {
  return rows.map((row) => ({
    Datum: row.datum,
    "Erläuterung": row.erlaeuterung,
    "Betrag EUR": row.betragEur,
    Kontostand: row.kontostand
  }));
}
