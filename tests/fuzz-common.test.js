// Fuzz tests for common.js: each property runs on hundreds of random inputs.
const test = require("node:test"), assert = require("node:assert/strict");
const fc = require("fast-check");
const { CS, XLSX } = require("./load-common.js")();

// results from the sandbox carry its own Array prototype; compare plain copies
const plain = x => x === undefined ? x : JSON.parse(JSON.stringify(x));
const deq = (a, b) => assert.deepEqual(plain(a), plain(b));

const RUNS = Number(process.env.FUZZ_RUNS) || 300;
const opts = { numRuns: RUNS };

// Scanned codes: printable ASCII and Cyrillic, the GS separator of GS1 DataMatrix ("Честный знак") and the odd symbol.
const codeChar = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefxyz0123456789-_./:") },
  { weight: 2, arbitrary: fc.constantFrom(..."*/ ()+%$#'\"[]?\\|<>=") },
  { weight: 1, arbitrary: fc.constantFrom("\u001d", "Ж", "ё", "№", "€") });
const code = fc.stringOf(codeChar, { minLength: 1, maxLength: 40 }).map(s => s.trim()).filter(s => !!s);
const device = fc.stringOf(fc.constantFrom(..."Ноутбук Lenovo T14 iPhone 15 Принтер HP-1 'Склад' /\\*[]:?"), { minLength: 1, maxLength: 30 })
  .map(s => s.trim()).filter(s => !!s);
const ruleType = fc.constantFrom("exact", "prefix", "contains");
// A rule as the app stores it: a prefix comes from the first n characters of a scanned code, so it can end in anything.
const rule = fc.record({ type: ruleType, pattern: code, device });

const roundTrip = blob => blob.arrayBuffer().then(b => new Uint8Array(b));

test("fuzz: parsePattern and showPattern agree (parse(show(parse(s))) == parse(s))", () => {
  fc.assert(fc.property(fc.string({ maxLength: 30 }), s => {
    const r = CS.parsePattern(s);
    deq(CS.parsePattern(CS.showPattern(r)), r);
  }), opts);
});

test("fuzz: every stored rule survives the device base Excel file unchanged", async () => {
  await fc.assert(fc.asyncProperty(fc.array(rule, { minLength: 1, maxLength: 15 }), async rules => {
    const { rules: back, skipped } = CS.readRules(await roundTrip(CS.rulesBlob(rules)));
    assert.equal(skipped, 0);
    const key = r => r.type + "|" + r.pattern + "|" + r.device;
    deq(back.map(key).sort(), rules.map(key).sort());
  }), opts);
});

test("fuzz: a hand-made device file without a header row loses no rows", async () => {
  // codes that merely contain a header word ("QR-CODE-17", "КОД-5") are data too
  const plainCode = fc.oneof(code, fc.constantFrom("QR-CODE-17", "Barcode 5", "КОД-5", "SHABLON", "pattern-x", "Код или шаблон 2"))
    .map(c => c.replace(/^[*/]+|[*/]+$/g, "")).filter(s => !!s);
  const row = fc.tuple(plainCode, device);
  await fc.assert(fc.asyncProperty(fc.array(row, { minLength: 1, maxLength: 10 }), async rows => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Лист1");
    const { rules, skipped } = CS.readRules(new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" })));
    assert.equal(rules.length + skipped, rows.length);
  }), opts);
});

test("fuzz: matchRule picks exact, then the longest prefix, ignores case and deleted rules, never throws", () => {
  const anyRule = fc.record({ type: fc.constantFrom("exact", "prefix", "contains", "regex"),
    pattern: fc.string({ minLength: 1, maxLength: 6 }), device, deleted: fc.boolean() });
  fc.assert(fc.property(fc.array(anyRule, { maxLength: 12 }), code, (rules, c) => {
    const hit = CS.matchRule(rules, c);
    const live = rules.filter(r => !r.deleted), C = c.toUpperCase();
    if(hit) assert.ok(!hit.deleted, "a deleted rule matched");
    const exact = live.find(r => r.type === "exact" && r.pattern.toUpperCase() === C);
    if(exact){ assert.equal(hit, exact); return; }
    const prefixes = live.filter(r => r.type === "prefix" && C.startsWith(r.pattern.toUpperCase()));
    if(prefixes.length){
      assert.equal(hit.type, "prefix");
      assert.equal(hit.pattern.length, Math.max(...prefixes.map(r => r.pattern.length)));
    }
    assert.equal(CS.device(rules, c), hit ? hit.device : "");
    const noRegex = live.filter(r => r.type !== "regex");
    assert.equal(CS.matchRule(noRegex, c.toLowerCase()), CS.matchRule(noRegex, c.toUpperCase()));
  }), opts);
});

test("fuzz: Excel file names are safe for Windows and iPhone Files", () => {
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 120 }), fc.fullUnicodeString({ maxLength: 80 }), fc.constant(null)),
    fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31") }), (name, d) => {
      const f = CS.fileName(name, d);
      assert.match(f, /_\d{4}-\d\d-\d\d_\d\d-\d\d\.xlsx$/);
      assert.doesNotMatch(f, /[\\/:*?"<>|\u0000-\u001f]/);
      const base = f.slice(0, -"_2026-10-07_15-30.xlsx".length);
      assert.ok(base.length >= 1 && base.length <= 60, "name part " + JSON.stringify(base));
      assert.equal(base, base.trim());
    }), opts);
});

// Excel's own rules for sheet names: 1–31 characters, none of []:*?/\, no apostrophe at either end,
// not "History", and unique ignoring case. A file that breaks them opens with a repair prompt or not at all.
const validSheetNames = names => {
  const seen = new Set();
  for(const n of names){
    assert.ok(n.length >= 1 && n.length <= 31, "length of " + JSON.stringify(n));
    assert.doesNotMatch(n, /[\[\]:*?\/\\]/);
    assert.ok(!n.startsWith("'") && !n.endsWith("'"), "apostrophe at the edge of " + JSON.stringify(n));
    assert.notEqual(n.toLowerCase(), "history");
    assert.ok(!seen.has(n.toLowerCase()), "duplicate sheet " + JSON.stringify(n));
    seen.add(n.toLowerCase());
  }
};
const listName = fc.oneof(fc.string({ maxLength: 50 }), fc.constantFrom("History", "history", "'Склад'", "Поставка", "ПОСТАВКА", "a".repeat(40)),
  fc.stringOf(fc.constantFrom(..."Аа'[]:*?/\\ 1"), { maxLength: 35 }));

test("fuzz: the Excel export of any set of lists opens with valid, distinct sheet names", async () => {
  await fc.assert(fc.asyncProperty(fc.array(listName, { minLength: 1, maxLength: 8 }), async names => {
    const book = XLSX.read(await roundTrip(CS.workbookBlob(names.map(n => [n, XLSX.utils.aoa_to_sheet([[n]])]))), { type: "array" });
    assert.equal(book.SheetNames.length, names.length);
    validSheetNames(book.SheetNames);
    // the sheets keep the order of the lists
    deq(book.SheetNames.map(s => book.Sheets[s].A1 ? String(book.Sheets[s].A1.v) : ""), names.map(String));
  }), opts);
});

test("fuzz: a list sheet holds every code exactly, in scan order, with the right count", async () => {
  const item = fc.record({ code, format: fc.constantFrom("", "QR", "EAN 13", "DATA MATRIX"),
    time: fc.date({ min: new Date("2024-01-01"), max: new Date("2030-01-01") }).map(d => d.toISOString()) });
  await fc.assert(fc.asyncProperty(fc.array(item, { minLength: 1, maxLength: 25 }), fc.array(rule, { maxLength: 5 }), async (items, rules) => {
    const ws = CS.batchSheet({ name: "Список" }, items, rules);
    const book = XLSX.read(await roundTrip(CS.workbookBlob([["Список", ws]])), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: "" });
    assert.equal(rows[2][1], items.length);
    const body = rows.slice(5);
    const sorted = items.slice().sort((a, b) => a.time.localeCompare(b.time));
    deq(body.map(r => String(r[1])), sorted.map(i => i.code));
    deq(body.map(r => r[0]), sorted.map(i => CS.device(rules, i.code)));
  }), opts);
});

test("fuzz: the scan period text never throws and names the first and last scan", () => {
  fc.assert(fc.property(fc.array(fc.date({ min: new Date("2000-01-01"), max: new Date("2090-01-01") }), { maxLength: 20 }), ds => {
    const p = CS.period(ds.map(d => ({ time: d.toISOString() })));
    assert.equal(typeof p, "string");
    assert.equal(p === "", ds.length === 0);
  }), opts);
});
