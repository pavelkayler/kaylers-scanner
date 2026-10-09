// What differs between the web app (PWA in Safari / Home Screen) and the iOS app (Capacitor): durable storage,
// handing a file to the user, haptics, the app going to the background and where camera permission lives.
// Everything else is the same code. In the browser every entry is the web behaviour or null.
(function(g){
  "use strict";
  const cap = g.Capacitor;
  const native = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  const P = native ? cap.Plugins || {} : {};
  const Platform = { native, store: null, haptic: null, onBackground: null, cameraDenied: null };

  // Web: share sheet or download (CS.saveBlob, looked up at call time). iOS app: the file is written to the app's
  // cache folder and handed to the share sheet ("Save to Files", AirDrop, Mail...). Outcomes as CS.saveBlob.
  Platform.saveFile = (name, blob) => g.CS.saveBlob(name, blob);

  if(native){
    // ---- durable state (iOS app): the state JSON in two files in Library/, written in turn ----
    // A write only ever replaces the older copy, so a crash or a full disk during a write leaves the newer copy whole.
    // localStorage stays the fast working copy; this is what survives WebKit losing or damaging its storage.
    const FILES = ["kaylers-scanner/state-a.json", "kaylers-scanner/state-b.json"], DIR = "LIBRARY";
    const missing = e => /not exist|no such file|not found|doesn.t exist/i.test(String(e && (e.message || e)));
    // short fingerprint of a damaged file, so the same file is copied aside once
    const tag = s => { let h = 5381; for(let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return s.length + "-" + h.toString(36); };
    // { rev, seq } of a state: seq counts every save (settings and backup records too), rev only content changes
    const orderOf = raw => { try{ const s = JSON.parse(raw); return { rev: Number.isSafeInteger(s.rev) ? s.rev : 0, seq: Number.isSafeInteger(s.seq) ? s.seq : null }; }catch(e){ return { rev: -1, seq: null }; } };
    // Is the disk copy a later save than the WebKit copy? Content first: rev only grows, so a later save never has a lower rev,
    // and the copy with newer content wins whatever its counters. With equal content, seq decides (settings, backup records);
    // when only one copy has seq (migration from before v40) that one is the later save.
    const later = (disk, local) => disk.rev !== local.rev ? disk.rev > local.rev :
      disk.seq !== null && local.seq !== null ? disk.seq > local.seq : disk.seq !== null;
    const revOf = raw => { try{ const s = JSON.parse(raw); return s && typeof s === "object" && !Array.isArray(s) ? (Number.isSafeInteger(s.rev) ? s.rev : 0) : -1; }catch(e){ return -1; } };
    // floor: the newest content revision known on disk; a write with an older one would roll the saved lists back and is refused
    let nextFile = 0, pending = null, pendingRev = 0, writing = null, floor = 0;
    // Each file is { kind, gen, state }: gen counts every disk write, so the last write wins even when it changed only
    // settings or backup records (rev, the content revision, stays the same then). Files from v31–v34 hold the bare state: gen 0.
    const KIND = "kaylers-scanner-state";
    let gen = 0;
    async function writeOne(raw){
      const data = '{"kind":"' + KIND + '","gen":' + (gen + 1) + ',"state":' + raw + '}';
      try{ await P.Filesystem.writeFile({ path: FILES[nextFile], directory: DIR, encoding: "utf8", data, recursive: true }); gen++; nextFile = 1 - nextFile; return true; }
      catch(e){ return false; } // the same file is tried again next time; the other copy stays untouched
    }
    async function drain(){
      let ok = true;
      while(pending !== null){
        const raw = pending, rev = pendingRev; pending = null;
        ok = rev < floor ? false : await writeOne(raw);
        if(ok) floor = Math.max(floor, rev);
      }
      writing = null;
      return ok;
    }
    Platform.store = {
      revOf, orderOf, later,
      // { raw, rev } of the newest valid copy; null only when no copy exists (first install); { damaged: [raw...] } when copies
      // exist but none is a valid state; { error } when a copy cannot be read or a damaged one cannot be kept.
      // A damaged copy is first copied to kaylers-scanner/damaged/, so later writes into its slot lose nothing.
      async load(){
        const found = [], damaged = [];
        for(let i = 0; i < FILES.length; i++){
          let raw;
          try{ raw = (await P.Filesystem.readFile({ path: FILES[i], directory: DIR, encoding: "utf8" })).data; }
          catch(e){ if(missing(e)) continue; return { error: String(e && (e.message || e)) }; }
          let s = null, n = 0; try{ s = JSON.parse(raw); }catch(e){}
          // an envelope must be a whole envelope; a broken one is damaged, not a bare v31–v34 file
          if(s && typeof s === "object" && "kind" in s){ if(s.kind === KIND && Number.isSafeInteger(s.gen) && s.gen > 0){ n = s.gen; s = s.state; } else s = null; }
          if(g.CS.completeState(s)) found.push({ i, raw: n ? JSON.stringify(s) : raw, gen: n, rev: s.rev, seq: Number.isSafeInteger(s.seq) ? s.seq : null });
          else damaged.push({ i, raw });
        }
        for(const d of damaged){
          const path = "kaylers-scanner/damaged/" + FILES[d.i].split("/").pop().replace(".json", "") + "-" + tag(d.raw) + ".json";
          try{ await P.Filesystem.readFile({ path, directory: DIR, encoding: "utf8" }); continue; }catch(e){ if(!missing(e)) return { error: String(e && (e.message || e)) }; }
          try{ await P.Filesystem.writeFile({ path, directory: DIR, encoding: "utf8", data: d.raw, recursive: true }); }
          catch(e){ return { error: "A damaged copy could not be kept: " + String(e && (e.message || e)) }; }
        }
        // newest write first; between two bare v31–v34 files the higher content revision; a full tie keeps file A
        found.sort((a, b) => b.gen - a.gen || b.rev - a.rev || a.i - b.i);
        gen = Math.max(0, ...found.map(f => f.gen));
        if(!found.length){ if(damaged.length){ nextFile = damaged[0].i; return { damaged: damaged.map(d => d.raw) }; } return null; }
        nextFile = found.length === 2 ? found[1].i : 1 - found[0].i; // the next write goes over the older or damaged copy
        floor = Math.max(...found.map(f => f.rev));
        return { raw: found[0].raw, rev: found[0].rev, seq: found[0].seq };
      },
      // queued; resolves true once this state (or a newer one) is on disk, false if that write failed
      // rev: the content revision of raw (S.rev)
      save(raw, rev = revOf(raw)){ pending = raw; pendingRev = rev; if(!writing) writing = drain(); return writing; },
    };

    Platform.saveFile = async (name, blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = ""; for(let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const { uri } = await P.Filesystem.writeFile({ path: "exports/" + name, directory: "CACHE", data: g.btoa(bin), recursive: true });
      try{ await P.Share.share({ files: [uri] }); return "shared"; }
      catch(e){ if(/cancel/i.test(String(e && (e.message || e)))) return "declined"; throw e; }
    };
    Platform.haptic = strong => { try{ P.Haptics.impact({ style: strong ? "MEDIUM" : "LIGHT" }).catch(() => {}); }catch(e){} };
    Platform.onBackground = fn => { try{ P.App.addListener("pause", fn); }catch(e){} };
    Platform.cameraDenied = "Camera access is off for Kayler's Scanner. Allow it in Settings → Apps → Kayler's Scanner → Camera (before iOS 18: Settings → Kayler's Scanner), then tap Scan again.";
  }

  g.Platform = Platform;
})(window);
