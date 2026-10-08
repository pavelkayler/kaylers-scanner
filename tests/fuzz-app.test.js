// Fuzz tests for the real app in Chromium: random and broken backup files, random and damaged saved state.
const test = require("node:test"), assert = require("node:assert/strict");
const fc = require("fast-check");
const A = require("./app.js");

const RUNS = Number(process.env.FUZZ_APP_RUNS) || 60;
let srv, browser;
test.before(async () => { srv = await A.startServer(); browser = await A.launch(); });
test.after(async () => { await browser.close(); await srv.close(); });

const id = fc.oneof({ weight: 6, arbitrary: fc.constantFrom("b1", "b2", "i1", "i2", "i3", "r1", "r2") },
  { weight: 1, arbitrary: fc.constantFrom("", "__proto__", "constructor", 5, null) });
const iso = fc.oneof({ weight: 6, arbitrary: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }).map(d => d.toISOString()) },
  { weight: 1, arbitrary: fc.constantFrom("", "вчера", "2026-13-45T99:00:00Z", 0) });
const codeArb = fc.oneof(fc.constantFrom("A1", "a1", "4600000000017", "\u001d01046", "ABC*"), fc.string({ maxLength: 8 }));
const batch = fc.record({ id, name: fc.oneof(fc.string({ maxLength: 10 }), fc.constant(7)), startedAt: iso, deleted: fc.boolean() }, { requiredKeys: ["id", "name"] });
const item = fc.record({ id, batchId: id, code: codeArb, format: fc.constantFrom("QR", ""), time: iso, updatedAt: fc.oneof(fc.nat(), fc.constant(NaN)), deleted: fc.boolean() },
  { requiredKeys: ["id", "batchId", "code", "time"] });
const rule = fc.record({ id, type: fc.constantFrom("exact", "prefix", "contains", "regex", "other"), pattern: fc.oneof(codeArb, fc.constant("[")), device: fc.string({ maxLength: 6 }), deleted: fc.boolean() },
  { requiredKeys: ["id", "type", "pattern", "device"] });
// mostly backup-shaped files with random contents, sometimes anything at all
const backupText = fc.oneof(
  { weight: 6, arbitrary: fc.record({ app: fc.constant("kaylers-scanner"), createdAt: fc.oneof(iso, fc.constant(undefined)),
    batches: fc.array(batch, { maxLength: 4 }), items: fc.array(item, { maxLength: 6 }), rules: fc.array(rule, { maxLength: 3 }),
    batchContext: fc.option(fc.array(batch, { maxLength: 2 }), { nil: undefined }) }).map(o => JSON.stringify(o)) },
  { weight: 1, arbitrary: fc.jsonValue().map(v => JSON.stringify(v)) },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) });

async function pickFile(page, text){
  await page.evaluate(() => { document.getElementById("backupStatus").textContent = ""; });
  await page.setInputFiles("#backupFile", []);
  await page.setInputFiles("#backupFile", { name: "copy.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await page.waitForFunction(() => document.getElementById("backupStatus").textContent || !document.getElementById("backupPreview").hidden);
}

test("fuzz: any backup file is either refused with nothing changed, or adds only what the phone lacks", { timeout: 30 * 60 * 1000 }, async () => {
  const r = await A.openApp(browser, srv.url);
  try{
    // something on the phone already, so the restore has to merge
    for(const c of ["A1", "4600000000017"]){ await r.page.fill("#manualInput", c); await r.page.evaluate(() => document.getElementById("manualForm").requestSubmit()); }
    await r.page.fill("#rulePattern", "46*"); await r.page.fill("#ruleDevice", "Принтер");
    await r.page.evaluate(() => document.getElementById("ruleForm").requestSubmit());
    await fc.assert(fc.asyncProperty(backupText, async text => {
      const before = await A.readState(r.page), B = JSON.parse(before);
      await pickFile(r.page, text);
      const preview = !(await r.page.evaluate(() => document.getElementById("backupPreview").hidden));
      const canAdd = preview && !(await r.page.evaluate(() => document.getElementById("backupConfirm").disabled));
      if(!canAdd){
        if(preview) await r.page.evaluate(() => document.getElementById("backupCancel").click());
        assert.equal(await A.readState(r.page), before, "a refused or empty file changed the phone");
      } else {
        await r.page.evaluate(() => document.getElementById("backupConfirm").click());
        const S = A.checkStateShape(await A.readState(r.page));
        for(const k of ["batches", "items", "rules"]) for(const [id, o] of Object.entries(B[k])) assert.deepEqual(S[k][id], o, "existing record changed");
        // the same file again adds nothing
        await pickFile(r.page, text);
        assert.equal(await r.page.textContent("#backupStatus"), "Всё из этого файла уже есть на телефоне.");
      }
      assert.deepEqual(r.errors, []);
      assert.equal(await A.notice(r.page), "");
    }), { numRuns: RUNS * 3 });
  }finally{ await r.context.close(); }
});

// What earlier versions or a broken write could leave in storage. The app must either start with every live record,
// or stop and leave the saved text untouched so it can be downloaded. It must never replace it with an empty state.
const stateText = fc.oneof(
  { weight: 5, arbitrary: fc.record({ prefixLen: fc.oneof(fc.integer({ min: 1, max: 12 }), fc.constant(undefined)), batchId: fc.oneof(id, fc.constant(undefined)),
    batches: fc.dictionary(fc.constantFrom("b1", "b2", "b3"), batch), items: fc.dictionary(fc.constantFrom("i1", "i2", "i3", "i4"), item),
    rules: fc.dictionary(fc.constantFrom("r1", "r2"), rule), epoch: fc.option(fc.nat(), { nil: undefined }) },
    { requiredKeys: [] }).map(o => JSON.stringify(o)) },
  { weight: 1, arbitrary: fc.jsonValue().map(v => JSON.stringify(v)) },
  { weight: 1, arbitrary: fc.string({ maxLength: 30 }) });

test("fuzz: the app starts from any saved state without losing or overwriting data", { timeout: 30 * 60 * 1000 }, async () => {
  await fc.assert(fc.asyncProperty(stateText, async raw => {
    const r = await A.openApp(browser, srv.url, { state: raw });
    try{
      const now = await A.readState(r.page), stop = await A.notice(r.page);
      assert.deepEqual(r.errors, []);
      if(stop){
        assert.equal(now, raw, "the damaged state was changed");
        assert.ok(await r.page.evaluate(() => document.getElementById("manualInput").disabled), "scanning stays off");
        return;
      }
      const S = A.checkStateShapeLoose(now), old = JSON.parse(raw);
      for(const k of ["batches", "items", "rules"]) for(const o of Object.values(old[k] || {})) if(!o.deleted)
        assert.ok(S[k][o.id], `live ${k} record ${o.id} was lost`);
      // and the app keeps working
      await r.page.fill("#manualInput", "NEW-CODE"); await r.page.evaluate(() => document.getElementById("manualForm").requestSubmit());
      assert.ok(Object.values(JSON.parse(await A.readState(r.page)).items).some(i => i.code === "NEW-CODE"));
    }finally{ await r.context.close(); }
  }), { numRuns: RUNS });
});

for(const [where, base] of [["from a subfolder (GitHub Pages)", "/kaylers-scanner/"], ["from the PC (site root)", "/"]])
test("offline: the Home Screen app opens with no connection when served " + where, { timeout: 60000 }, async () => {
  const site = await A.startServer(base), context = await browser.newContext(), page = await context.newPage();
  try{
    await page.goto(site.url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // now controlled by the service worker
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    for(const u of [site.url, site.url + "index.html", site.url + "?source=pwa"]){
      const res = await page.goto(u).catch(e => e);
      assert.ok(!(res instanceof Error), `${u} did not open offline: ${res && res.message}`);
      assert.equal(res.status(), 200, u);
      await page.waitForFunction(() => document.getElementById("batchTitle").textContent, null, { timeout: 10000 });
    }
  }finally{ await context.close(); await site.close(); }
});
