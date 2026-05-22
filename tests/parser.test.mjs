import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRowsForStatement,
  createCsv,
  extractBalanceFromLines,
  extractTransactionsFromLines,
  groupTextItemsIntoLines,
  sortRowsByDate
} from "../src/parser.js";

function item(str, x, y, width = str.length * 5) {
  return { str, width, transform: [1, 0, 0, 1, x, y] };
}

test("groups text items into visual lines", () => {
  const lines = groupTextItemsIntoLines([
    item("Betrag", 430, 100),
    item("Datum", 20, 100),
    item("Erläuterung", 110, 100),
    item("Kontostand 1.234,56", 20, 40)
  ]);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Datum Erläuterung Betrag");
});

test("extracts transactions using table columns and continuations", () => {
  const lines = groupTextItemsIntoLines([
    item("Datum", 20, 300),
    item("Erläuterung", 110, 300),
    item("Betrag EUR", 430, 300),
    item("02.05.2026", 20, 280),
    item("Kartenzahlung Supermarkt", 110, 280),
    item("-42,19", 450, 280),
    item("IBAN DE12 3456 7890", 110, 266),
    item("03.05.2026", 20, 245),
    item("Gehalt", 110, 245),
    item("2.100,00", 450, 245),
    item("Neuer Kontostand", 260, 80),
    item("3.123,45", 450, 80)
  ]);

  const rows = extractTransactionsFromLines(lines);
  assert.deepEqual(rows, [
    {
      datum: "02.05.2026",
      erlaeuterung: "Kartenzahlung Supermarkt IBAN DE12 3456 7890",
      betragEur: "-42,19"
    },
    {
      datum: "03.05.2026",
      erlaeuterung: "Gehalt",
      betragEur: "2.100,00"
    }
  ]);
});

test("skips repeated table headers on later pages", () => {
  const lines = groupTextItemsIntoLines([
    item("Datum", 20, 300),
    item("Erläuterung", 110, 300),
    item("Betrag EUR", 430, 300),
    item("02.05.2026", 20, 280),
    item("Kartenzahlung", 110, 280),
    item("-42,19", 450, 280),
    item("Datum", 20, 200),
    item("Erläuterung", 110, 200),
    item("Betrag EUR", 430, 200),
    item("03.05.2026", 20, 180),
    item("Gehalt", 110, 180),
    item("2.100,00", 450, 180)
  ]);

  const rows = extractTransactionsFromLines(lines);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].erlaeuterung, "Kartenzahlung");
  assert.equal(rows[1].erlaeuterung, "Gehalt");
});

test("does not turn dates inside explanations into transactions", () => {
  const lines = groupTextItemsIntoLines([
    item("Datum", 20, 320),
    item("Erläuterung", 110, 320),
    item("Betrag EUR", 430, 320),
    item("02.05.2026", 20, 300),
    item("Kartenzahlung Restaurant", 110, 300),
    item("-42,19", 450, 300),
    item("DATUM 04.05.2026, 18:45 Uhr)", 110, 286),
    item("03.05.2026", 20, 260),
    item("Gehalt", 110, 260),
    item("2.100,00", 450, 260)
  ]);

  const rows = extractTransactionsFromLines(lines);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].datum, "02.05.2026");
  assert.equal(rows[0].erlaeuterung, "Kartenzahlung Restaurant DATUM 04.05.2026, 18:45 Uhr)");
  assert.equal(rows[1].datum, "03.05.2026");
});

test("does not use explanation dates as fallback when the date column is empty", () => {
  const lines = groupTextItemsIntoLines([
    item("Datum", 20, 320),
    item("Erläuterung", 110, 320),
    item("Betrag EUR", 430, 320),
    item("02.05.2026", 20, 300),
    item("Kartenzahlung Restaurant", 110, 300),
    item("-42,19", 450, 300),
    item("DATUM 04.05.2026, 18:45 Uhr)", 110, 286),
    item("-17,99", 450, 286)
  ]);

  const rows = extractTransactionsFromLines(lines);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].datum, "02.05.2026");
  assert.equal(rows[0].erlaeuterung, "Kartenzahlung Restaurant DATUM 04.05.2026, 18:45 Uhr)");
});

test("extracts ending balance from footer keyword", () => {
  const lines = [
    { text: "Datum Erläuterung Betrag EUR", items: [], y: 200 },
    { text: "Neuer Kontostand am 31.05.2026 3.123,45", items: [], y: 20 }
  ];

  assert.equal(extractBalanceFromLines(lines).value, "3.123,45");
});

test("adds the statement balance as a final row", () => {
  const lines = groupTextItemsIntoLines([
    item("Datum", 20, 300),
    item("Erläuterung", 110, 300),
    item("Betrag EUR", 430, 300),
    item("04.05.2026", 20, 280),
    item("Lastschrift", 110, 280),
    item("-42,19", 450, 280),
    item("05.05.2026", 20, 260),
    item("Gehalt", 110, 260),
    item("2.100,00", 450, 260),
    item("Neuer Kontostand am 31.05.2026", 260, 80),
    item("3.123,45", 450, 80)
  ]);

  const result = buildRowsForStatement("auszug.pdf", [{ pageNumber: 1, lines }]);
  assert.deepEqual(result.transactions, [
    {
      datum: "04.05.2026",
      erlaeuterung: "Lastschrift",
      betragEur: "-42,19"
    },
    {
      datum: "05.05.2026",
      erlaeuterung: "Gehalt",
      betragEur: "2.100,00"
    },
    {
      datum: "31.05.2026",
      erlaeuterung: "Kontostand 31.05.2026",
      betragEur: "3.123,45"
    }
  ]);
  assert.equal(result.balance.date, "31.05.2026");
});

test("falls back to the last footer date for the balance row", () => {
  const lines = groupTextItemsIntoLines([
    item("Datum", 20, 340),
    item("Erläuterung", 110, 340),
    item("Betrag EUR", 430, 340),
    item("30.01.2026", 20, 320),
    item("Ausgang", 110, 320),
    item("-100,00", 450, 320),
    item("Abschluss per 31.01.2026", 260, 80),
    item("Kontostand", 330, 80),
    item("1.000,00", 450, 80)
  ]);

  const result = buildRowsForStatement("auszug.pdf", [{ pageNumber: 1, lines }]);
  assert.deepEqual(result.transactions.at(-1), {
    datum: "31.01.2026",
    erlaeuterung: "Kontostand 31.01.2026",
    betragEur: "1.000,00"
  });
});

test("creates semicolon csv with utf friendly header", () => {
  const csv = createCsv([
    {
      datum: "04.05.2026",
      erlaeuterung: "Text; mit Semikolon",
      betragEur: "-9,99"
    }
  ]);

  assert.equal(csv, 'Datum;Erläuterung;Betrag EUR\r\n04.05.2026;"Text; mit Semikolon";-9,99');
});

test("sorts export rows by date ascending", () => {
  const rows = sortRowsByDate([
    { datum: "05.01.2023", erlaeuterung: "PDF 2023", betragEur: "2,00" },
    { datum: "31.12.2022", erlaeuterung: "Kontostand 31.12.2022", betragEur: "1.000,00" },
    { datum: "01.01.2022", erlaeuterung: "PDF 2022", betragEur: "1,00" },
    { datum: "", erlaeuterung: "ohne Datum", betragEur: "0,00" }
  ]);

  assert.deepEqual(rows.map((row) => row.erlaeuterung), [
    "PDF 2022",
    "Kontostand 31.12.2022",
    "PDF 2023",
    "ohne Datum"
  ]);
});
