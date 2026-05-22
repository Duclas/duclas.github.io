import assert from "node:assert/strict";
import test from "node:test";
import { createXlsxBytes } from "../src/xlsx.js";

test("creates a valid xlsx zip shell", () => {
  const bytes = createXlsxBytes([
    {
      Datum: "04.05.2026",
      "Erläuterung": "Text & Sonderzeichen",
      "Betrag EUR": "-9,99",
      __highlight: true
    }
  ]);

  const decoded = new TextDecoder().decode(bytes);
  assert.equal(String.fromCharCode(...bytes.slice(0, 2)), "PK");
  assert.ok(!decoded.includes("Kontostand"));
  assert.ok(decoded.includes("styles.xml"));
  assert.ok(decoded.includes('s="1"'));
  assert.ok(bytes.length > 1000);
});
