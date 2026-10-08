// Runs the real index.html in headless Chromium, served under /kaylers-scanner/ like GitHub Pages.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const BASE = "/kaylers-scanner/";
const KEY = "cs.state.v1";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".gz": "application/gzip" };

function startServer(BASE = module.exports.BASE){
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if(!p.startsWith(BASE)){ res.writeHead(404); return res.end(); }
    p = p.slice(BASE.length) || "index.html";
    const file = path.join(ROOT, p);
    if(!file.startsWith(ROOT) || file.includes(path.sep + "tests" + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () =>
    r({ url: `http://localhost:${server.address().port}${BASE}`, close: () => new Promise(c => { server.closeAllConnections(); server.close(c); }) })));
}

const launch = () => chromium.launch();

// Files the app hands to "Save to Files" are captured instead of downloaded.
async function captureSaves(page){
  await page.evaluate(() => {
    window.__saved = [];
    for(const d of document.querySelectorAll("details")) d.open = true; // «Мои списки» and the device base, as a person opens them
    CS.saveBlob = async (name, blob) => {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      window.__saved.push({ name, bytes });
      return "saved";
    };
  });
}
async function takeSaved(page){
  const s = await page.evaluate(() => { const s = window.__saved; window.__saved = []; return s; });
  return s.map(f => ({ name: f.name, buf: Buffer.from(f.bytes) }));
}

async function waitReady(page){
  await page.waitForFunction(() => {
    const n = document.getElementById("notice");
    return (document.getElementById("batchTitle").textContent && !document.getElementById("manualInput").disabled) || (n && !n.hidden);
  }, null, { timeout: 15000 });
}

// A fresh phone: new browser profile, the app opened and ready.
async function openApp(browser, url, { state } = {}){
  const context = await browser.newContext();
  const errors = [];
  if(state !== undefined)
    await context.addInitScript(([k, v]) => { if(!sessionStorage.getItem("__seeded")){ sessionStorage.setItem("__seeded", "1"); localStorage.setItem(k, v); } }, [KEY, state]);
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(String(e && e.stack || e)));
  await page.goto(url);
  await waitReady(page);
  await captureSaves(page);
  return { context, page, errors };
}
async function reload(page){
  await page.reload();
  await waitReady(page);
  await captureSaves(page);
}

const readState = page => page.evaluate(k => localStorage.getItem(k), KEY);
const notice = page => page.evaluate(() => document.getElementById("notice").hidden ? "" : document.getElementById("noticeText").textContent);

// Rules every saved state must keep, whatever the user did.
function checkStateShape(raw){
  assert.ok(raw, "nothing saved");
  const S = JSON.parse(raw);
  assert.ok(S.batches[S.batchId], "the open list is missing");
  const seen = new Set();
  for(const [id, it] of Object.entries(S.items)){
    assert.equal(it.id, id, "item stored under another id");
    assert.ok(S.batches[it.batchId], `code ${it.code} points to a missing list`);
    assert.ok(it.code && it.code === it.code.trim(), `blank or untrimmed code ${JSON.stringify(it.code)}`);
    const k = it.batchId + "\n" + it.code;
    assert.ok(!seen.has(k), `code ${it.code} twice in one list`);
    seen.add(k);
    assert.ok(Number.isFinite(Date.parse(it.time)));
  }
  for(const [id, b] of Object.entries(S.batches)){ assert.equal(b.id, id); assert.equal(typeof b.name, "string"); }
  const pats = new Set();
  for(const [id, r] of Object.entries(S.rules)){
    assert.equal(r.id, id);
    assert.ok(r.pattern && r.device && r.device === r.device.trim(), "empty rule " + JSON.stringify(r));
    const k = r.type + "\n" + r.pattern.toUpperCase();
    assert.ok(!pats.has(k), "two rules for one pattern " + k);
    pats.add(k);
  }
  return S;
}

// For states written by older versions: only the links between records are checked, their contents are kept as they were.
function checkStateShapeLoose(raw){
  const S = JSON.parse(raw);
  assert.ok(S.batches[S.batchId], "the open list is missing");
  for(const k of ["batches", "items", "rules"]) for(const [id, o] of Object.entries(S[k])) assert.equal(o.id, id);
  for(const it of Object.values(S.items)) assert.ok(S.batches[it.batchId], `code ${it.code} points to a missing list`);
  return S;
}

module.exports = { BASE, checkStateShapeLoose, startServer, launch, openApp, reload, readState, notice, takeSaved, checkStateShape, KEY };
