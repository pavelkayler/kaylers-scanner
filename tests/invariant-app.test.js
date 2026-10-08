// Invariant tests (stateful fuzzing): random sequences of user actions on the real app in Chromium.
// After every step the saved state is compared with a simple model, and rules that must always hold are checked:
// no code twice in one list, every code has its list, the open list exists, the screen matches the saved data,
// a reload changes nothing, Excel files and the backup hold exactly what the phone holds.
const test = require("node:test"), assert = require("node:assert/strict");
const fc = require("fast-check");
const A = require("./app.js");
const { CS, XLSX } = require("./load-common.js")();

// arrays made by the sandboxed SheetJS have their own prototype; compare plain copies
const plain = x => x === undefined ? x : JSON.parse(JSON.stringify(x));
const deq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);

const RUNS = Number(process.env.INVARIANT_RUNS) || 25;
const MAX_STEPS = Number(process.env.INVARIANT_STEPS) || 30;

const CODES = ["A1", "a1", "  A1  ", "4600000000017", "QR-CODE-17", "\u001d0104600000000017", "ABC*", "*X*", "/re/", "Ж-1", "x".repeat(70), ""];
const PATTERNS = ["A*", "a1", "*CODE*", "/^46/", "46*", "ABC*", "/[/", "  ", "**", "Ж-1", "X"];
const DEVICES = ["Ноутбук", "Принтер HP", " ", "Сканер 'Склад'", "ноутбук"];
const NAMES = ["Поставка", "поставка", "  Поставка   1 ", "History", "'Склад'", "", "a".repeat(80), "Список/2026:10*"];

// ---------- model ----------
const ruleKey = r => r.type + "\n" + r.pattern.toUpperCase();
function upsert(m, r){
  const k = ruleKey(r), same = m.rules.get(k);
  if(same) same.device = r.device; else m.rules.set(k, { type: r.type, pattern: r.pattern, device: r.device });
}
const current = m => m.lists.get(m.current);
function fromState(S){
  const lists = new Map(Object.values(S.batches).map(b => [b.id, { name: b.name, codes: [] }]));
  for(const it of Object.values(S.items).sort((a, b) => a.time.localeCompare(b.time))) lists.get(it.batchId).codes.push(it.code);
  const rules = new Map();
  for(const r of Object.values(S.rules)) rules.set(ruleKey(r), { type: r.type, pattern: r.pattern, device: r.device });
  return { lists, current: S.batchId, rules };
}
const sortedCodes = c => c.slice().sort();
function sameAsModel(S, m){
  const real = fromState(S);
  assert.equal(real.current, m.current, "a different list is open");
  deq([...real.lists.keys()].sort(), [...m.lists.keys()].sort(), "set of lists");
  for(const [id, l] of m.lists){
    assert.equal(real.lists.get(id).name, l.name, "list name");
    deq(sortedCodes(real.lists.get(id).codes), sortedCodes(l.codes), "codes of list " + l.name);
  }
  deq([...real.rules.entries()].sort(), [...m.rules.entries()].sort(), "device rules");
}

async function checkAll(m, r){
  const raw = await A.readState(r.page);
  const S = A.checkStateShape(raw);
  sameAsModel(S, m);
  deq(r.errors, [], "errors on the page");
  assert.equal(await A.notice(r.page), "", "the app shows a blocking notice");
  const ui = await r.page.evaluate(() => ({
    count: Number(document.getElementById("count").firstChild.nodeValue),
    rows: [...document.querySelectorAll("#list li:not(.empty)")].map(li => li.querySelector(".code").textContent),
    lists: document.querySelectorAll("#lists .listrow").length,
    rules: document.querySelectorAll("#rules .rule").length,
    title: document.getElementById("batchTitle").textContent,
    end: document.getElementById("endBtn").disabled
  }));
  const cur = current(m);
  assert.equal(ui.count, cur.codes.length, "counter on screen");
  deq(sortedCodes(ui.rows), sortedCodes(cur.codes), "codes on screen");
  assert.equal(ui.lists, m.lists.size, "rows in «Мои списки»");
  assert.equal(ui.rules, m.rules.size, "rows in the device base");
  assert.equal(ui.title, cur.name, "list title");
  assert.equal(ui.end, cur.codes.length === 0, "Excel button state");
}
const click = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
// buttons are found by their text inside a row, the way a person finds them
const clickIn = (page, rowSel, k, text) => page.evaluate(([rowSel, k, text]) => {
  const row = document.querySelectorAll(rowSel)[k];
  [...row.querySelectorAll("button")].find(b => b.textContent === text).click();
}, [rowSel, k, text]);

const clearStatus = page => page.evaluate(() => { document.getElementById("backupStatus").textContent = ""; });

// ---------- commands ----------
class AddCode {
  constructor(code){ this.code = code; }
  check(){ return true; }
  async run(m, r){
    await r.page.fill("#manualInput", this.code);
    await r.page.evaluate(() => document.getElementById("manualForm").requestSubmit());
    const c = this.code.replace(/[\r\n]/g, "").trim(); // a text field drops line breaks
    if(c && !current(m).codes.includes(c)) current(m).codes.push(c);
    await checkAll(m, r);
  }
  toString(){ return `add(${JSON.stringify(this.code)})`; }
}
class DeleteCode {
  constructor(k){ this.k = k; }
  check(m){ return current(m).codes.length > 0; }
  async run(m, r){
    const codes = current(m).codes, code = codes[this.k % codes.length];
    await r.page.evaluate(code => [...document.querySelectorAll("#list li")].find(li => li.querySelector(".code").textContent === code).querySelector("button.del").click(), code);
    codes.splice(codes.indexOf(code), 1);
    await checkAll(m, r);
  }
  toString(){ return `deleteCode(${this.k})`; }
}
class NewList {
  check(){ return true; }
  async run(m, r){
    await click(r.page, "#newBtn");
    if(current(m).codes.length){
      const S = JSON.parse(await A.readState(r.page));
      assert.ok(!m.lists.has(S.batchId), "«Новый список» did not open a new list");
      m.lists.set(S.batchId, { name: S.batches[S.batchId].name, codes: [] }); m.current = S.batchId;
    }
    await checkAll(m, r);
  }
  toString(){ return "newList"; }
}
class OpenList {
  constructor(k){ this.k = k; }
  check(m){ return m.lists.size > 1; }
  async run(m, r){
    const n = await r.page.evaluate(() => [...document.querySelectorAll("#lists .listrow")].filter(x => [...x.querySelectorAll("button")].some(b => b.textContent === "Открыть")).length);
    assert.equal(n, m.lists.size - 1, "every list but the open one has «Открыть»");
    await r.page.evaluate(k => [...document.querySelectorAll("#lists .listrow")].filter(x => [...x.querySelectorAll("button")].some(b => b.textContent === "Открыть"))[k]
      .querySelectorAll("button")[0].click(), this.k % n);
    const S = JSON.parse(await A.readState(r.page)), prev = m.current;
    assert.ok(m.lists.has(S.batchId) && S.batchId !== prev, "«Открыть» opened an unknown list");
    if(!current(m).codes.length) m.lists.delete(prev); // an empty list is dropped when another one is opened
    m.current = S.batchId;
    await checkAll(m, r);
  }
  toString(){ return `openList(${this.k})`; }
}
class DeleteList {
  constructor(k){ this.k = k; }
  check(){ return true; }
  async run(m, r){
    const k = this.k % m.lists.size;
    await clickIn(r.page, "#lists .listrow", k, "Удалить");
    await clickIn(r.page, "#lists .listrow", k, "Удалить"); // confirm
    const S = JSON.parse(await A.readState(r.page));
    const gone = [...m.lists.keys()].filter(id => !S.batches[id]);
    assert.equal(gone.length, 1, "exactly one list is deleted");
    m.lists.delete(gone[0]);
    if(gone[0] === m.current){
      assert.ok(!m.lists.has(S.batchId));
      m.lists.set(S.batchId, { name: S.batches[S.batchId].name, codes: [] }); m.current = S.batchId;
    }
    m.deleted.add(gone[0]);
    await checkAll(m, r);
  }
  toString(){ return `deleteList(${this.k})`; }
}
class RenameList {
  constructor(name){ this.name = name; }
  check(){ return true; }
  async run(m, r){
    await click(r.page, "#nameBtn");
    await r.page.fill("#batchInput", this.name);
    await r.page.evaluate(() => document.getElementById("batchForm").requestSubmit());
    const n = this.name.slice(0, 80).replace(/\s+/g, " ").trim(); // the field takes at most 80 characters
    if(n) current(m).name = n;
    await checkAll(m, r);
  }
  toString(){ return `rename(${JSON.stringify(this.name)})`; }
}
class AddRule {
  constructor(p, d){ this.p = p; this.d = d; }
  check(){ return true; }
  async run(m, r){
    await r.page.fill("#rulePattern", this.p); await r.page.fill("#ruleDevice", this.d);
    await r.page.evaluate(() => document.getElementById("ruleForm").requestSubmit());
    const rule = Object.assign({}, CS.parsePattern(this.p)), device = this.d.trim();
    let ok = !!rule.pattern && !!device;
    if(ok && rule.type === "regex") try{ new RegExp(rule.pattern); }catch(_){ ok = false; }
    if(ok) upsert(m, { type: rule.type, pattern: rule.pattern, device });
    await checkAll(m, r);
  }
  toString(){ return `addRule(${JSON.stringify(this.p)}, ${JSON.stringify(this.d)})`; }
}
class DeleteRule {
  constructor(k){ this.k = k; }
  check(m){ return m.rules.size > 0; }
  async run(m, r){
    await r.page.evaluate(k => document.querySelectorAll("#rules .rule button.del")[k].click(), this.k % m.rules.size);
    const S = JSON.parse(await A.readState(r.page)), left = new Set(Object.values(S.rules).map(ruleKey));
    const gone = [...m.rules.keys()].filter(k => !left.has(k));
    assert.equal(gone.length, 1, "exactly one rule is deleted");
    m.rules.delete(gone[0]);
    await checkAll(m, r);
  }
  toString(){ return `deleteRule(${this.k})`; }
}
// tap the device chip of a code, pick "По началу кода" with n characters or "Только этот", type a name, save
class NameDevice {
  constructor(k, exact, n, name){ Object.assign(this, { k, exact, n, name }); }
  check(m){ return current(m).codes.length > 0; }
  async run(m, r){
    const codes = current(m).codes, code = codes[this.k % codes.length];
    const row = `[...document.querySelectorAll("#list li")].find(li => li.querySelector(".code").textContent === ${JSON.stringify(code)})`;
    await r.page.evaluate(row => eval(row).querySelector(".meta button").click(), row);
    await r.page.evaluate(([row, exact]) => [...eval(row).querySelectorAll(".scope button")][exact ? 1 : 0].click(), [row, this.exact]);
    const n = Math.max(1, Math.min(code.length, this.n));
    if(!this.exact){
      for(let guard = 0; guard < 200; guard++){
        const cur = await r.page.evaluate(row => Number(eval(row).querySelector(".tune b").textContent), row);
        if(cur === n) break;
        await r.page.evaluate(([row, more]) => eval(row).querySelector(`.tune button[aria-label="${more ? "Больше" : "Меньше"} символов"]`).click(), [row, cur < n]);
      }
    }
    await r.page.fill("#nameInput", this.name);
    await r.page.evaluate(row => eval(row).querySelector("form.namer").requestSubmit(), row);
    const rules = [...m.rules.values()], hit = CS.matchRule(rules, code);
    for(const [k, x] of [...m.rules]) if((hit && ruleKey(x) === ruleKey(hit)) || (x.type === "exact" && x.pattern.toUpperCase() === code.toUpperCase())) m.rules.delete(k);
    const name = this.name.trim();
    if(name) upsert(m, this.exact ? { type: "exact", pattern: code, device: name } : { type: "prefix", pattern: code.slice(0, n), device: name });
    await checkAll(m, r);
  }
  toString(){ return `nameDevice(${this.k}, ${this.exact ? "exact" : "prefix " + this.n}, ${JSON.stringify(this.name)})`; }
}
class Reload {
  check(){ return true; }
  async run(m, r){ await A.reload(r.page); await checkAll(m, r); }
  toString(){ return "reload"; }
}
// "End scanning": the Excel file holds the open list, in scan order, with device names
class ExportExcel {
  check(m){ return current(m).codes.length > 0; }
  async run(m, r){
    await click(r.page, "#endBtn");
    await r.page.waitForFunction(() => !document.getElementById("afterExport").hidden);
    const [f] = await A.takeSaved(r.page);
    assert.ok(f && f.name.endsWith(".xlsx"));
    const book = XLSX.read(new Uint8Array(f.buf), { type: "array" }), rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: "" });
    assert.equal(rows[0][0], current(m).name);
    assert.equal(rows[2][1], current(m).codes.length);
    deq(rows.slice(5).map(x => String(x[1])), current(m).codes, "codes in the file, in scan order");
    const rules = [...m.rules.values()];
    deq(rows.slice(5).map(x => x[0]), current(m).codes.map(c => CS.device(rules, c)), "device names in the file");
    await click(r.page, "#afterKeep");
    await checkAll(m, r);
  }
  toString(){ return "exportExcel"; }
}
// "Excel: все списки": one valid sheet per non-empty list
class ExportAll {
  check(m){ return [...m.lists.values()].some(l => l.codes.length); }
  async run(m, r){
    await r.page.evaluate(() => document.getElementById("allExcelBtn").click());
    await r.page.waitForFunction(() => window.__saved.length > 0);
    const [f] = await A.takeSaved(r.page);
    const book = XLSX.read(new Uint8Array(f.buf), { type: "array" });
    const full = [...m.lists.values()].filter(l => l.codes.length);
    assert.equal(book.SheetNames.length, full.length, "one sheet per list with codes");
    assert.equal(new Set(book.SheetNames.map(s => s.toLowerCase())).size, book.SheetNames.length, "sheet names unique ignoring case");
    const got = book.SheetNames.map(s => { const rows = XLSX.utils.sheet_to_json(book.Sheets[s], { header: 1, raw: true, defval: "" }); return rows.slice(5).map(x => String(x[1])).sort().join("\n"); }).sort();
    deq(got, full.map(l => sortedCodes(l.codes).join("\n")).sort());
    await checkAll(m, r);
  }
  toString(){ return "exportAll"; }
}
// download a backup and keep it; restoring the newest one right away adds nothing
class Backup {
  check(){ return true; }
  async run(m, r){
    await click(r.page, "#backupBtn");
    await r.page.waitForFunction(() => window.__saved.length > 0);
    const [f] = await A.takeSaved(r.page);
    const copy = JSON.parse(f.buf.toString("utf8"));
    assert.equal(copy.items.length, [...m.lists.values()].reduce((n, l) => n + l.codes.length, 0), "every code is in the backup");
    m.backups.push(f.buf);
    await clearStatus(r.page);
    await r.page.setInputFiles("#backupFile", { name: "b.json", mimeType: "application/json", buffer: f.buf });
    await r.page.waitForFunction(() => document.getElementById("backupStatus").textContent);
    assert.equal(await r.page.textContent("#backupStatus"), "Всё из этого файла уже есть на телефоне.");
    await click(r.page, "#backupCancel");
    await checkAll(m, r);
  }
  toString(){ return "backup"; }
}
// restore an older backup: everything in it comes back, nothing on the phone changes, a second restore adds nothing
class Restore {
  constructor(k){ this.k = k; }
  check(m){ return m.backups.length > 0; }
  async run(m, r){
    const buf = m.backups[this.k % m.backups.length], copy = JSON.parse(buf.toString("utf8"));
    const before = JSON.parse(await A.readState(r.page));
    await clearStatus(r.page);
    await r.page.setInputFiles("#backupFile", { name: "b.json", mimeType: "application/json", buffer: buf });
    await r.page.waitForFunction(() => document.getElementById("backupStatus").textContent);
    if(!(await r.page.evaluate(() => document.getElementById("backupConfirm").disabled))) await click(r.page, "#backupConfirm");
    else await click(r.page, "#backupCancel");
    const S = A.checkStateShape(await A.readState(r.page));
    for(const [id, it] of Object.entries(before.items)) deq(S.items[id], it, "a code on the phone was changed by the restore");
    for(const [id, b] of Object.entries(before.batches)) deq(S.batches[id], b, "a list on the phone was changed by the restore");
    for(const [id, x] of Object.entries(before.rules)) deq(S.rules[id], x, "a rule on the phone was changed by the restore");
    const have = new Set(Object.values(S.items).map(i => i.batchId + "\n" + i.code));
    for(const it of copy.items) assert.ok(have.has(it.batchId + "\n" + it.code), "code from the backup is missing: " + it.code);
    const pats = new Set(Object.values(S.rules).map(ruleKey));
    for(const x of copy.rules) assert.ok(pats.has(ruleKey(x)), "rule from the backup is missing");
    const next = fromState(S); m.lists = next.lists; m.rules = next.rules; m.current = next.current;
    await checkAll(m, r);
    // the same file again: nothing to add
    await r.page.setInputFiles("#backupFile", []);
    await clearStatus(r.page);
    await r.page.setInputFiles("#backupFile", { name: "b.json", mimeType: "application/json", buffer: buf });
    await r.page.waitForFunction(() => document.getElementById("backupStatus").textContent.startsWith("Всё") || !document.getElementById("backupPreview").hidden);
    assert.equal(await r.page.textContent("#backupStatus"), "Всё из этого файла уже есть на телефоне.");
    await click(r.page, "#backupCancel");
  }
  toString(){ return `restore(${this.k})`; }
}

// "Скачать справочник", then "Загрузить из файла" with that same file: every rule comes back as it was, nothing new
class RulesRoundTrip {
  check(m){ return m.rules.size > 0; }
  async run(m, r){
    await r.page.evaluate(() => document.getElementById("rulesExportBtn").click());
    await r.page.waitForFunction(() => window.__saved.length > 0);
    const [f] = await A.takeSaved(r.page);
    await r.page.evaluate(() => { document.getElementById("msg").textContent = ""; });
    await r.page.setInputFiles("#rulesFile", { name: f.name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: f.buf });
    await r.page.waitForFunction(() => /Справочник загружен|Не получилось/.test(document.getElementById("msg").textContent));
    assert.equal(await r.page.textContent("#msg"), `Справочник загружен: новых правил 0, изменено 0, без изменений ${m.rules.size}.`);
    await checkAll(m, r);
  }
  toString(){ return "rulesRoundTrip"; }
}

const commands = [
  fc.constantFrom(...CODES).map(c => new AddCode(c)),
  fc.constantFrom(...CODES).map(c => new AddCode(c)),
  fc.string({ maxLength: 12 }).map(c => new AddCode(c)),
  fc.nat(50).map(k => new DeleteCode(k)),
  fc.constant(new NewList()),
  fc.nat(50).map(k => new OpenList(k)),
  fc.nat(50).map(k => new DeleteList(k)),
  fc.constantFrom(...NAMES).map(n => new RenameList(n)),
  fc.tuple(fc.constantFrom(...PATTERNS), fc.constantFrom(...DEVICES)).map(([p, d]) => new AddRule(p, d)),
  fc.nat(50).map(k => new DeleteRule(k)),
  fc.tuple(fc.nat(50), fc.boolean(), fc.integer({ min: 1, max: 12 }), fc.constantFrom(...DEVICES, "")).map(a => new NameDevice(...a)),
  fc.constant(new Reload()),
  fc.constant(new ExportExcel()),
  fc.constant(new ExportAll()),
  fc.constant(new Backup()),
  fc.nat(10).map(k => new Restore(k)),
  fc.constant(new RulesRoundTrip())
];

test("invariants hold over random sequences of user actions", { timeout: 60 * 60 * 1000 }, async () => {
  const srv = await A.startServer(), browser = await A.launch();
  try{
    await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: MAX_STEPS }), async cmds => {
      const r = await A.openApp(browser, srv.url);
      try{
        const S = A.checkStateShape(await A.readState(r.page));
        const m = Object.assign(fromState(S), { backups: [], deleted: new Set() });
        await fc.asyncModelRun(() => ({ model: m, real: r }), cmds);
        // the whole state survives closing and reopening the app
        const raw = await A.readState(r.page);
        await A.reload(r.page);
        assert.equal(await A.readState(r.page), raw, "reopening the app changed the saved data");
      }finally{ await r.context.close(); }
    }), { numRuns: RUNS, endOnFailure: true });
  }finally{ await browser.close(); await srv.close(); }
});
