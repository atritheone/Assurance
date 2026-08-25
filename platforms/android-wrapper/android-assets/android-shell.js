const root = document.documentElement;
root.classList.add("assurance-android");

function exitAndroidApp() {
  const bridge = window.AssuranceAndroid;
  if (bridge && typeof bridge.exitApp === "function") {
    bridge.exitApp();
    return;
  }

  window.history.back();
}

try {
  Object.defineProperty(window, "close", {
    configurable: true,
    writable: true,
    value: exitAndroidApp
  });
} catch {
  window.close = exitAndroidApp;
}

const topBar = document.querySelector(".top-bar");
const rightPanel = document.getElementById("rightPanel")?.closest(".right-panel");
const centerContent = document.getElementById("centerContent");
const welcomeOverlay = document.getElementById("welcomeOverlay");
const canvas = document.getElementById("hexMapCanvas");

canvas?.addEventListener("pointerdown", () => {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur();
  }
}, { capture: true });

const backdrop = document.createElement("button");
backdrop.className = "android-nav-backdrop";
backdrop.type = "button";
backdrop.setAttribute("aria-label", "Close navigation");
document.body.append(backdrop);

const navButton = document.createElement("button");
navButton.className = "android-nav-toggle";
navButton.type = "button";
navButton.setAttribute("aria-label", "Open navigation");
navButton.setAttribute("aria-expanded", "false");
navButton.innerHTML = "<span></span><span></span><span></span>";

const androidControls = document.createElement("div");
androidControls.className = "android-top-controls";

const mapButton = document.createElement("button");
mapButton.className = "android-map-toggle";
mapButton.type = "button";
mapButton.setAttribute("aria-label", "Open map");
mapButton.innerHTML = "<span>MAP</span>";
mapButton.addEventListener("click", () => {
  document.querySelector('[data-screen="map"]')?.click();
  setNavigationOpen(false);
});

androidControls.append(mapButton, navButton);
topBar?.append(androidControls);

function setNavigationOpen(open) {
  root.classList.toggle("android-nav-open", open);
  navButton.setAttribute("aria-expanded", String(open));
  navButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
}

navButton.addEventListener("click", () => {
  setNavigationOpen(!root.classList.contains("android-nav-open"));
});

backdrop.addEventListener("click", () => setNavigationOpen(false));

rightPanel?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && (target.closest("[data-screen]") || target.closest("[data-system]"))) {
    window.setTimeout(() => setNavigationOpen(false), 0);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setNavigationOpen(false);
  }
});

function syncAndroidWelcomeText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const replacements = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeValue?.includes("Press [Enter] to continue.")) {
      replacements.push(node);
    }
  }

  for (const node of replacements) {
    node.nodeValue = node.nodeValue.replaceAll("Press [Enter] to continue.", "[Tap] to continue.");
  }
}

function sendEnterKey() {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true
  }));
}

centerContent?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.closest("button, input, select, textarea, a")) {
    return;
  }

  if (target.closest(".welcome-panel")) {
    sendEnterKey();
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.closest(".modal-box.victory, .modal-box.defeat")) {
    event.preventDefault();
    sendEnterKey();
  }
});

function syncAndroidStatusShortcuts() {
  const sections = document.querySelectorAll(".left-panel .section");
  for (const section of sections) {
    const heading = section.querySelector(".section-heading");
    if (!(heading instanceof HTMLElement)) {
      continue;
    }

    const label = heading.textContent?.trim().toLowerCase();
    if (label !== "production" && label !== "research") {
      continue;
    }

    heading.dataset.androidScreen = label;
    heading.setAttribute("role", "button");
    heading.tabIndex = 0;
    heading.setAttribute("aria-label", `Open ${label}`);
  }
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const loadSaveButton = target.closest("[data-android-load-save]");
  if (loadSaveButton instanceof HTMLElement) {
    const saveId = loadSaveButton.dataset.androidLoadSave;
    if (saveId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      loadAndroidSave(saveId);
      return;
    }
  }

  const systemButton = target.closest("[data-system]");
  if (systemButton instanceof HTMLElement && systemButton.dataset.system === "load") {
    if (systemButton.dataset.androidLoadPassthrough === "true") {
      delete systemButton.dataset.androidLoadPassthrough;
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    showAndroidSaveList(systemButton);
    return;
  }

  const volumeToggle = target.closest("[data-volume-toggle]");
  if (volumeToggle) {
    const control = volumeToggle.closest("[data-volume-control]");
    event.preventDefault();
    event.stopImmediatePropagation();
    setAndroidVolumeOpen(control, true);
    return;
  }

  if (target.closest("[data-volume-control]")) {
    return;
  }

  setAndroidVolumeOpen(null, false);
}, true);

function showAndroidSaveList(loadButton) {
  const menuPanel = loadButton.closest(".menu-panel");
  if (!(menuPanel instanceof HTMLElement)) {
    return;
  }

  const existing = menuPanel.querySelector(".android-save-list");
  if (existing) {
    existing.remove();
    return;
  }

  const saves = getAndroidSaveSummaries();
  const list = document.createElement("div");
  list.className = "android-save-list";

  if (!saves.length) {
    list.innerHTML = '<div class="android-save-empty">No saved games.</div>';
  } else {
    list.innerHTML = saves.map((save) => `
      <button class="android-save-option" type="button" data-android-load-save="${escapeAttribute(save.id)}">
        <span>${escapeHtml(save.name)}</span>
        <small>Day ${escapeHtml(String(save.day))}</small>
      </button>
    `).join("");
  }

  menuPanel.append(list);
}

function getAndroidSaveSummaries() {
  const saves = window.assurance?.saves;
  if (!saves?.list) {
    return [];
  }

  const summaries = saves.list();
  return Array.isArray(summaries) ? summaries : [];
}

function loadAndroidSave(saveId) {
  const saves = window.assurance?.saves;
  saves?.__setNextLoadId?.(saveId);
  const loadButton = document.querySelector('[data-system="load"]');
  if (loadButton instanceof HTMLElement) {
    loadButton.dataset.androidLoadPassthrough = "true";
    loadButton.click();
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function setAndroidVolumeOpen(activeControl, open) {
  for (const control of document.querySelectorAll("[data-volume-control]")) {
    control.classList.toggle("android-volume-open", Boolean(open && control === activeControl));
  }
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const heading = target.closest("[data-android-screen]");
  const screen = heading instanceof HTMLElement ? heading.dataset.androidScreen : undefined;
  if (screen === "production" || screen === "research") {
    document.querySelector(`[data-screen="${screen}"]`)?.click();
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const screen = target.dataset.androidScreen;
  if ((screen === "production" || screen === "research") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    document.querySelector(`[data-screen="${screen}"]`)?.click();
  }
});

let pinchLastDistance = 0;

canvas?.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 2) {
    return;
  }

  pinchLastDistance = getTouchDistance(event.touches[0], event.touches[1]);
  event.preventDefault();
}, { passive: false });

canvas?.addEventListener("touchmove", (event) => {
  if (event.touches.length !== 2 || pinchLastDistance <= 0) {
    return;
  }

  const distance = getTouchDistance(event.touches[0], event.touches[1]);
  const delta = pinchLastDistance - distance;
  if (Math.abs(delta) >= 1.5) {
    const center = getTouchCenter(event.touches[0], event.touches[1]);
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaY: delta * 1.8,
      clientX: center.x,
      clientY: center.y,
      bubbles: true,
      cancelable: true
    }));
    pinchLastDistance = distance;
  }

  event.preventDefault();
}, { passive: false });

canvas?.addEventListener("touchend", (event) => {
  if (event.touches.length < 2) {
    pinchLastDistance = 0;
  }
}, { passive: false });

canvas?.addEventListener("touchcancel", () => {
  pinchLastDistance = 0;
}, { passive: false });

function getTouchDistance(first, second) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function getTouchCenter(first, second) {
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2
  };
}

syncAndroidWelcomeText();
syncAndroidStatusShortcuts();

new MutationObserver(() => {
  syncAndroidWelcomeText();
  syncAndroidStatusShortcuts();
}).observe(document.body, {
  childList: true,
  characterData: true,
  subtree: true
});
