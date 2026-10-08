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
    const live = rules.filter(r => !r.deleted), C = String(code).toUpperCase();
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

  const dt = x => x.toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
  const tm = x => x.toLocaleTimeString("ru-RU", { hour:"2-digit", minute:"2-digit" });
  CS.period = items => {
    if(!items.length) return "";
    const ts = items.map(i => new Date(i.time)).sort((a, b) => a - b), a = ts[0], b = ts[ts.length - 1];
    return dt(a) + " – " + (a.toDateString() === b.toDateString() ? tm(b) : dt(b));
  };

  // One sheet per batch: the batch name, scan period and count on top, then Устройство | Код | Тип кода | Время.
  CS.batchSheet = (batch, items, rules) => {
    items = items.slice().sort((a, b) => a.time.localeCompare(b.time));
    const aoa = [
      [batch ? batch.name : ""],
      ["Дата и время сканирования", CS.period(items)],
      ["Всего кодов", items.length],
      [],
      ["Устройство", "Код", "Тип кода", "Время"],
      ...items.map(it => [CS.device(rules, it.code), it.code, it.format || "", new Date(it.time).toLocaleTimeString("ru-RU")])
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch:30 }, { wch:32 }, { wch:14 }, { wch:10 }];
    return ws;
  };
  CS.workbookBlob = sheets => {
    const wb = XLSX.utils.book_new();
    const used = new Set();
    for(const [name, ws] of sheets){
      let n = String(name).replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 28) || "Лист", k = n, i = 2;
      while(used.has(k)) k = n.slice(0, 25) + " " + i++;
      used.add(k); XLSX.utils.book_append_sheet(wb, ws, k);
    }
    return new Blob([XLSX.write(wb, { bookType:"xlsx", type:"array" })],
      { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  };
  // Device base file: column A code or pattern (as CS.showPattern writes it), column B device name.
  CS.rulesBlob = rules => {
    const rows = rules.slice().sort((a, b) => a.device.localeCompare(b.device, "ru")).map(r => [CS.showPattern(r), r.device]);
    const ws = XLSX.utils.aoa_to_sheet([["Код или шаблон", "Устройство"], ...rows]);
    ws["!cols"] = [{ wch:32 }, { wch:32 }];
    return CS.workbookBlob([["Справочник", ws]]);
  };
  // Reads the first sheet of an .xlsx/.xls/.csv; an optional header row is skipped, bad rows are counted.
  CS.readRules = buf => {
    const wb = XLSX.read(buf, { type:"array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, raw:false, defval:"" });
    const rules = []; let skipped = 0;
    rows.forEach((row, i) => {
      const a = String(row[0] || "").trim(), b = String(row[1] || "").trim();
      if(!a && !b) return;
      if(i === 0 && /код|шаблон|code|pattern/i.test(a)) return;
      const r = CS.parsePattern(a);
      if(!r.pattern || !b){ skipped++; return; }
      if(r.type === "regex"){ try{ new RegExp(r.pattern); }catch(_){ skipped++; return; } }
      r.device = b; rules.push(r);
    });
    return { rules, skipped };
  };
  CS.stamp = (d = new Date()) => { const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`; };
  // "Поставка от первого поставщика_2026-10-07_15-30.xlsx"; characters Windows forbids in file names become "-"
  CS.fileName = (name, d) => {
    const n = String(name || "").replace(/[\\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60);
    return (n || "scan") + "_" + CS.stamp(d) + ".xlsx";
  };

  // Phone: share sheet ("Save to Files") when available, otherwise a normal download.
  CS.saveBlob = async (name, blob) => {
    try{
      const file = new File([blob], name, { type: blob.type });
      if(navigator.canShare && navigator.canShare({ files:[file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)){
        await navigator.share({ files:[file], title:name });
        return "saved";
      }
    }catch(e){ if(e && e.name === "AbortError") return "declined"; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return "saved";
  };

  g.CS = CS;
})(window);
