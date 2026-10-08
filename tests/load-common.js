// Loads the app's common.js and the bundled SheetJS into a Node sandbox, the way index.html does in the browser.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
module.exports = function loadCommon(){
  const g = { console, Blob, Date, Math, crypto: globalThis.crypto, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, setTimeout, clearTimeout };
  g.window = g; g.self = g;
  vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "vendor/xlsx.full.min.js"), "utf8"), g, { filename: "xlsx.full.min.js" });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), g, { filename: "common.js" });
  return { CS: g.CS, XLSX: g.XLSX };
};
