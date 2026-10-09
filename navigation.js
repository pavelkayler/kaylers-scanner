// Navigation and viewport layout only. All inventory, export and camera behavior stays in index.html.
(function(){
  "use strict";
  const root = document.documentElement, scroll = document.getElementById("appScroll"), dock = document.getElementById("bottomBar");
  const pages = { scan:"scanPage", lists:"listsMenu", devices:"devices", settings:"settingsMenu" };
  const titles = { scan:"Scanner", lists:"My lists", devices:"Devices", settings:"Settings" };
  const positions = { scan:0, lists:0, devices:0, settings:0 };
  let active = "scan";
  let field = null, keyboardOpen = false, pointerEditing = false, normalHeight = visibleHeight(), typingHeight = normalHeight, focusTimer = null;
  let viewportFrame = 0, keyboardTimer = null, dockHeight = 0;
  function visibleHeight(){
    const view = window.visualViewport;
    return view ? view.height * view.scale : innerHeight;
  }
  function editor(element){
    if(!element || element.disabled || element.readOnly) return null;
    if(element.isContentEditable || element.tagName === "TEXTAREA" || element.tagName === "SELECT") return element;
    return element.tagName === "INPUT" && /^(text|search|email|tel|url|password|number|date|time|datetime-local|month|week)$/.test(element.type) ? element : null;
  }
  function measure(){
    // display:none must not erase the page's reserved space or clamp its scroll position.
    if(dock.hidden) return;
    const height = dock.getBoundingClientRect().height;
    if(height > 0 && height !== dockHeight){ dockHeight = height; root.style.setProperty("--dock-height", height + "px"); }
  }
  function syncDock(){
    const hidden = !!field || keyboardOpen || pointerEditing;
    if(dock.hidden !== hidden) dock.hidden = hidden;
    root.toggleAttribute("data-typing", hidden);
  }
  function keepFieldVisible(){
    if(!field || !field.isConnected || !field.getClientRects().length || root.hasAttribute("data-scanner-open")) return;
    const box = field.getBoundingClientRect(), view = scroll.getBoundingClientRect();
    // Safari pans the visual viewport itself. Only correct an actually clipped field,
    // rather than restarting browser scrolling on every keyboard/toolbar event.
    if(box.top < view.top + 8 || box.bottom > view.bottom - 8 || box.left < view.left || box.right > view.right)
      field.scrollIntoView({ block:"nearest", inline:"nearest", behavior:"instant" });
  }
  function queueViewport(){
    if(!viewportFrame) viewportFrame = requestAnimationFrame(viewport);
  }
  function viewport(){
    viewportFrame = 0;
    const height = visibleHeight();
    const reduced = typingHeight - height > 100;
    if(field && reduced) keyboardOpen = true;
    clearTimeout(keyboardTimer);
    if(keyboardOpen && typingHeight - height <= 80){
      // Wait for the keyboard's last resize frames before restoring the menu.
      // Safari's Done button may leave the input focused after it closes.
      keyboardTimer = setTimeout(() => {
        if(!keyboardOpen || typingHeight - visibleHeight() > 80) return;
        keyboardOpen = false;
        const previous = field; field = null;
        if(previous) previous.blur();
        syncDock(); queueViewport();
      }, 120);
    }
    if(!field && !keyboardOpen) normalHeight = height;
    syncDock();
    const values = { "--app-height":height + "px", "--app-top":(window.visualViewport ? window.visualViewport.offsetTop : 0) + "px" };
    for(const [key, value] of Object.entries(values)) if(root.style.getPropertyValue(key) !== value) root.style.setProperty(key, value);
    keepFieldVisible();
  }
  function focusChanged(){
    const next = editor(document.activeElement);
    if(next && !field && !keyboardOpen) typingHeight = normalHeight;
    field = next;
    syncDock(); queueViewport();
  }
  function finishPointer(){
    if(pointerEditing){ pointerEditing = false; focusChanged(); }
  }
  function show(page, options = {}){
    if(!pages[page] || !document.getElementById("scanner").hidden) return;
    positions[active] = scroll.scrollTop;
    active = page; root.dataset.page = page;
    for(const [key, id] of Object.entries(pages)){
      document.getElementById(id).hidden = key !== page;
      const button = document.getElementById("tab-" + key);
      if(key === page) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    document.getElementById("pageTitle").textContent = titles[page];
    document.getElementById("headerCount").hidden = page !== "scan" && page !== "lists";
    measure();
    scroll.scrollTop = options.top ? 0 : positions[page];
  }
  for(const page of Object.keys(pages)) document.getElementById("tab-" + page).onclick = () => show(page);
  window.Navigation = { show };
  show("scan"); viewport();
  if(typeof ResizeObserver === "function") new ResizeObserver(measure).observe(dock);
  addEventListener("resize", queueViewport);
  if(window.visualViewport){
    window.visualViewport.addEventListener("resize", queueViewport);
    window.visualViewport.addEventListener("scroll", queueViewport);
  }
  // Focusing Save/Cancel blurs the input before click. Keep the layout steady until that tap finishes.
  document.addEventListener("pointerdown", () => { pointerEditing = !!field; }, true);
  document.addEventListener("pointerup", () => { requestAnimationFrame(finishPointer); }, true);
  document.addEventListener("pointercancel", finishPointer, true);
  document.addEventListener("click", finishPointer);
  document.addEventListener("focusin", () => { clearTimeout(focusTimer); focusChanged(); });
  document.addEventListener("focusout", () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(focusChanged, 0); // moving between inputs must not flash the dock
  });
  document.addEventListener("click", event => {
    // Safari does not always blur a text field when a form button or blank area is tapped.
    const previous = field, target = event.target;
    if(!previous || previous.contains(target) || editor(target)) return;
    setTimeout(() => {
      const form = target.closest("form");
      // A button may focus a new editor or trigger required-field validation.
      if(field === previous && (!form || form.checkValidity())){
        previous.blur();
        focusChanged(); // removing an editor need not dispatch focusout in every browser
      }
    }, 0);
  }, true);
  // Safari can ignore the viewport's zoom limits. Block zoom gestures while keeping one-finger scrolling and taps.
  for(const type of ["gesturestart", "gesturechange", "gestureend"])
    document.addEventListener(type, event => event.preventDefault(), { passive:false });
  for(const type of ["touchstart", "touchmove"])
    document.addEventListener(type, event => { if(event.touches.length > 1) event.preventDefault(); }, { passive:false });
  document.addEventListener("dblclick", event => event.preventDefault());
  document.addEventListener("wheel", event => { if(event.ctrlKey || event.metaKey) event.preventDefault(); }, { passive:false });
  document.addEventListener("keydown", event => {
    if((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) event.preventDefault();
  });
})();
