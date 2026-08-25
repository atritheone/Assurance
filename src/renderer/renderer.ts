import "./styles.css";

import { UNIT_DEFINITIONS } from "./data/unitDefs";
import { HexCanvas, type HexClick } from "./canvas/hexCanvas";
import { axialToPixel } from "./canvas/hexMath";
import { getHexBorderColors, type CombatVisualEffect, type TurnAttentionRegion } from "./canvas/mapRenderer";
import { Commands } from "./game/commands";
import { createEmptyInventory } from "./game/economy";
import { createGameEngine, setDebugEnemyOwnerLogs } from "./game/engine";
import { getDefaultOwnerForFaction, getOpposingFaction, isUnitAvailableToFaction, isUnitAvailableToOwnerInState } from "./game/factions";
import { appendLog } from "./game/log";
import { getHex, hexId, parseHexId, sameHex } from "./game/map";
import { createDefaultSideStartOptions, createDefaultStartOptionsForPlayerFaction, createInitialState } from "./game/state";
import { canAttackHex, canPlacePlayerUnitAt, canQueueMoveUnitTo, getReachableHexIds, getSelectedUnit } from "./game/units";
import { loadGameFromFile, saveNamedGameAs } from "./save/saveLoad";
import { playSound, playSoundAfterCurrentEffects, playSoundSequence, setSoundMuted, setSoundVolume, type SoundEffectName } from "./sound";
import type { BuildingType, DebugEconomyField, DebugGlobalOption, DebugSideOption, Difficulty, EnemyMovementTrail, Faction, GameCommand, GameState, HexCoord, LogEntry, Owner, PurchaseCurrency, ResearchType, SideStartOptions, StartOptions, UnitInventory, UnitType } from "./game/types";
import { getLayoutElements } from "./ui/layout";
import { renderPanels, type Screen } from "./ui/panels";

declare global {
  interface Window {
    assurance?: {
      appName: string;
      files?: {
        saveTextAs(payload: { defaultFileName: string; content: string }): Promise<unknown>;
      };
    };
  }
}

const elements = getLayoutElements();
let engine = createGameEngine();
let state: GameState = engine.getState();
let currentScreen: Screen = "map";
let showMenuLoadList = false;
let combatEffectId = 1;
let combatEffects: CombatVisualEffect[] = [];
let pendingTurnAttentionRegion: TurnAttentionRegion | null = null;
let blockingOverlay: BlockingOverlay = null;
let hasUnsavedChanges = false;
let allowUnsafeExit = false;
let startMenuMode: "main" | "options" = "main";
let startOptionsOpenedFromGame = false;
let selectedStartPlayerFaction: Faction = "Empire";
let lastResultSoundWinner: Owner | null = null;
let soundVolume = 40;
let soundMuted = false;
let previousNonZeroSoundVolume = soundVolume;
let placementSelectorPinned = false;
let placementSelectorHoverOpen = false;
let placementSelectorHoverSuppressed = false;
let placementSelectorClosing = false;
let selectedPlacementUnit: UnitType | null = null;
let selectedPlacementLevel: number | null = null;
let productionCurrency: PurchaseCurrency = "funds";
let researchCurrency: PurchaseCurrency = "funds";
let fieldUpgradeCurrency: PurchaseCurrency = "funds";
let debugMode = false;
const QUEUE_CANCEL_CONFIRM_MS = 4000;
const UNIT_SELECTOR_CLOSE_DELAY_MS = 650;
const UNIT_SELECTOR_FADE_MS = 180;
const confirmingQueueCancelIds = new Set<string>();
const queueCancelTimers = new Map<string, number>();
const confirmingQueueFinishIds = new Set<string>();
const queueFinishTimers = new Map<string, number>();
const debugChordKeys = new Set<string>();
let unitSelectorCloseTimer: number | null = null;
let unitSelectorFadeTimer: number | null = null;
const isElectronRuntime = Boolean(window.assurance?.appName);

const hexCanvas = new HexCanvas(elements.canvas, handleHexClick);
setDebugEnemyOwnerLogs(debugMode);
syncSoundSettings();
setupStartMenu();
elements.endTurnButton.addEventListener("click", () => {
  clearSelectionForNonMapClick();
  void endTurn();
});
elements.mapUnitSelector.addEventListener("pointerenter", () => {
  cancelPlacementSelectorClose();
  if (placementSelectorHoverSuppressed || !hasAvailablePlacementMaterial()) {
    return;
  }

  cancelPlacementSelectorFade();
  placementSelectorHoverOpen = true;
  updatePlacementSelectorElementState();
});
elements.mapUnitSelector.addEventListener("pointerleave", () => {
  placementSelectorHoverSuppressed = false;
  schedulePlacementSelectorClose();
});
elements.mapUnitSelector.addEventListener("pointermove", (event) => {
  if (!isPointerInsidePlacementSelector(event.clientX, event.clientY)) {
    return;
  }

  cancelPlacementSelectorClose();
  if (!placementSelectorPinned && !placementSelectorHoverOpen && !placementSelectorHoverSuppressed && hasAvailablePlacementMaterial()) {
    cancelPlacementSelectorFade();
    placementSelectorHoverOpen = true;
    updatePlacementSelectorElementState();
  }
});
document.addEventListener("pointermove", (event) => {
  if (isPointerInsidePlacementSelector(event.clientX, event.clientY)) {
    cancelPlacementSelectorClose();
    return;
  }

  if (unitSelectorCloseTimer === null && placementSelectorHoverOpen && !placementSelectorPinned) {
    schedulePlacementSelectorClose();
  }
});

function schedulePlacementSelectorClose(): void {
  cancelPlacementSelectorClose();
  unitSelectorCloseTimer = window.setTimeout(() => {
    unitSelectorCloseTimer = null;
    if (placementSelectorPinned) {
      placementSelectorHoverOpen = false;
      updatePlacementSelectorElementState();
      return;
    }

    fadePlacementSelectorClosed();
    updatePlacementSelectorElementState();
  }, UNIT_SELECTOR_CLOSE_DELAY_MS);
}

function cancelPlacementSelectorClose(): void {
  window.clearTimeout(unitSelectorCloseTimer ?? undefined);
  unitSelectorCloseTimer = null;
}

function updatePlacementSelectorElementState(): void {
  if (!state.started || currentScreen !== "map") {
    return;
  }

  const hasAvailableMaterial = hasAvailablePlacementMaterial();
  elements.mapUnitSelector.classList.toggle("available", hasAvailableMaterial);
  elements.mapUnitSelector.classList.toggle("pinned", placementSelectorPinned);
  elements.mapUnitSelector.classList.toggle("hover-open", placementSelectorHoverOpen);
  elements.mapUnitSelector.classList.toggle("suppress-hover", placementSelectorHoverSuppressed);
  elements.mapUnitSelector.classList.toggle("closing", placementSelectorClosing);
  elements.mapUnitSelector.classList.toggle("has-selection", selectedPlacementUnit !== null);
  const toggle = elements.mapUnitSelector.querySelector<HTMLButtonElement>("[data-unit-selector-toggle]");
  if (toggle) {
    toggle.disabled = !hasAvailableMaterial;
    toggle.setAttribute("aria-label", placementSelectorPinned ? "Close material selector" : "Open material selector");
  }
}

type BlockingOverlay = { type: "loading" } | { type: "result"; winner: Owner } | { type: "exitPrompt" } | null;

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const modalAction = target.dataset.modalAction;
  if (blockingOverlay?.type === "exitPrompt" && modalAction) {
    await handleExitPromptAction(modalAction);
    return;
  }

  if (blockingOverlay) {
    event.preventDefault();
    return;
  }

  if (target.closest("[data-download-log]")) {
    await downloadLogToTextFile();
    return;
  }

  if (target.closest("[data-debug-panel]")) {
    handleDebugPanelClick(target);
    return;
  }

  const closedRepeatedPlacement = isRepeatedPlacementMode() && !elements.canvas.contains(target) && !target.closest(".map-unit-selector")
    ? closePlacementSelector()
    : false;

  if (target.closest("[data-volume-toggle]")) {
    toggleSoundMuted();
    return;
  }

  const clickedMapControl =
    elements.canvas.contains(target) ||
    Boolean(target.closest("[data-attack-at], [data-select-unit], [data-cancel-movement], [data-upgrade-unit], [data-field-upgrade-currency], [data-unit-selector-toggle], [data-placement-unit]"));
  const clearedSelection = clickedMapControl ? false : clearSelectionForNonMapClick();

  const startTarget = target.closest<HTMLElement>("[data-start]");
  const startAction = startTarget?.dataset.start;
  if (startAction === "new") {
    showStartOptions(false);
    return;
  }
  if (startAction === "begin") {
    startNewGame();
    return;
  }
  if (startAction === "back") {
    if (startOptionsOpenedFromGame && state.started) {
      startOptionsOpenedFromGame = false;
      closeOverlay();
      return;
    }

    showStartMain();
    return;
  }
  if (startAction === "load") {
    await loadGame();
    return;
  }
  if (startAction === "exit") {
    promptExitGame();
    return;
  }

  const teamTarget = target.closest<HTMLElement>("[data-start-team]");
  const team = parseFaction(teamTarget?.dataset.startTeam);
  if (team) {
    selectedStartPlayerFaction = team;
    syncStartTeamButtons();
    syncStartPanels();
    return;
  }

  const screen = target.dataset.screen as Screen | undefined;
  if (screen) {
    if (currentScreen === "welcome") {
      await leaveWelcomeScreen(screen);
      return;
    }

    currentScreen = screen;
    showMenuLoadList = false;
    render();
    return;
  }

  const productionCurrencyTarget = target.closest<HTMLElement>("[data-production-currency]");
  const selectedProductionCurrency = productionCurrencyTarget?.dataset.productionCurrency as PurchaseCurrency | undefined;
  if (selectedProductionCurrency === "funds" || selectedProductionCurrency === "gain") {
    productionCurrency = selectedProductionCurrency;
    render();
    return;
  }

  const researchCurrencyTarget = target.closest<HTMLElement>("[data-research-currency]");
  const selectedResearchCurrency = researchCurrencyTarget?.dataset.researchCurrency as PurchaseCurrency | undefined;
  if (selectedResearchCurrency === "funds" || selectedResearchCurrency === "gain") {
    researchCurrency = selectedResearchCurrency;
    render();
    return;
  }

  const fieldUpgradeCurrencyTarget = target.closest<HTMLElement>("[data-field-upgrade-currency]");
  const selectedFieldUpgradeCurrency = fieldUpgradeCurrencyTarget?.dataset.fieldUpgradeCurrency as PurchaseCurrency | undefined;
  if (selectedFieldUpgradeCurrency === "funds" || selectedFieldUpgradeCurrency === "gain") {
    fieldUpgradeCurrency = selectedFieldUpgradeCurrency;
    render();
    return;
  }

  const cancelProductionTarget = target.closest<HTMLElement>("[data-cancel-production]");
  const productionJobToCancel = cancelProductionTarget?.dataset.cancelProduction;
  if (productionJobToCancel) {
    handleQueueCancelClick("production", productionJobToCancel);
    return;
  }

  const finishProductionTarget = target.closest<HTMLElement>("[data-finish-production]");
  const productionJobToFinish = finishProductionTarget?.dataset.finishProduction;
  if (productionJobToFinish) {
    handleQueueFinishClick("production", productionJobToFinish);
    return;
  }

  const cancelResearchTarget = target.closest<HTMLElement>("[data-cancel-research]");
  const researchJobToCancel = cancelResearchTarget?.dataset.cancelResearch;
  if (researchJobToCancel) {
    handleQueueCancelClick("research", researchJobToCancel);
    return;
  }

  const finishResearchTarget = target.closest<HTMLElement>("[data-finish-research]");
  const researchJobToFinish = finishResearchTarget?.dataset.finishResearch;
  if (researchJobToFinish) {
    handleQueueFinishClick("research", researchJobToFinish);
    return;
  }

  if (target.closest("[data-unit-selector-toggle]")) {
    cancelPlacementSelectorClose();
    if (!hasAvailablePlacementMaterial()) {
      closePlacementSelector();
      render();
      return;
    }

    if (placementSelectorPinned) {
      fadePlacementSelectorClosed();
      placementSelectorHoverSuppressed = true;
      selectedPlacementUnit = null;
      selectedPlacementLevel = null;
    } else {
      cancelPlacementSelectorFade();
      placementSelectorPinned = true;
      placementSelectorHoverOpen = true;
      placementSelectorHoverSuppressed = false;
    }
    render();
    return;
  }

  const placementUnitTarget = target.closest<HTMLElement>("[data-placement-unit]");
  const placementUnit = placementUnitTarget?.dataset.placementUnit as UnitType | undefined;
  const placementLevel = placementUnitTarget?.dataset.placementLevel ? Number(placementUnitTarget.dataset.placementLevel) : undefined;
  if (placementUnit && isPlacementUnitAvailable(placementUnit, placementLevel)) {
    cancelPlacementSelectorClose();
    if (isSelectedPlacementMaterial(placementUnit, placementLevel)) {
      selectedPlacementUnit = null;
      selectedPlacementLevel = null;
      render();
      return;
    }

    selectedPlacementUnit = placementUnit;
    selectedPlacementLevel = placementLevel ?? getHighestAvailablePlacementLevel(placementUnit);
    clearSelectionForNonMapClick();
    render();
    return;
  }

  const cancelMovementTarget = target.closest<HTMLElement>("[data-cancel-movement]");
  const unitMovementToCancel = cancelMovementTarget?.dataset.cancelMovement;
  if (unitMovementToCancel) {
    dispatch(Commands.cancelQueuedMovement(unitMovementToCancel));
    return;
  }

  const upgradeUnitTarget = target.closest<HTMLElement>("[data-upgrade-unit]");
  const unitToUpgrade = upgradeUnitTarget?.dataset.upgradeUnit;
  if (unitToUpgrade) {
    const selectedCurrency = upgradeUnitTarget?.dataset.upgradeCurrency as PurchaseCurrency | undefined;
    dispatch(Commands.upgradeFieldUnit(unitToUpgrade, selectedCurrency === "gain" ? "gain" : "funds"));
    return;
  }

  const attackTarget = target.closest<HTMLElement>("[data-attack-at]");
  const attackAt = attackTarget?.dataset.attackAt;
  const selectedUnit = getSelectedUnit(state);
  if (attackAt && selectedUnit?.owner === "Player") {
    dispatch(Commands.attackHex(selectedUnit.id, parseHexId(attackAt)));
    return;
  }

  const instantProduceTarget = target.closest<HTMLElement>("[data-instant-produce]");
  const unitToInstantProduce = instantProduceTarget?.dataset.instantProduce as UnitType | undefined;
  if (unitToInstantProduce) {
    dispatch(Commands.instantProduction(unitToInstantProduce));
    return;
  }

  const produceTarget = target.closest<HTMLElement>("[data-produce]");
  const unitToProduce = produceTarget?.dataset.produce as UnitType | undefined;
  if (unitToProduce) {
    dispatch(Commands.startProduction(unitToProduce));
    return;
  }

  const selectUnitTarget = target.closest<HTMLElement>("[data-select-unit]");
  const unitToSelect = selectUnitTarget?.dataset.selectUnit;
  if (unitToSelect) {
    dispatch(Commands.selectUnit(unitToSelect));
    return;
  }

  const instantResearchTarget = target.closest<HTMLElement>("[data-instant-research]");
  const instantResearchType = instantResearchTarget?.dataset.instantResearch as ResearchType | undefined;
  if (instantResearchType) {
    const unitType = instantResearchTarget?.dataset.unit as UnitType | undefined;
    dispatch(Commands.instantResearch(instantResearchType, unitType));
    return;
  }

  const researchTarget = target.closest<HTMLElement>("[data-research]");
  const researchType = researchTarget?.dataset.research as ResearchType | undefined;
  if (researchType) {
    const unitType = researchTarget?.dataset.unit as UnitType | undefined;
    dispatch(Commands.startResearch(researchType, unitType));
    return;
  }

  const systemAction = target.dataset.system;
  if (systemAction === "resume") {
    currentScreen = "map";
    showMenuLoadList = false;
    render();
    return;
  }

  if (systemAction === "new") {
    showStartOptions(true);
    return;
  }

  if (systemAction === "save") {
    await saveGame();
    return;
  }

  if (systemAction === "load") {
    await loadGame();
    return;
  }

  if (systemAction === "exit") {
    promptExitGame();
    return;
  }

  if (clearedSelection || closedRepeatedPlacement) {
    render();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-volume-slider]")) {
    return;
  }

  setSoundVolumePercent(Number(target.value));
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
    return;
  }

  if (target.closest("[data-debug-panel]")) {
    handleDebugPanelChange(target);
  }
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  const key = event.key.toLowerCase();

  if (handleDebugShortcutKeyDown(event, key)) {
    return;
  }

  if (blockingOverlay?.type === "loading") {
    event.preventDefault();
    return;
  }

  if (blockingOverlay?.type === "result") {
    if (event.key === "Enter") {
      event.preventDefault();
      returnToStartMenu();
    }
    event.preventDefault();
    return;
  }

  if (event.key === "Escape") {
    if (blockingOverlay?.type === "exitPrompt") {
      event.preventDefault();
      blockingOverlay = null;
      render();
      return;
    }

    if (state.started) {
      event.preventDefault();
      if (currentScreen === "welcome") {
        void leaveWelcomeScreen("menu");
        return;
      }

      closeOverlay();
      currentScreen = "menu";
      showMenuLoadList = false;
      render();
      return;
    }

    closeOverlay();
    return;
  }

  if (typing) {
    return;
  }

  if (event.key === "Enter" && state.started && currentScreen === "welcome") {
    event.preventDefault();
    void leaveWelcomeScreen("map");
    return;
  }

  if (key === "a") {
    event.preventDefault();
    void endTurn();
    return;
  }

  if (key === "p") {
    event.preventDefault();
    dispatch(Commands.togglePause());
  }
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (key === "d" || key === "e") {
    debugChordKeys.delete(key);
  }
  if (key === "control" || key === "shift" || !event.ctrlKey || !event.shiftKey) {
    debugChordKeys.clear();
  }
});

window.addEventListener("blur", () => {
  debugChordKeys.clear();
});

window.addEventListener("beforeunload", (event) => {
  if (isElectronRuntime || allowUnsafeExit || !state.started || state.winner || !hasUnsavedChanges) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
});

render();

if ("fonts" in document) {
  void document.fonts.ready.then(() => {
    render();
  });
}

function handleDebugShortcutKeyDown(event: KeyboardEvent, key: string): boolean {
  if (!(event.ctrlKey && event.shiftKey) || (key !== "d" && key !== "e")) {
    return false;
  }

  event.preventDefault();
  debugChordKeys.add(key);
  if (debugChordKeys.has("d") && debugChordKeys.has("e") && !event.repeat) {
    toggleDebugMode();
    debugChordKeys.clear();
  }
  return true;
}

function toggleDebugMode(): void {
  debugMode = !debugMode;
  setDebugEnemyOwnerLogs(debugMode);
  hexCanvas.setDebugMode(debugMode);
  render();
}

function handleDebugPanelClick(target: HTMLElement): void {
  const fundsButton = target.closest<HTMLElement>("[data-debug-add-funds]");
  if (fundsButton) {
    const owner = parseOwner(fundsButton.dataset.debugAddFundsOwner);
    const amount = Number(fundsButton.dataset.debugAddFunds);
    if (owner && Number.isFinite(amount)) {
      dispatch(Commands.debugAdjustFunds(owner, amount));
    }
    return;
  }

  const autoProduceButton = target.closest<HTMLElement>("[data-debug-auto-produce-owner]");
  const owner = parseOwner(autoProduceButton?.dataset.debugAutoProduceOwner);
  if (!owner) {
    return;
  }

  const unitSelect = document.querySelector<HTMLSelectElement>(`[data-debug-auto-unit-owner="${owner}"]`);
  const levelSelect = document.querySelector<HTMLSelectElement>(`[data-debug-auto-level-owner="${owner}"]`);
  const countInput = document.querySelector<HTMLInputElement>(`[data-debug-auto-count-owner="${owner}"]`);
  const unitType = parseUnitType(unitSelect?.value);
  if (!unitType) {
    return;
  }

  dispatch(Commands.debugAddUnitMaterial(owner, unitType, Number(levelSelect?.value), Number(countInput?.value)));
}

function handleDebugPanelChange(target: HTMLInputElement | HTMLSelectElement): void {
  if (target instanceof HTMLInputElement && target.dataset.debugGlobalOption) {
    const option = parseDebugGlobalOption(target.dataset.debugGlobalOption);
    if (option) {
      dispatch(Commands.setDebugGlobalOption(option, target.checked));
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.debugSideOption) {
    const owner = parseOwner(target.dataset.debugSideOwner);
    const option = parseDebugSideOption(target.dataset.debugSideOption);
    if (owner && option) {
      dispatch(Commands.setDebugSideOption(owner, option, target.checked));
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.debugEconomyField) {
    const owner = parseOwner(target.dataset.debugEconomyOwner);
    const field = parseDebugEconomyField(target.dataset.debugEconomyField);
    if (owner && field) {
      dispatch(Commands.debugSetEconomyField(owner, field, Number(target.value)));
    }
    return;
  }

  if (target instanceof HTMLSelectElement && target.dataset.debugUnitLevel) {
    const owner = parseOwner(target.dataset.debugUnitLevelOwner);
    const unitType = parseUnitType(target.dataset.debugUnitLevel);
    if (owner && unitType) {
      dispatch(Commands.debugSetUnitLevel(owner, unitType, Number(target.value)));
    }
  }
}

function parseOwner(value: string | undefined): Owner | null {
  return value === "Player" || value === "Enemy" ? value : null;
}

function parseFaction(value: string | undefined): Faction | null {
  return value === "Empire" || value === "Alliance" ? value : null;
}

function parseUnitType(value: string | undefined): UnitType | null {
  return UNIT_DEFINITIONS.some((unit) => unit.type === value) ? value as UnitType : null;
}

function parseDebugGlobalOption(value: string | undefined): DebugGlobalOption | null {
  return value === "showAiUnits" || value === "noFogOfWar" ? value : null;
}

function parseDebugSideOption(value: string | undefined): DebugSideOption | null {
  return value === "noDamage" || value === "unlimitedMovement" || value === "unlimitedAttackRange" ? value : null;
}

function parseDebugEconomyField(value: string | undefined): DebugEconomyField | null {
  if (
    value === "moneyPoundsBn" ||
    value === "gainPoints" ||
    value === "incomePoundsBn" ||
    value === "efficiencyLevel" ||
    value === "productionCapacityLevel" ||
    value === "productionSpeedLevel" ||
    value === "researchCapacityLevel" ||
    value === "researchSpeedLevel"
  ) {
    return value;
  }

  return null;
}

function startNewGame(): void {
  clearQueueCancelConfirmations();
  const startOptions = readStartOptions();
  engine = createGameEngine(createInitialState(createNewGameSeed(), startOptions));
  state = engine.getState();
  combatEffects = [];
  blockingOverlay = null;
  lastResultSoundWinner = null;
  showMenuLoadList = false;
  startMenuMode = "main";
  startOptionsOpenedFromGame = false;
  dispatch(Commands.startSimulation());
  hasUnsavedChanges = true;
  currentScreen = "welcome";
  closeOverlay();
  render();
}

function createNewGameSeed(): string {
  const randomValues = new Uint32Array(2);
  crypto.getRandomValues(randomValues);
  return `assurance-${Date.now().toString(36)}-${randomValues[0].toString(36)}-${randomValues[1].toString(36)}`;
}

function showStartOptions(openedFromGame: boolean): void {
  startMenuMode = "options";
  startOptionsOpenedFromGame = openedFromGame;
  selectedStartPlayerFaction = "Empire";
  showMenuLoadList = false;
  elements.welcomeOverlay.classList.remove("hidden");
  syncStartPanels();
  renderStartMenuMode();
}

function showStartMain(): void {
  startMenuMode = "main";
  startOptionsOpenedFromGame = false;
  syncStartPanels();
  renderStartMenuMode();
}

function setupStartMenu(): void {
  fillStartDefaults();
  renderStartUnitInputs("Player");
  renderStartUnitInputs("Enemy");
  syncStartTeamButtons();
  syncStartPanels();

  getStartInput("useDefaultStart").addEventListener("change", syncStartPanels);
  getStartInput("enemyStartsSame").addEventListener("change", syncStartPanels);
  for (const id of ["playerUnlockSpecialServices", "playerUnlockRoom", "enemyUnlockSpecialServices", "enemyUnlockDroneFactory"]) {
    getStartInput(id).addEventListener("change", () => {
      renderStartUnitInputs("Player");
      renderStartUnitInputs("Enemy");
    });
  }
  renderStartMenuMode();
}

function fillStartDefaults(): void {
  const defaults = createDefaultStartOptionsForPlayerFaction("Empire");
  setSideStartDefaults("Player", defaults.Player);
  setSideStartDefaults("Enemy", defaults.Enemy);
}

function setSideStartDefaults(owner: Owner, options: SideStartOptions): void {
  const prefix = owner === "Player" ? "player" : "enemy";
  getStartInput(`${prefix}StartFunds`).value = String(options.moneyPoundsBn);
  getStartInput(`${prefix}StartIncome`).value = String(options.incomePoundsBn);
  getStartInput(`${prefix}StartEfficiency`).value = String(options.efficiencyLevel);
  getStartInput(`${prefix}StartProductionCapacity`).value = String(options.productionCapacityLevel);
  getStartInput(`${prefix}StartProductionSpeed`).value = String(options.productionSpeedLevel);
  getStartInput(`${prefix}StartResearchCapacity`).value = String(options.researchCapacityLevel);
  getStartInput(`${prefix}StartResearchSpeed`).value = String(options.researchSpeedLevel);
}

function syncStartPanels(): void {
  const useDefault = getStartInput("useDefaultStart").checked;
  const enemySame = getStartInput("enemyStartsSame").checked;
  getStartElement("startOptions").classList.toggle("hidden", startMenuMode !== "options");
  getStartElement("customStartPanel").classList.toggle("hidden", useDefault);
  getStartElement("enemyStartPanel").classList.toggle("hidden", useDefault || enemySame);
  renderStartUnitInputs("Player");
  renderStartUnitInputs("Enemy");
}

function renderStartMenuMode(): void {
  getStartElement("startOptions").classList.toggle("hidden", startMenuMode !== "options");
  getStartElement("welcomeMainActions").classList.toggle("hidden", startMenuMode !== "main");
  getStartElement("welcomeOptionActions").classList.toggle("hidden", startMenuMode !== "options");
  syncStartTeamButtons();
}

function syncStartTeamButtons(): void {
  for (const faction of ["Empire", "Alliance"] as const) {
    const button = getStartElement(faction === "Empire" ? "startTeamEmpire" : "startTeamAlliance");
    const active = selectedStartPlayerFaction === faction;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderStartUnitInputs(owner: Owner): void {
  const prefix = owner === "Player" ? "player" : "enemy";
  const container = getStartElement(`${prefix}StartUnits`);
  const defaults = createDefaultSideStartOptions(owner).inventory;
  const unlockedBuildings = getSelectedStartBuildings(owner);
  container.innerHTML = UNIT_DEFINITIONS.filter((unit) => isUnitConfigurableForStart(owner, unit.type, unlockedBuildings))
    .map((unit) => {
      const value = getExistingUnitInputValue(owner, unit.type, defaults[unit.type]);
      return `
        <label class="start-unit-field">
          <span>${unit.type}</span>
          <input class="start-input" type="number" min="0" step="1" value="${value}" data-start-unit-owner="${owner}" data-start-unit="${unit.type}" />
        </label>
      `;
    })
    .join("");
}

function readStartOptions(): StartOptions {
  const difficulty = getStartSelect("startDifficulty").value as Difficulty;
  if (getStartInput("useDefaultStart").checked) {
    return {
      ...createDefaultStartOptionsForPlayerFaction(selectedStartPlayerFaction),
      difficulty
    };
  }

  const opponentFaction = getOpposingFaction(selectedStartPlayerFaction);
  const player = readFactionStartOptions(selectedStartPlayerFaction);
  const enemy = getStartInput("enemyStartsSame").checked ? createDefaultSideStartOptions(getDefaultOwnerForFaction(opponentFaction)) : readFactionStartOptions(opponentFaction);
  return {
    difficulty,
    playerFaction: selectedStartPlayerFaction,
    Player: player,
    Enemy: enemy
  };
}

function readFactionStartOptions(faction: Faction): SideStartOptions {
  return readSideStartOptions(getDefaultOwnerForFaction(faction));
}

function readSideStartOptions(owner: Owner): SideStartOptions {
  const prefix = owner === "Player" ? "player" : "enemy";
  const unlockedBuildings = getSelectedStartBuildings(owner);
  return {
    moneyPoundsBn: readStartNumber(`${prefix}StartFunds`, 0),
    incomePoundsBn: readStartNumber(`${prefix}StartIncome`, 0),
    efficiencyLevel: readStartNumber(`${prefix}StartEfficiency`, 1),
    productionCapacityLevel: readStartNumber(`${prefix}StartProductionCapacity`, 1),
    productionSpeedLevel: readStartNumber(`${prefix}StartProductionSpeed`, 1),
    researchCapacityLevel: readStartNumber(`${prefix}StartResearchCapacity`, 1),
    researchSpeedLevel: readStartNumber(`${prefix}StartResearchSpeed`, 1),
    inventory: readStartInventory(owner, unlockedBuildings),
    unlockedBuildings
  };
}

function readStartInventory(owner: Owner, unlockedBuildings: BuildingType[]): UnitInventory {
  const inventory = createEmptyInventory();
  for (const unit of UNIT_DEFINITIONS) {
    if (!isUnitConfigurableForStart(owner, unit.type, unlockedBuildings)) {
      inventory[unit.type] = 0;
      continue;
    }

    const selector = `[data-start-unit-owner="${owner}"][data-start-unit="${unit.type}"]`;
    const input = document.querySelector<HTMLInputElement>(selector);
    inventory[unit.type] = clampInteger(Number(input?.value), 0);
  }
  return inventory;
}

function getSelectedStartBuildings(owner: Owner): BuildingType[] {
  if (owner === "Player") {
    return [
      getStartInput("playerUnlockSpecialServices").checked ? "Special Services" : null,
      getStartInput("playerUnlockRoom").checked ? "The Room" : null
    ].filter((building): building is BuildingType => Boolean(building));
  }

  return [
    getStartInput("enemyUnlockSpecialServices").checked ? "Special Services" : null,
    getStartInput("enemyUnlockDroneFactory").checked ? "Drone Factory" : null
  ].filter((building): building is BuildingType => Boolean(building));
}

function isUnitConfigurableForStart(owner: Owner, unitType: UnitType, unlockedBuildings: BuildingType[]): boolean {
  const unit = UNIT_DEFINITIONS.find((candidate) => candidate.type === unitType);
  if (!unit || !isUnitAvailableToStartOwner(owner, unitType)) {
    return false;
  }

  return unit.producedBy.some((building) => isBaseStartBuilding(building) || unlockedBuildings.includes(building));
}

function isUnitAvailableToStartOwner(owner: Owner, unitType: UnitType): boolean {
  return isUnitAvailableToFaction(unitType, owner === "Player" ? "Empire" : "Alliance");
}

function isBaseStartBuilding(buildingType: BuildingType): boolean {
  return buildingType === "Barracks" || buildingType === "Tank Factory" || buildingType === "Airfield";
}

function getExistingUnitInputValue(owner: Owner, unitType: UnitType, fallback: number): number {
  const input = document.querySelector<HTMLInputElement>(`[data-start-unit-owner="${owner}"][data-start-unit="${unitType}"]`);
  return clampInteger(Number(input?.value ?? fallback), 0);
}

function readStartNumber(id: string, minimum: number): number {
  return clampInteger(Number(getStartInput(id).value), minimum);
}

function clampInteger(value: number, minimum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.floor(value));
}

function getStartElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing start menu element: ${id}`);
  }
  return element;
}

function getStartInput(id: string): HTMLInputElement {
  const element = getStartElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing start menu input: ${id}`);
  }
  return element;
}

function getStartSelect(id: string): HTMLSelectElement {
  const element = getStartElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Missing start menu select: ${id}`);
  }
  return element;
}

async function saveGame(): Promise<boolean> {
  if (!state.started) {
    return false;
  }

  const save = await saveNamedGameAs(state);
  if (!save) {
    render();
    return false;
  }

  appendLog(state, `Game saved - ${save.name}.`);
  engine = createGameEngine(state);
  hasUnsavedChanges = false;
  currentScreen = "menu";
  showMenuLoadList = false;
  render();
  return true;
}

async function loadGame(): Promise<void> {
  const loaded = await loadGameFromFile();
  if (!loaded) {
    render();
    return;
  }

  clearQueueCancelConfirmations();
  engine = createGameEngine(loaded);
  state = engine.getState();
  combatEffects = [];
  blockingOverlay = null;
  lastResultSoundWinner = null;
  hasUnsavedChanges = false;
  currentScreen = "map";
  showMenuLoadList = false;
  closeOverlay();
  render();
}

function promptExitGame(): void {
  if (!state.started || state.winner || !hasUnsavedChanges) {
    exitGame();
    return;
  }

  blockingOverlay = { type: "exitPrompt" };
  render();
}

async function handleExitPromptAction(action: string): Promise<void> {
  if (action === "cancel") {
    blockingOverlay = null;
    render();
    return;
  }

  if (action === "discard") {
    exitGame();
    return;
  }

  if (action === "save-exit") {
    const saved = await saveGame();
    if (saved) {
      exitGame();
      return;
    }

    blockingOverlay = { type: "exitPrompt" };
    render();
  }
}

function exitGame(): void {
  allowUnsafeExit = true;
  window.close();
}

async function downloadLogToTextFile(): Promise<void> {
  const content = formatLogDownloadText(state);
  const defaultFileName = `assurance-log-day-${state.day}-${formatDownloadTimestamp(new Date())}.txt`;
  const bridge = window.assurance?.files;
  if (bridge?.saveTextAs) {
    await bridge.saveTextAs({ defaultFileName, content });
    return;
  }

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultFileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatLogDownloadText(targetState: GameState): string {
  const entries = targetState.log.length
    ? targetState.log
    : [{
        id: 0,
        day: targetState.day,
        text: "Awaiting start."
      }];

  return entries.map((entry) => `Day ${entry.day}\t${entry.text}`).join("\n") + "\n";
}

function formatDownloadTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function dispatch(command: GameCommand): void {
  const previousState = state;
  const enemyTrailBaseBorderColors = state.started ? getHexBorderColors(state) : {};
  const result = engine.dispatch(command);
  state = result.state;
  pruneQueueCancelConfirmations();
  hasUnsavedChanges = true;
  addCombatEffects(result.logEntries);
  playSoundsForResult(result.logEntries, previousState, state);
  addEnemyMovementTrailEffects(result.enemyMovementTrails, enemyTrailBaseBorderColors);
  if (state.started) {
    closeOverlay();
  }
  render();
}

function clearSelectionForNonMapClick(): boolean {
  if (!state.started || (!state.selection.selectedHexId && !state.selection.selectedUnitId)) {
    return false;
  }

  const result = engine.dispatch(Commands.deselect());
  state = result.state;
  pruneQueueCancelConfirmations();
  hasUnsavedChanges = true;
  return true;
}

async function endTurn(): Promise<void> {
  if (blockingOverlay || !state.started || state.winner || currentScreen === "welcome") {
    return;
  }

  clearQueueCancelConfirmations();
  blockingOverlay = { type: "loading" };
  render();
  await waitForPaint();

  const startedAt = performance.now();
  const previousState = state;
  const enemyTrailBaseBorderColors = getHexBorderColors(state);
  const result = engine.dispatch(Commands.endTurn());
  state = result.state;
  addCombatEffects(result.logEntries);
  playSoundsForResult(result.logEntries, previousState, state);
  addEnemyMovementTrailEffects(result.enemyMovementTrails, enemyTrailBaseBorderColors);
  pendingTurnAttentionRegion = getPlayerTurnStartAttentionRegion(previousState, state, result.logEntries, result.enemyMovementTrails);

  const remaining = Math.max(0, 180 - (performance.now() - startedAt));
  if (remaining > 0) {
    await delay(remaining);
  }

  blockingOverlay = state.winner ? { type: "result", winner: state.winner } : null;
  render();
}

function handleHexClick(click: HexClick | null): void {
  if (!state.started || blockingOverlay) {
    return;
  }

  currentScreen = "map";
  if (!click) {
    closePlacementSelector();
    dispatch(Commands.deselect());
    return;
  }

  const coord = click.coord;
  const targetHex = getHex(state.map, coord);
  const selectedUnit = getSelectedUnit(state);

  if (targetHex && selectedPlacementUnit) {
    if (canPlacePlayerUnitAt(state, selectedPlacementUnit, coord)) {
      const unitToPlace = selectedPlacementUnit;
      const unitLevelToPlace = selectedPlacementLevel ?? undefined;
      if (!placementSelectorPinned) {
        selectedPlacementUnit = null;
        selectedPlacementLevel = null;
      }
      dispatch(Commands.placeUnit(unitToPlace, coord, unitLevelToPlace));
      return;
    }

    closePlacementSelector();
    dispatch(Commands.selectHex(coord));
    return;
  }

  if (targetHex && selectedUnit?.owner === "Player") {
    const reachable = getReachableHexIds(state, selectedUnit);
    const canMove = reachable.has(targetHex.id) && !sameHex(selectedUnit.coord, coord);
    const canAttack = canAttackHex(state, selectedUnit, coord);
    if (canMove && canAttack) {
      dispatch(click.side === "left" ? Commands.moveUnit(selectedUnit.id, coord) : Commands.attackHex(selectedUnit.id, coord));
      return;
    }

    if (canMove) {
      dispatch(Commands.moveUnit(selectedUnit.id, coord));
      return;
    }

    if (canAttack) {
      dispatch(Commands.attackHex(selectedUnit.id, coord));
      return;
    }

    if (canQueueMoveUnitTo(state, selectedUnit, coord)) {
      dispatch(Commands.moveUnit(selectedUnit.id, coord));
      return;
    }
  }

  dispatch(Commands.selectHex(coord));
}

function closeOverlay(): void {
  if (state.started) {
    elements.welcomeOverlay.classList.add("hidden");
  }
}

async function leaveWelcomeScreen(nextScreen: Screen): Promise<void> {
  if (blockingOverlay) {
    return;
  }

  if (state.openingEnemyTurnPending) {
    blockingOverlay = { type: "loading" };
    render();
    await waitForPaint();
    dispatch(Commands.runOpeningEnemyTurn());
    blockingOverlay = null;
  }

  closeOverlay();
  currentScreen = nextScreen;
  showMenuLoadList = false;
  render();
}

function render(): void {
  pruneCombatEffects(performance.now());
  syncPlacementSelectorState();
  renderPanels(elements, state, currentScreen, {
    showMenuLoadList,
    confirmingQueueCancelIds,
    confirmingQueueFinishIds,
    soundVolume,
    soundMuted,
    placementSelectorPinned,
    placementSelectorHoverOpen,
    placementSelectorHoverSuppressed,
    placementSelectorClosing,
    selectedPlacementUnit,
    selectedPlacementLevel,
    productionCurrency,
    researchCurrency,
    fieldUpgradeCurrency,
    debugMode
  });
  elements.welcomeLoadList.innerHTML = "";
  renderBlockingOverlay();
  syncMapCursorState();
  const attentionRegion = pendingTurnAttentionRegion;
  pendingTurnAttentionRegion = null;
  hexCanvas.setScene(state, combatEffects, attentionRegion, selectedPlacementUnit, debugMode && Boolean(state.debugOptions?.showAiUnits));
}

function syncMapCursorState(): void {
  const selectedUnit = getSelectedUnit(state);
  const placementTargeting = currentScreen === "map" && selectedPlacementUnit !== null;
  const movementTargeting = currentScreen === "map" && selectedUnit?.owner === "Player" && getReachableHexIds(state, selectedUnit).size > 0;
  elements.canvas.classList.toggle("command-cursor", placementTargeting || movementTargeting);
}

function syncPlacementSelectorState(): void {
  const noAvailablePlacementMaterial = !hasAvailablePlacementMaterial();
  if (!state.started || currentScreen !== "map" || noAvailablePlacementMaterial || (selectedPlacementUnit && !isPlacementUnitAvailable(selectedPlacementUnit, selectedPlacementLevel ?? undefined))) {
    selectedPlacementUnit = null;
    selectedPlacementLevel = null;
  }

  if (noAvailablePlacementMaterial) {
    placementSelectorPinned = false;
    placementSelectorHoverOpen = false;
    placementSelectorHoverSuppressed = false;
    placementSelectorClosing = false;
    cancelPlacementSelectorFade();
  }
}

function isRepeatedPlacementMode(): boolean {
  return placementSelectorPinned && selectedPlacementUnit !== null;
}

function closePlacementSelector(): boolean {
  if (!placementSelectorPinned && !placementSelectorHoverOpen && !placementSelectorClosing && !selectedPlacementUnit && !selectedPlacementLevel) {
    return false;
  }

  cancelPlacementSelectorClose();
  fadePlacementSelectorClosed();
  placementSelectorHoverSuppressed = false;
  selectedPlacementUnit = null;
  selectedPlacementLevel = null;
  return true;
}

function fadePlacementSelectorClosed(): void {
  cancelPlacementSelectorClose();
  const wasOpen = placementSelectorPinned || placementSelectorHoverOpen;
  placementSelectorPinned = false;
  placementSelectorHoverOpen = false;
  placementSelectorClosing = wasOpen && hasAvailablePlacementMaterial();
  window.clearTimeout(unitSelectorFadeTimer ?? undefined);
  unitSelectorFadeTimer = null;
  if (!placementSelectorClosing) {
    return;
  }

  unitSelectorFadeTimer = window.setTimeout(() => {
    unitSelectorFadeTimer = null;
    placementSelectorClosing = false;
    render();
  }, UNIT_SELECTOR_FADE_MS);
}

function cancelPlacementSelectorFade(): void {
  window.clearTimeout(unitSelectorFadeTimer ?? undefined);
  unitSelectorFadeTimer = null;
  placementSelectorClosing = false;
}

function isPointerInsidePlacementSelector(clientX: number, clientY: number): boolean {
  if (!hasAvailablePlacementMaterial()) {
    return false;
  }

  const bounds = elements.mapUnitSelector.getBoundingClientRect();
  const list = elements.mapUnitSelector.querySelector<HTMLElement>(".unit-selector-list");
  const listBounds = list?.getBoundingClientRect();
  const bridgePadding = 8;
  const left = Math.min(bounds.left, listBounds?.left ?? bounds.left) - bridgePadding;
  const right = Math.max(bounds.right, listBounds?.right ?? bounds.right) + bridgePadding;
  const top = Math.min(bounds.top, listBounds?.top ?? bounds.top) - bridgePadding;
  const bottom = Math.max(bounds.bottom, listBounds?.bottom ?? bounds.bottom) + bridgePadding;
  return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
}

function isPlacementUnitAvailable(unitType: UnitType, unitLevel?: number): boolean {
  const unit = UNIT_DEFINITIONS.find((candidate) => candidate.type === unitType);
  if (!unit || !isUnitAvailableToOwnerInState(state, "Player", unitType) || (state.economy.inventory[unitType] ?? 0) <= 0) {
    return false;
  }

  if (unitLevel === undefined) {
    return true;
  }

  return Number(state.economy.inventoryByLevel?.[unitType]?.[unitLevel] ?? 0) > 0;
}

function hasAvailablePlacementMaterial(): boolean {
  return UNIT_DEFINITIONS.some((unit) => isUnitAvailableToOwnerInState(state, "Player", unit.type) && (state.economy.inventory[unit.type] ?? 0) > 0);
}

function getHighestAvailablePlacementLevel(unitType: UnitType): number | null {
  const levels = state.economy.inventoryByLevel?.[unitType] ?? {};
  return (
    Object.entries(levels)
      .filter(([, count]) => Number(count) > 0)
      .map(([level]) => Number(level))
      .filter((level) => Number.isFinite(level))
      .sort((first, second) => second - first)[0] ?? null
  );
}

function isSelectedPlacementMaterial(unitType: UnitType, unitLevel?: number): boolean {
  if (selectedPlacementUnit !== unitType) {
    return false;
  }

  const selectedLevel = selectedPlacementLevel ?? getHighestAvailablePlacementLevel(unitType);
  const clickedLevel = unitLevel ?? getHighestAvailablePlacementLevel(unitType);
  return selectedLevel === clickedLevel;
}

function setSoundVolumePercent(value: number): void {
  soundVolume = clampInteger(value, 0);
  soundVolume = Math.min(100, soundVolume);
  if (soundVolume > 0) {
    previousNonZeroSoundVolume = soundVolume;
    soundMuted = false;
  } else {
    soundMuted = true;
  }
  syncSoundSettings();
  updateVolumeControl();
}

function toggleSoundMuted(): void {
  if (soundMuted) {
    soundMuted = false;
    if (soundVolume <= 0) {
      soundVolume = previousNonZeroSoundVolume || 40;
    }
  } else {
    if (soundVolume > 0) {
      previousNonZeroSoundVolume = soundVolume;
    }
    soundMuted = true;
  }
  syncSoundSettings();
  render();
}

function syncSoundSettings(): void {
  setSoundVolume(soundVolume / 100);
  setSoundMuted(soundMuted);
}

function updateVolumeControl(): void {
  const slider = document.querySelector<HTMLInputElement>("[data-volume-slider]");
  const value = document.querySelector<HTMLElement>(".volume-value");
  const toggle = document.querySelector<HTMLElement>("[data-volume-toggle]");
  if (slider) {
    slider.value = String(soundVolume);
  }
  if (value) {
    value.textContent = String(soundVolume);
  }
  if (toggle) {
    toggle.classList.toggle("muted", soundMuted);
    toggle.setAttribute("aria-label", soundMuted ? "Unmute sound" : "Mute sound");
  }
}

function renderBlockingOverlay(): void {
  if (!blockingOverlay) {
    elements.blockingOverlay.classList.add("hidden");
    elements.blockingModal.className = "modal-box";
    elements.blockingMessage.textContent = "";
    return;
  }

  elements.blockingOverlay.classList.remove("hidden");
  if (blockingOverlay.type === "loading") {
    elements.blockingModal.className = "modal-box loading";
    elements.blockingMessage.textContent = "Loading...";
    return;
  }

  if (blockingOverlay.type === "exitPrompt") {
    elements.blockingModal.className = "modal-box prompt unsaved-prompt";
    elements.blockingMessage.innerHTML = `
      <div class="modal-title">Unsaved Game</div>
      <div class="modal-copy">Save before exiting?</div>
      <div class="modal-actions">
        <button class="text-button wide" type="button" data-modal-action="save-exit">Save Game</button>
        <button class="text-button wide danger" type="button" data-modal-action="discard">Exit Without Saving</button>
        <button class="text-button wide" type="button" data-modal-action="cancel">Cancel</button>
      </div>
    `;
    return;
  }

  const playerWon = blockingOverlay.winner === "Player";
  elements.blockingModal.className = `modal-box ${playerWon ? "victory" : "defeat"}`;
  elements.blockingMessage.textContent = `${playerWon ? "Victory" : "Game Over"}\n\nPress [Enter] to continue.`;
  if (lastResultSoundWinner !== blockingOverlay.winner) {
    lastResultSoundWinner = blockingOverlay.winner;
    playSound(playerWon ? "victory" : "gameover");
  }
}

function returnToStartMenu(): void {
  clearQueueCancelConfirmations();
  engine = createGameEngine();
  state = engine.getState();
  combatEffects = [];
  blockingOverlay = null;
  lastResultSoundWinner = null;
  showMenuLoadList = false;
  startMenuMode = "main";
  startOptionsOpenedFromGame = false;
  hasUnsavedChanges = false;
  currentScreen = "map";
  elements.welcomeOverlay.classList.remove("hidden");
  syncStartPanels();
  renderStartMenuMode();
  render();
}

function handleQueueCancelClick(kind: "production" | "research", jobId: string): void {
  const key = getQueueCancelKey(kind, jobId);
  if (confirmingQueueCancelIds.has(key)) {
    clearQueueCancelConfirmation(key);
    dispatch(kind === "production" ? Commands.cancelProduction(jobId) : Commands.cancelResearch(jobId));
    return;
  }

  confirmingQueueCancelIds.add(key);
  window.clearTimeout(queueCancelTimers.get(key));
  queueCancelTimers.set(
    key,
    window.setTimeout(() => {
      queueCancelTimers.delete(key);
      if (confirmingQueueCancelIds.delete(key)) {
        render();
      }
    }, QUEUE_CANCEL_CONFIRM_MS)
  );
  render();
}

function handleQueueFinishClick(kind: "production" | "research", jobId: string): void {
  const key = getQueueFinishKey(kind, jobId);
  if (confirmingQueueFinishIds.has(key)) {
    clearQueueFinishConfirmation(key);
    dispatch(kind === "production" ? Commands.finishProduction(jobId) : Commands.finishResearch(jobId));
    return;
  }

  confirmingQueueFinishIds.add(key);
  window.clearTimeout(queueFinishTimers.get(key));
  queueFinishTimers.set(
    key,
    window.setTimeout(() => {
      queueFinishTimers.delete(key);
      if (confirmingQueueFinishIds.delete(key)) {
        render();
      }
    }, QUEUE_CANCEL_CONFIRM_MS)
  );
  render();
}

function getQueueCancelKey(kind: "production" | "research", jobId: string): string {
  return `${kind}:${jobId}`;
}

function getQueueFinishKey(kind: "production" | "research", jobId: string): string {
  return `${kind}:${jobId}`;
}

function clearQueueCancelConfirmation(key: string): void {
  window.clearTimeout(queueCancelTimers.get(key));
  queueCancelTimers.delete(key);
  confirmingQueueCancelIds.delete(key);
}

function clearQueueFinishConfirmation(key: string): void {
  window.clearTimeout(queueFinishTimers.get(key));
  queueFinishTimers.delete(key);
  confirmingQueueFinishIds.delete(key);
}

function clearQueueCancelConfirmations(): void {
  for (const timer of queueCancelTimers.values()) {
    window.clearTimeout(timer);
  }
  queueCancelTimers.clear();
  confirmingQueueCancelIds.clear();
  for (const timer of queueFinishTimers.values()) {
    window.clearTimeout(timer);
  }
  queueFinishTimers.clear();
  confirmingQueueFinishIds.clear();
}

function pruneQueueCancelConfirmations(): void {
  const validKeys = new Set([
    ...state.economy.productionQueue.map((job) => getQueueCancelKey("production", job.id)),
    ...state.economy.researchQueue.map((job) => getQueueCancelKey("research", job.id))
  ]);

  for (const key of Array.from(confirmingQueueCancelIds)) {
    if (!validKeys.has(key)) {
      clearQueueCancelConfirmation(key);
    }
  }

  for (const key of Array.from(confirmingQueueFinishIds)) {
    if (!validKeys.has(key)) {
      clearQueueFinishConfirmation(key);
    }
  }
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function addCombatEffects(logEntries: LogEntry[]): void {
  const now = performance.now();
  const newEffects = logEntries
    .map((entry, index) => parseCombatEffect(entry, now + index * 80))
    .filter((effect): effect is CombatVisualEffect => Boolean(effect));

  if (!newEffects.length) {
    pruneCombatEffects(now);
    return;
  }

  combatEffects = [...combatEffects.filter((effect) => now - effect.startedAt < effect.durationMs), ...newEffects];
}

function addEnemyMovementTrailEffects(
  trails: EnemyMovementTrail[],
  baseBorderColorsByHexId: Record<string, string>
): void {
  const now = performance.now();
  if (!trails.length) {
    pruneCombatEffects(now);
    return;
  }

  const newEffects: CombatVisualEffect[] = trails
    .filter((trail) => trail.coords.length > 0)
    .map((trail, index) => ({
      id: combatEffectId++,
      type: "enemy-trail" as const,
      coords: trail.coords.map((coord) => ({ ...coord })),
      baseBorderColorsByHexId: getTrailBaseBorderColors(trail, baseBorderColorsByHexId),
      startedAt: now + index * 30,
      durationMs: 4000
    }));

  combatEffects = [...combatEffects.filter((effect) => now - effect.startedAt < effect.durationMs), ...newEffects];
}

function getTrailBaseBorderColors(
  trail: EnemyMovementTrail,
  baseBorderColorsByHexId: Record<string, string>
): Record<string, string> {
  const trailBaseBorderColors: Record<string, string> = {};
  for (const coord of trail.coords) {
    const id = hexId(coord);
    const color = baseBorderColorsByHexId[id];
    if (color) {
      trailBaseBorderColors[id] = color;
    }
  }
  return trailBaseBorderColors;
}

function pruneCombatEffects(now: number): void {
  combatEffects = combatEffects.filter((effect) => now - effect.startedAt < effect.durationMs);
}

function parseCombatEffect(entry: LogEntry, startedAt: number): CombatVisualEffect | null {
  const match = entry.text.match(/^(Player|Enemy) .+ (hit|destroyed) (Player|Enemy) ([A-Za-z-]+) at (\d+),(\d+)/);
  if (!match) {
    return null;
  }

  const [, , action, owner, unitType, displayQ, displayR] = match;
  const coord = displayToCoord(Number(displayQ), Number(displayR));
  return {
    id: combatEffectId++,
    type: action === "destroyed" ? "destroyed" : "hit",
    coord,
    owner: owner as Owner,
    unitType: unitType as UnitType,
    startedAt,
    durationMs: action === "destroyed" ? 950 : 460
  };
}

function getPlayerTurnStartAttentionRegion(
  previousState: GameState,
  nextState: GameState,
  logEntries: LogEntry[],
  enemyMovementTrails: EnemyMovementTrail[]
): TurnAttentionRegion | null {
  const coords: HexCoord[] = [];
  appendMovementAttentionCoords(coords, nextState, logEntries, enemyMovementTrails);
  appendPlayerDamageAttentionCoords(coords, nextState, logEntries);
  appendGateCaptureAttentionCoords(coords, previousState, nextState);
  return buildTurnAttentionRegion(coords);
}

function appendMovementAttentionCoords(
  coords: HexCoord[],
  nextState: GameState,
  logEntries: LogEntry[],
  enemyMovementTrails: EnemyMovementTrail[]
): void {
  for (const trail of enemyMovementTrails) {
    coords.push(...trail.coords.map((coord) => ({ ...coord })));
  }

  for (const entry of logEntries) {
    const match = entry.text.match(/^(Player|Enemy) .+ moved from (\d+),(\d+) to (\d+),(\d+)\./);
    if (!match) {
      continue;
    }

    const [, , fromQ, fromR, toQ, toR] = match;
    coords.push(displayToCoordForState(nextState, Number(fromQ), Number(fromR)));
    coords.push(displayToCoordForState(nextState, Number(toQ), Number(toR)));
  }
}

function appendPlayerDamageAttentionCoords(coords: HexCoord[], nextState: GameState, logEntries: LogEntry[]): void {
  for (const entry of logEntries) {
    const combatMatch = entry.text.match(/^(Player|Enemy) .+ (hit|destroyed) Player [A-Za-z-]+ at (\d+),(\d+)/);
    if (combatMatch) {
      const [, , , displayQ, displayR] = combatMatch;
      coords.push(displayToCoordForState(nextState, Number(displayQ), Number(displayR)));
    }

    for (const attritionMatch of entry.text.matchAll(/Player [A-Za-z-]+ at (\d+),(\d+) (?:was destroyed by attrition|lost \d+ HP)/g)) {
      const [, displayQ, displayR] = attritionMatch;
      coords.push(displayToCoordForState(nextState, Number(displayQ), Number(displayR)));
    }
  }
}

function appendGateCaptureAttentionCoords(coords: HexCoord[], previousState: GameState, nextState: GameState): void {
  for (const gate of nextState.gates ?? []) {
    const previousGate = previousState.gates?.find((candidate) => candidate.id === gate.id);
    if (previousGate && previousGate.owner !== gate.owner) {
      coords.push({ ...gate.coord });
    }
  }
}

function buildTurnAttentionRegion(coords: HexCoord[]): TurnAttentionRegion | null {
  const uniqueCoords = dedupeCoords(coords);
  if (!uniqueCoords.length) {
    return null;
  }

  const measured = uniqueCoords.map((coord) => ({
    coord,
    point: axialToPixel(coord, { origin: { x: 0, y: 0 }, hexSize: 1 })
  }));
  const byTop = [...measured].sort((first, second) => first.point.y - second.point.y || first.point.x - second.point.x);
  const byBottom = [...measured].sort((first, second) => second.point.y - first.point.y || first.point.x - second.point.x);
  const byLeft = [...measured].sort((first, second) => first.point.x - second.point.x || first.point.y - second.point.y);
  const byRight = [...measured].sort((first, second) => second.point.x - first.point.x || first.point.y - second.point.y);

  return {
    top: { ...byTop[0].coord },
    bottom: { ...byBottom[0].coord },
    left: { ...byLeft[0].coord },
    right: { ...byRight[0].coord }
  };
}

function dedupeCoords(coords: HexCoord[]): HexCoord[] {
  const seen = new Set<string>();
  const unique: HexCoord[] = [];
  for (const coord of coords) {
    const id = hexId(coord);
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    unique.push(coord);
  }
  return unique;
}

function playSoundsForResult(logEntries: LogEntry[], previousState: GameState, nextState: GameState): void {
  const effects = logEntries.flatMap(getLogSoundEffects);
  const loggedRemovalSoundCount = effects.filter((effect) => effect === "destruction" || effect === "attritiondeath").length;
  const removedUnitCount = countRemovedUnits(previousState, nextState);

  for (let index = loggedRemovalSoundCount; index < removedUnitCount; index += 1) {
    effects.push("destruction");
  }

  appendGateCaptureSoundEffects(effects, previousState, nextState);
  void playSoundSequence(effects);
  if (didPlayerInventoryIncrease(previousState, nextState)) {
    void playSoundAfterCurrentEffects("newinventoryunit");
  }
}

function didPlayerInventoryIncrease(previousState: GameState, nextState: GameState): boolean {
  return UNIT_DEFINITIONS.some((unit) => getInventoryCount(nextState.economy.inventory, unit.type) > getInventoryCount(previousState.economy.inventory, unit.type));
}

function getInventoryCount(inventory: UnitInventory, unitType: UnitType): number {
  return Math.max(0, Math.floor(Number(inventory[unitType] ?? 0)));
}

function getLogSoundEffects(entry: LogEntry): SoundEffectName[] {
  const effects: SoundEffectName[] = [];
  const text = entry.text;

  if (/^(Player|Enemy) .+ destroyed (Player|Enemy) .+ at \d+,\d+/.test(text)) {
    effects.push("destruction");
  } else if (/^(Player|Enemy) .+ hit (Player|Enemy) .+ at \d+,\d+/.test(text)) {
    effects.push("hit");
  } else if (/^(Player|Enemy) .+ missed (Player|Enemy) .+ at \d+,\d+/.test(text) || / attacked \d+,\d+; no eligible target hit\./.test(text)) {
    effects.push("miss");
  }

  const attritionDeathCount = text.match(/ was destroyed by attrition after losing \d+ HP/g)?.length ?? 0;
  for (let index = 0; index < attritionDeathCount; index += 1) {
    effects.push("attritiondeath");
  }

  if (/^(Player|Enemy) .+ moved (?:from \d+,\d+(?: to \d+,\d+)?|to \d+,\d+)\./.test(text)) {
    effects.push("movement");
  }

  if (/^(Player|Enemy) placed .+ at \d+,\d+\./.test(text)) {
    effects.push("placement");
  }

  if (text === "The Empire has captured both Gates. The Alliance's Barrier has fallen.") {
    effects.push("enemybarrierdown");
  } else if (text === "The Alliance has captured both Gates. The Empire's Barrier has fallen.") {
    effects.push("playerbarrierdown");
  }

  return effects;
}

function appendGateCaptureSoundEffects(effects: SoundEffectName[], previousState: GameState, nextState: GameState): void {
  const playerCapturedFirstGate = didCaptureFirstAudibleGate(previousState, nextState, "Player");
  const enemyCapturedFirstGate = didCaptureFirstAudibleGate(previousState, nextState, "Enemy");

  if (playerCapturedFirstGate && !effects.includes("enemybarrierdown")) {
    effects.push("playergatecapture");
  }

  if (enemyCapturedFirstGate && !effects.includes("playerbarrierdown")) {
    effects.push("enemygatecapture");
  }
}

function didCaptureFirstAudibleGate(previousState: GameState, nextState: GameState, owner: Owner): boolean {
  return (
    getOwnedGateCount(previousState, owner) === 0 &&
    getOwnedGateCount(nextState, owner) === 1 &&
    (nextState.gates ?? []).some((gate) => {
      const previousGate = previousState.gates?.find((candidate) => candidate.id === gate.id);
      return previousGate?.owner !== owner && gate.owner === owner && isGateCaptureAudible(nextState, gate, owner);
    })
  );
}

function getOwnedGateCount(state: GameState, owner: Owner): number {
  return (state.gates ?? []).filter((gate) => gate.owner === owner).length;
}

function isGateCaptureAudible(state: GameState, gate: GameState["gates"][number], owner: Owner): boolean {
  return owner === "Player" || state.fog[hexId(gate.coord)] === "visible";
}

function countRemovedUnits(previousState: GameState, nextState: GameState): number {
  const remainingUnitIds = new Set(nextState.units.map((unit) => unit.id));
  return previousState.units.filter((unit) => !remainingUnitIds.has(unit.id)).length;
}

function displayToCoord(displayQ: number, displayR: number): HexCoord {
  return displayToCoordForState(state, displayQ, displayR);
}

function displayToCoordForState(targetState: GameState, displayQ: number, displayR: number): HexCoord {
  return {
    q: displayQ - 1,
    r: targetState.map.height - displayR
  };
}
