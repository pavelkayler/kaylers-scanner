// Portrait lock for phones. The iOS app is portrait-only (Info.plist), so this never triggers there. Safari and Home Screen
// web apps ignore "orientation" in the manifest, so on a phone in landscape the page turns itself back: the whole page is
// rotated to stay upright relative to the phone, and the camera picture (#reader) is turned back so it still shows the
// world the right way up, like a portrait-locked camera app. Safe-area insets follow the phone's edges (--safe-top/-bottom).
(function(){
  "use strict";
  const css = `
:root{--safe-top:env(safe-area-inset-top,0px);--safe-bottom:env(safe-area-inset-bottom,0px)}
html[data-turn="90"]{--safe-top:env(safe-area-inset-left,0px);--safe-bottom:env(safe-area-inset-right,0px)}
html[data-turn="-90"]{--safe-top:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-left,0px)}
html[data-turn]:not([data-turn=""]){padding:0!important;overflow:hidden}
html[data-turn]:not([data-turn=""]) body{position:fixed;top:0;left:0;width:100vh;height:100vw;max-width:none;margin:0;overflow-y:auto;
  -webkit-overflow-scrolling:touch;transform-origin:0 0;padding-top:calc(var(--safe-top) + 12px);padding-bottom:calc(var(--safe-bottom) + 40px)}
html[data-turn="90"] body{transform:rotate(-90deg) translateX(-100%)}
html[data-turn="-90"] body{transform:rotate(90deg) translateY(-100%)}
html[data-turn]:not([data-turn=""]) body.app-shell{padding:0;overflow:hidden}
html[data-scanner-open],html[data-scanner-open] body{overflow:hidden}
html[data-turn]:not([data-turn=""])[data-scanner-open] body{overflow-y:hidden}
/* !important: html5-qrcode sets inline styles on #reader */
html[data-turn]:not([data-turn=""]) #reader{position:absolute!important;left:50%!important;top:50%!important;width:var(--reader-w,100vw)!important;transform:translate(-50%,-50%) rotate(var(--turn))}
`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
  const root = document.documentElement;
  let scannerOpen = false, savedScroll = 0;
  const pageScroller = () => document.getElementById("appScroll") || (root.dataset.turn ? document.body : document.scrollingElement);
  function pinScanner(){
    // A transformed body contains the fixed scanner: its scroll offset would move the overlay off screen.
    if(scannerOpen && root.dataset.turn){ document.body.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
  }
  window.Portrait = { setScannerOpen(open){
    if(open === scannerOpen) return; // Resume keeps the original page position.
    if(open){
      savedScroll = pageScroller().scrollTop;
      scannerOpen = true; root.setAttribute("data-scanner-open", ""); pinScanner();
    }else{
      scannerOpen = false; root.removeAttribute("data-scanner-open"); pageScroller().scrollTop = savedScroll;
    }
  } };
  function angle(){
    const a = screen.orientation && typeof screen.orientation.angle === "number" ? screen.orientation.angle
      : typeof window.orientation === "number" ? window.orientation : 90;
    return ((a % 360) + 360) % 360 === 270 ? -90 : 90; // 90: the phone is turned counter-clockwise
  }
  function turn(){
    const w = innerWidth, h = innerHeight;
    let coarse = false; try{ coarse = matchMedia("(pointer: coarse)").matches; }catch(e){}
    const t = coarse && w > h && Math.min(w, h) < 600 ? angle() : 0; // phones only; tablets and desktops rotate freely
    root.dataset.turn = t ? String(t) : "";
    root.style.setProperty("--turn", t + "deg");
    pinScanner();
    const view = document.getElementById("scanView");
    if(t && view) root.style.setProperty("--reader-w", view.clientHeight + "px"); // the picture spans the view's long side
  }
  turn();
  addEventListener("resize", turn); addEventListener("orientationchange", turn);
  try{ screen.orientation.addEventListener("change", turn); }catch(e){}
  addEventListener("DOMContentLoaded", () => {
    turn();
    const view = document.getElementById("scanView");
    if(view && typeof ResizeObserver === "function") new ResizeObserver(turn).observe(view);
  });
})();
