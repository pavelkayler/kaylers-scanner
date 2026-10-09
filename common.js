// Helpers of the phone app that need no page state: device rules, the Excel layouts, file saving.
(function(g){
  "use strict";
  const CS = {};

  CS.uid = () => (g.crypto && g.crypto.randomUUID) ? g.crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);

  // "INV*" -> prefix, "*LT*" -> contains, "/re/" -> regex, anything else -> exact code
  CS.parsePattern = s => {
    s = String(s).trim();
    if(s.length > 2 && s.startsWith("/") && s.endsWith("/")) return { type:"regex", pattern:s.slice(1, -1) };
    if(s.length > 2 && s.startsWith("*") && s.endsWith("*")) return { type:"contains", pattern:s.slice(1, -1) };
    if(s.length > 1 && s.endsWith("*")) return { type:"prefix", pattern:s.slice(0, -1) };
    return { type:"exact", pattern:s };
  };
  CS.showPattern = r => r.type === "regex" ? "/" + r.pattern + "/" : r.type === "contains" ? "*" + r.pattern + "*"
    : r.type === "prefix" ? r.pattern + "*" : r.pattern;

  // Exact code wins, then the longest matching prefix, then "contains" and regex rules.
  CS.matchRule = (rules, code) => {
    const live = rules.filter(r => !r.deleted && r.pattern), C = String(code).toUpperCase(); // an empty pattern would match every code
    const exact = live.find(r => r.type === "exact" && r.pattern.toUpperCase() === C);
    if(exact) return exact;
    const pre = live.filter(r => r.type === "prefix" && C.startsWith(r.pattern.toUpperCase()))
                    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
    if(pre) return pre;
    for(const r of live){
      try{
        if(r.type === "contains" && C.includes(r.pattern.toUpperCase())) return r;
        if(r.type === "regex" && new RegExp(r.pattern, "i").test(code)) return r;
      }catch(e){}
    }
    return null;
  };
  CS.device = (rules, code) => { const r = CS.matchRule(rules, code); return r ? r.device : ""; };
  // The saved state's shape: lists, codes and rules keyed by id with the fields the app relies on.
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  CS.validRecord = (kind, o) => {
    if(!isObj(o) || typeof o.id !== "string" || (o.updatedAt !== undefined && !Number.isFinite(o.updatedAt))) return false;
    return kind === "items" ? typeof o.code === "string" && typeof o.time === "string" :
      kind === "batches" ? typeof o.name === "string" : typeof o.pattern === "string" && typeof o.device === "string";
  };
  // A disk copy written by the iOS app (v31+) always holds the whole state: all three collections, its revision and an
  // open list that exists. Anything less is a damaged copy, never "a newer, emptier inventory".
  CS.completeState = s => CS.validState(s) && ["batches", "items", "rules"].every(k => isObj(s[k])) && Number.isSafeInteger(s.rev) &&
    typeof s.batchId === "string" && Object.prototype.hasOwnProperty.call(s.batches, s.batchId);
  CS.validState = s => isObj(s) && ["batches", "items", "rules"].every(k => s[k] === undefined || isObj(s[k]) && Object.values(s[k]).every(o => CS.validRecord(k, o)));
  // codes typed in by hand were stored as "Вручную" before v23; the stored value stays, it is shown in English (legacy-ru)
  CS.formatLabel = f => f === "Вручную" ? "Manual" : (f || ""); // legacy-ru
  // Lists the Russian versions named automatically (a word + date, the old PC server's bare word, the restore placeholder)
  // get the English default. Only these exact forms: a name the user typed is never changed.
  CS.englishListName = name => {
    const m = /^(?:Партия|Список) (\d{2})\.(\d{2}), (\d{2}:\d{2})$/.exec(name); // legacy-ru
    return m ? "List " + m[1] + "/" + m[2] + ", " + m[3] : name === "Партия" ? "List" : name === "Восстановленный список" ? "Restored list" : name; // legacy-ru
  };

  // dates and times for display; stored times stay ISO, shown in the phone's time zone
  CS.LOCALE = "en-GB";
  const dt = x => x.toLocaleString(CS.LOCALE, { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
  const tm = x => x.toLocaleTimeString(CS.LOCALE, { hour:"2-digit", minute:"2-digit" });
  CS.period = items => {
    if(!items.length) return "";
    const ts = items.map(i => new Date(i.time)).sort((a, b) => a - b), a = ts[0], b = ts[ts.length - 1];
    return dt(a) + " – " + (a.toDateString() === b.toDateString() ? tm(b) : dt(b));
  };

  // One sheet per batch: the batch name, scan period and count on top, then Device | Code | Code type | Time.
  CS.batchSheet = (batch, items, rules) => {
    items = items.slice().sort((a, b) => a.time.localeCompare(b.time));
    const aoa = [
      [batch ? batch.name : ""],
      ["Scan date and time", CS.period(items)],
      ["Total codes", items.length],
      [],
      ["Device", "Code", "Code type", "Time"],
      ...items.map(it => [CS.device(rules, it.code), it.code, CS.formatLabel(it.format), new Date(it.time).toLocaleTimeString(CS.LOCALE)])
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch:30 }, { wch:32 }, { wch:14 }, { wch:10 }];
    return ws;
  };
  CS.workbookBlob = sheets => {
    const wb = XLSX.utils.book_new();
    // Excel's sheet name rules: no []:*?/\, no apostrophe at either end, "History" is reserved, unique ignoring case
    const used = new Set(["history"]);
    for(const [name, ws] of sheets){
      let n = String(name).replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 28).replace(/^[\s']+|[\s']+$/g, "") || "Sheet", k = n, i = 2;
      while(used.has(k.toLowerCase())) k = n.slice(0, 25) + " " + i++;
      used.add(k.toLowerCase()); XLSX.utils.book_append_sheet(wb, ws, k);
    }
    return new Blob([XLSX.write(wb, { bookType:"xlsx", type:"array" })],
      { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  };
  // Device base file: column A code or pattern (as CS.showPattern writes it), column B device name,
  // column C the rule type, so a code that itself ends in "*" or looks like "/…/" comes back as the same rule.
  const TYPE_NAMES = { exact:"whole code", prefix:"starts with", contains:"contains", regex:"regular expression" };
  // files exported before v23 carry the Russian names: still read them
  const OLD_TYPE_NAMES = { exact:"код целиком", prefix:"начало кода", contains:"содержит", regex:"регулярное выражение" }; // legacy-ru
  const TYPES = Object.fromEntries([OLD_TYPE_NAMES, TYPE_NAMES].flatMap(o => Object.entries(o).map(([k, v]) => [v, k])));
  // column A with its type known: drop only the marks CS.showPattern added
  const unwrap = (type, a) => type === "prefix" ? a.replace(/\*$/, "") : type === "contains" ? a.replace(/^\*|\*$/g, "")
    : type === "regex" ? a.replace(/^\/|\/$/g, "") : a;
  CS.rulesBlob = rules => {
    const rows = rules.slice().sort((a, b) => a.device.localeCompare(b.device, "ru")).map(r => [CS.showPattern(r), r.device, TYPE_NAMES[r.type] || ""]);
    const ws = XLSX.utils.aoa_to_sheet([["Code or pattern", "Device", "Rule type"], ...rows]);
    ws["!cols"] = [{ wch:32 }, { wch:32 }, { wch:20 }];
    return CS.workbookBlob([["Device catalog", ws]]);
  };
  // Reads the first sheet of an .xlsx/.xls/.csv; an optional header row is skipped, bad rows are counted.
  // Without column C (older or hand-made files) the type comes from the marks in column A, as CS.parsePattern reads them.
  CS.readRules = buf => {
    const wb = XLSX.read(buf, { type:"array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, raw:false, defval:"" });
    const rules = []; let skipped = 0;
    rows.forEach((row, i) => {
      const a = String(row[0] || "").trim(), b = String(row[1] || "").trim();
      if(!a && !b) return;
      // a header row, not a code that merely contains the word "code" (Russian headers come from files exported before v23)
      if(i === 0 && (/^(код( или шаблон)?|шаблон|code( or pattern)?|pattern)$/i.test(a) || /^(устройство|название|device( name)?|name)$/i.test(b))) return; // legacy-ru
      const type = TYPES[String(row[2] || "").trim().toLowerCase()];
      const r = type ? { type, pattern: unwrap(type, a) } : CS.parsePattern(a);
      if(!r.pattern || !b){ skipped++; return; }
      if(r.type === "regex"){ try{ new RegExp(r.pattern); }catch(_){ skipped++; return; } }
      r.device = b; rules.push(r);
    });
    return { rules, skipped };
  };
  CS.stamp = (d = new Date()) => { const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`; };
  // "Delivery from supplier A_2026-10-07_15-30.xlsx"; characters Windows forbids in file names become "-"
  CS.fileName = (name, d) => {
    const n = String(name || "").replace(/[\\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60);
    return (n || "scan") + "_" + CS.stamp(d) + ".xlsx";
  };

  // Phone: share sheet ("Save to Files") when available, otherwise a normal download.
  // Returns what the platform can tell: "shared" (the share sheet finished; the app cannot see where the file went),
  // "downloaded" (a browser download was started) or "declined" (the share sheet was closed). Other failures throw.
  // Only the file is shared: a title or text makes messengers (Max, Telegram) send the file name as a separate message.
  CS.saveBlob = async (name, blob) => {
    try{
      const file = new File([blob], name, { type: blob.type });
      if(navigator.canShare && navigator.canShare({ files:[file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)){
        await navigator.share({ files:[file] });
        return "shared";
      }
    }catch(e){ if(e && e.name === "AbortError") return "declined"; } // other share errors: try a download instead
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return "downloaded";
  };

  g.CS = CS;
})(window);
