import { BUILDING_DEFINITIONS } from "../data/buildingDefs";
import { UNIT_DEFINITIONS, getUnitDefinition } from "../data/unitDefs";
import { canOwnerProduceUnit, isUnitAvailableToOwner, ownerHasBuilding } from "../game/buildings";
import {
  getOwnerBaseName,
  getOwnerEliteBuilding,
  getOwnerEliteResearch,
  getOwnerFaction,
  getOwnerSideAdjective,
  getOwnerSideName
} from "../game/factions";
import {
  GATE_INCOME_BONUS,
  canUseGainForProduction,
  canUseGainForResearch,
  describeResearch,
  getFieldUnitUpgradeCost,
  getFieldUnitUpgradeGainCost,
  getGateIncomeBonusForEconomy,
  getMaxUnitLevel,
  getProductionFinishGainCost,
  getProductionGainCost,
  getResearchFinishGainCost,
  getResearchGainCost,
  getResearchCost,
  getResearchDays,
  getUnitDailyGainValue
} from "../game/economy";
import { displayHexId, hexId, parseHexId, sameHex } from "../game/map";
import { getBaseAttackDamage, getBaseEffectiveUnitStats, getEffectiveUnitStats, getUnitInstanceLevel } from "../game/unitStats";
import { canAttackHex, canUnitAttackThisDay, canUnitTargetUnit, getQueuedMovementMoveCount, getRemainingMovementPoints, getSelectedUnit, getUnitsAt, getUnitDomain } from "../game/units";
import type { BuildingDefinition, DebugEconomyField, EconomyState, GameState, Owner, PurchaseCurrency, ResearchJob, ResearchType, SpottedUnit, UnitInstance, UnitType } from "../game/types";
import type { LayoutElements } from "./layout";

export type Screen = "welcome" | "map" | "production" | "research" | "menu" | "help";

const MAX_QUEUE_ITEMS = 10;
const COMMAND_SESSION_LABEL = "Assurance_Command_Session_0.31.wt";
const TANK_FACTORY_UNIT_ORDER: UnitType[] = ["Supply Truck", "Artillery", "Anti-Air", "IFV", "Tank"];
const ROMAN_LEVELS = ["", "I", "II", "III", "IV", "V"];
const DEBUG_ECONOMY_FIELDS: { field: DebugEconomyField; label: string; min: number }[] = [
  { field: "moneyPoundsBn", label: "Funds", min: 0 },
  { field: "gainPoints", label: "Gain", min: 0 },
  { field: "incomePoundsBn", label: "Income", min: 0 },
  { field: "efficiencyLevel", label: "Efficiency", min: 1 },
  { field: "productionCapacityLevel", label: "Prod Cap", min: 1 },
  { field: "productionSpeedLevel", label: "Prod Spd", min: 1 },
  { field: "researchCapacityLevel", label: "Rsch Cap", min: 1 },
  { field: "researchSpeedLevel", label: "Rsch Spd", min: 1 }
];

export interface RenderOptions {
  showMenuLoadList?: boolean;
  confirmingQueueCancelIds?: Set<string>;
  confirmingQueueFinishIds?: Set<string>;
  soundVolume?: number;
  soundMuted?: boolean;
  placementSelectorPinned?: boolean;
  placementSelectorHoverOpen?: boolean;
  placementSelectorHoverSuppressed?: boolean;
  placementSelectorClosing?: boolean;
  selectedPlacementUnit?: UnitType | null;
  selectedPlacementLevel?: number | null;
  productionCurrency?: PurchaseCurrency;
  researchCurrency?: PurchaseCurrency;
  fieldUpgradeCurrency?: PurchaseCurrency;
  debugMode?: boolean;
}

export function renderPanels(elements: LayoutElements, state: GameState, screen: Screen, options: RenderOptions = {}): void {
  renderTopBrand(elements.topBrand, options);
  renderTopBar(elements.topStatus, state);
  renderLeftPanel(elements.leftPanel, state, options);
  renderRightPanel(elements.rightPanel, screen);
  renderCenter(elements, state, screen, options);
  renderLog(elements.eventLog, state, options.debugMode ?? false);
  elements.endTurnButton.disabled = !state.started || screen === "welcome" || Boolean(state.winner);
}

function renderTopBrand(target: HTMLElement, options: RenderOptions): void {
  target.textContent = options.debugMode ? `${COMMAND_SESSION_LABEL} DEBUG` : COMMAND_SESSION_LABEL;
}

function renderTopBar(target: HTMLElement, state: GameState): void {
  const status = state.winner ? `${getOwnerSideName(state, state.winner).replace("The ", "").toUpperCase()} VICTORY` : state.paused ? "PAUSED" : "RUNNING";
  target.textContent = `DAY ${state.started ? state.day : "--"} | ${status}`;
}

function renderLeftPanel(target: HTMLElement, state: GameState, options: RenderOptions): void {
  const gateCost = getPlayerGateCost(state);
  const dailyGain = getPlayerDailyGain(state);
  target.innerHTML = `
    <div class="section">
      <div class="section-heading">Resources</div>
      <div class="kv-row"><span>Funds</span><span>£${state.economy.moneyPoundsBn}B</span></div>
      ${renderDailyIncomeRows(state.economy.incomePoundsBn, gateCost)}
      <div class="kv-row"><span>Gain</span><span>${state.economy.gainPoints}</span></div>
      ${renderDailyGainIncomeRow(dailyGain)}
      <div class="kv-row"><span>Efficiency</span><span>L${state.economy.efficiencyLevel}</span></div>
      <div class="kv-row"><span>Production</span><span>Cap ${state.economy.productionCapacityLevel} | Spd L${state.economy.productionSpeedLevel}</span></div>
      <div class="kv-row"><span>Research</span><span>Cap ${state.economy.researchCapacityLevel} | Spd L${state.economy.researchSpeedLevel}</span></div>
    </div>
    <div class="section">
      <div class="section-heading">Production</div>
      ${renderProductionQueue(state, options)}
    </div>
    <div class="section">
      <div class="section-heading">Research</div>
      ${renderResearchQueue(state, options)}
    </div>
    ${options.debugMode ? renderDebugWindow(state) : ""}
  `;
}

function renderDailyGainIncomeRow(dailyGain: number): string {
  if (dailyGain <= 0) {
    return "";
  }

  return `<div class="kv-row"><span>Income</span><span>${dailyGain}G / day</span></div>`;
}

function getPlayerDailyGain(state: GameState): number {
  return state.units
    .filter((unit) => unit.owner === "Player")
    .reduce((total, unit) => total + getUnitDailyGainValue(unit.type, getUnitInstanceLevel(state, unit)), 0);
}

function renderDailyIncomeRows(incomePoundsBn: number, gateCost: number): string {
  const incomeLabel = `${formatPoundsBn(incomePoundsBn)} / day`;

  if (gateCost === 0) {
    return `<div class="kv-row"><span>Income</span><span>${incomeLabel}</span></div>`;
  }

  const gateCostLabel = `-${formatPoundsBn(gateCost)} / day`;
  const totalLabel = `${formatPoundsBn(incomePoundsBn - gateCost)} / day`;
  return `
      <div class="kv-row"><span>Income</span><span>${incomeLabel}</span></div>
      <div class="kv-row"><span>Gate Cost</span><span>${gateCostLabel}</span></div>
      <div class="kv-row"><span aria-hidden="true"></span><span class="daily-total"><span class="daily-total-rule" aria-hidden="true">${gateCostLabel}</span><span>${totalLabel}</span></span></div>
  `;
}

function getPlayerGateCost(state: GameState): number {
  return state.gates.filter((gate) => gate.owner === "Player").length * getGateIncomeBonusForEconomy(state.economy);
}

function formatPoundsBn(amount: number): string {
  return `${amount < 0 ? "-" : ""}£${Math.abs(amount)}B`;
}

function renderProductionQueue(state: GameState, options: RenderOptions): string {
  if (!state.economy.productionQueue.length) {
    return `<div class="empty-line">(none)</div>`;
  }

  return state.economy.productionQueue
    .map((job) => renderQueueProgress(job.unitType, job.startedDay, job.availableDay, state.day, "production", job.id, getProductionFinishGainCost(job, state.day), canUseGainForProduction(job.unitType), options))
    .join("");
}

function renderResearchQueue(state: GameState, options: RenderOptions): string {
  if (!state.economy.researchQueue.length) {
    return `<div class="empty-line">(none)</div>`;
  }

  return state.economy.researchQueue
    .map((job) =>
      renderQueueProgress(
        describeResearchQueueJob(state, job),
        job.startedDay,
        job.completeDay,
        state.day,
        "research",
        job.id,
        getResearchFinishGainCost(job, state.economy, state.day),
        canUseGainForResearch(job.type),
        options
      )
    )
    .join("");
}

function renderDebugWindow(state: GameState): string {
  const options = state.debugOptions;
  return `
    <div class="section debug-window" data-debug-panel>
      <div class="section-heading">Debug</div>
      <div class="debug-checkbox-grid">
        ${renderDebugCheckbox("Show AI Units", "global", "showAiUnits", options.showAiUnits)}
        ${renderDebugCheckbox("No Fog-of-war", "global", "noFogOfWar", options.noFogOfWar)}
      </div>
      ${renderDebugSideControls(state, "Player")}
      ${renderDebugSideControls(state, "Enemy")}
      <div class="debug-subheading">Producing</div>
      ${renderDebugProductionQueue(state)}
      <div class="debug-subheading">Researching</div>
      ${renderDebugResearchQueue(state)}
    </div>
  `;
}

function renderDebugSideControls(state: GameState, owner: Owner): string {
  const economy = owner === "Player" ? state.economy : state.enemyEconomy;
  const sideOptions = state.debugOptions[owner];
  return `
    <div class="debug-side">
      <div class="debug-subheading">${owner}</div>
      <div class="debug-checkbox-grid">
        ${renderDebugCheckbox("No Damage", "side", "noDamage", sideOptions.noDamage, owner)}
        ${renderDebugCheckbox("Unlimited Move", "side", "unlimitedMovement", sideOptions.unlimitedMovement, owner)}
        ${renderDebugCheckbox("Unlimited Attack", "side", "unlimitedAttackRange", sideOptions.unlimitedAttackRange, owner)}
      </div>
      <div class="debug-funds-row">
        <button class="debug-mini-button" type="button" data-debug-add-funds-owner="${owner}" data-debug-add-funds="25">+£25B</button>
        <button class="debug-mini-button" type="button" data-debug-add-funds-owner="${owner}" data-debug-add-funds="100">+£100B</button>
      </div>
      <div class="debug-input-grid">
        ${DEBUG_ECONOMY_FIELDS.map(
          ({ field, label, min }) => `
            <label>
              <span>${label}</span>
              <input class="debug-number-input" type="number" min="${min}" step="1" value="${economy[field]}" data-debug-economy-owner="${owner}" data-debug-economy-field="${field}" />
            </label>
          `
        ).join("")}
      </div>
      <div class="debug-unit-levels">
        ${getOrderedHelpUnitDefinitions().filter((unit) => isUnitAvailableToOwner(unit.type, owner, state)).map((unit) => `
          <label>
            <span>${unit.label}</span>
            <select class="debug-select" data-debug-unit-level-owner="${owner}" data-debug-unit-level="${unit.type}">
              ${renderDebugLevelOptions(getMaxUnitLevel(unit.type), economy.unitLevels[unit.type])}
            </select>
          </label>
        `).join("")}
      </div>
      <div class="debug-auto-produce">
        <select class="debug-select" data-debug-auto-unit-owner="${owner}" aria-label="${owner} material unit">
          ${getOrderedHelpUnitDefinitions().filter((unit) => isUnitAvailableToOwner(unit.type, owner, state)).map((unit) => `<option value="${unit.type}">${unit.type}</option>`).join("")}
        </select>
        <select class="debug-select" data-debug-auto-level-owner="${owner}" aria-label="${owner} material level">
          ${renderDebugLevelOptions(3, 1)}
        </select>
        <input class="debug-count-input" type="number" min="1" max="99" step="1" value="1" data-debug-auto-count-owner="${owner}" aria-label="${owner} material count" />
        <button class="debug-mini-button" type="button" data-debug-auto-produce-owner="${owner}">Add</button>
      </div>
    </div>
  `;
}

function renderDebugCheckbox(
  label: string,
  scope: "global" | "side",
  option: string,
  checked: boolean,
  owner?: Owner
): string {
  const attributes = scope === "global"
    ? `data-debug-global-option="${option}"`
    : `data-debug-side-owner="${owner}" data-debug-side-option="${option}"`;
  return `
    <label class="debug-checkbox">
      <input type="checkbox" ${checked ? "checked" : ""} ${attributes} />
      <span>${label}</span>
    </label>
  `;
}

function renderDebugLevelOptions(maxLevel: number, selectedLevel: number): string {
  return Array.from({ length: maxLevel }, (_, index) => index + 1)
    .map((level) => `<option value="${level}"${level === selectedLevel ? " selected" : ""}>L${level}</option>`)
    .join("");
}

function renderDebugProductionQueue(state: GameState): string {
  if (!state.enemyEconomy.productionQueue.length) {
    return `<div class="empty-line">(none)</div>`;
  }

  return state.enemyEconomy.productionQueue
    .map((job) => renderDebugQueueProgress(job.unitType, job.startedDay, job.availableDay, state.day))
    .join("");
}

function renderDebugResearchQueue(state: GameState): string {
  if (!state.enemyEconomy.researchQueue.length) {
    return `<div class="empty-line">(none)</div>`;
  }

  return state.enemyEconomy.researchQueue
    .map((job) => renderDebugQueueProgress(describeResearchQueueJob(state, job, state.enemyEconomy), job.startedDay, job.completeDay, state.day))
    .join("");
}

function renderDebugQueueProgress(label: string, startedDay: number, completeDay: number, currentDay: number): string {
  const percent = getProgressPercent(startedDay, completeDay, currentDay);
  return `
    <div class="queue-progress debug-queue-progress">
      <span class="queue-progress-label">${label}</span>
      <div class="queue-progress-meter">
        <div class="progress-bar" aria-label="${label} progress">
          <div class="progress-fill" style="width: ${percent}%"></div>
        </div>
        <span>Day ${completeDay}</span>
      </div>
    </div>
  `;
}

function renderQueueProgress(
  label: string,
  startedDay: number,
  completeDay: number,
  currentDay: number,
  cancelKind: "production" | "research",
  jobId: string,
  finishGainCost: number,
  canFinishWithGain: boolean,
  options: RenderOptions
): string {
  const percent = getProgressPercent(startedDay, completeDay, currentDay);
  const cancelKey = getQueueCancelKey(cancelKind, jobId);
  const finishKey = getQueueFinishKey(cancelKind, jobId);
  const confirming = options.confirmingQueueCancelIds?.has(cancelKey) ?? false;
  const finishConfirming = options.confirmingQueueFinishIds?.has(finishKey) ?? false;
  const finishButton = canFinishWithGain
    ? `<button class="queue-finish-button${finishConfirming ? " confirm" : ""}" type="button" data-finish-${cancelKind}="${jobId}" aria-label="${finishConfirming ? `Confirm finish ${label} for ${finishGainCost} gain` : `Finish ${label} with gain`}">${finishConfirming ? `<span class="queue-finish-cost">${finishGainCost}</span><span>✓</span>` : "→"}</button>`
    : `<span class="queue-finish-placeholder" aria-hidden="true"></span>`;
  return `
    <div class="queue-progress">
      <span class="queue-progress-label">${label}</span>
      <div class="queue-progress-meter">
        <button class="queue-cancel-button${confirming ? " confirm" : ""}" type="button" data-cancel-${cancelKind}="${jobId}" aria-label="${confirming ? `Confirm cancel ${label}` : `Cancel ${label}`}">${confirming ? "✓" : "×"}</button>
        ${finishButton}
        <div class="progress-bar" aria-label="${label} progress">
          <div class="progress-fill" style="width: ${percent}%"></div>
        </div>
        <span>Day ${completeDay}</span>
      </div>
    </div>
  `;
}

function getProgressPercent(startedDay: number, completeDay: number, currentDay: number): number {
  const duration = Math.max(1, completeDay - startedDay);
  const elapsed = Math.max(0, currentDay - startedDay);
  return Math.max(0, Math.min(99, Math.floor((elapsed / duration) * 100)));
}

function getQueueCancelKey(kind: "production" | "research", jobId: string): string {
  return `${kind}:${jobId}`;
}

function getQueueFinishKey(kind: "production" | "research", jobId: string): string {
  return `${kind}:${jobId}`;
}

function renderRightPanel(target: HTMLElement, screen: Screen): void {
  target.innerHTML = `
    <div class="nav-group">
      <div class="nav-heading">Navigation</div>
      ${navButton("map", "Map", screen)}
      ${navButton("production", "Production", screen)}
      ${navButton("research", "Research", screen)}
    </div>
    <div class="nav-group">
      <div class="nav-heading">System</div>
      ${navButton("help", "Help", screen)}
      ${navButton("menu", "Menu", screen)}
    </div>
  `;
}

function navButton(target: Screen, label: string, screen: Screen): string {
  return `<button class="nav-button${target === screen ? " active" : ""}" type="button" data-screen="${target}">${label}</button>`;
}

function renderVolumeControl(volume: number, muted: boolean): string {
  return `
    <div class="volume-control" data-volume-control>
      <button class="volume-toggle${muted ? " muted" : ""}" type="button" data-volume-toggle aria-label="${muted ? "Unmute sound" : "Mute sound"}">
        <span class="volume-icon" aria-hidden="true"></span>
      </button>
      <div class="volume-popover">
        <input class="volume-slider" type="range" min="0" max="100" step="1" value="${volume}" data-volume-slider aria-label="Sound volume" />
        <span class="volume-value">${volume}</span>
      </div>
    </div>
  `;
}

function renderCenter(elements: LayoutElements, state: GameState, screen: Screen, options: RenderOptions): void {
  elements.centerTitle.textContent = screenTitle(screen);
  elements.mapFrame.classList.toggle("hidden", screen !== "map");

  if (screen === "map") {
    elements.centerContent.classList.remove("text-screen");
    if (elements.centerContent.firstElementChild !== elements.mapFrame || elements.centerContent.childElementCount !== 1) {
      elements.centerContent.replaceChildren(elements.mapFrame);
    }
    renderMapSelection(elements.mapSelection, state, options);
    renderMapUnitSelector(elements.mapUnitSelector, state, options);
    return;
  }

  elements.mapFrame.remove();
  elements.centerContent.classList.add("text-screen");
  elements.centerContent.innerHTML = centerHtml(state, screen, options);
}

function centerHtml(state: GameState, screen: Screen, options: RenderOptions): string {
  if (screen === "production") {
    return renderProductionScreen(state, options.productionCurrency ?? "funds");
  }

  if (screen === "research") {
    return renderResearchScreen(state, options.researchCurrency ?? "funds");
  }

  if (screen === "help") {
    return renderHelpScreen(state);
  }

  if (screen === "welcome") {
    return renderWelcomeScreen(state);
  }

  return renderMenuScreen(options);
}

function renderWelcomeScreen(state: GameState): string {
  const playerName = getOwnerSideName(state, "Player");
  const enemyName = getOwnerSideName(state, "Enemy");
  const sendoff = state.playerFaction === "Alliance" ? "Good hunting." : "Godspeed.";
  return `
    <div class="welcome-panel">
      <p>Welcome to Assurance.</p>
      <br />
      <p>You are the Commander of ${playerName}'s Armed Forces at war with ${enemyName}.</p>
      <br />
      <p>Fight to capture the gates, then hold the enemy's base to secure victory.</p>
      <br />
      <p>${sendoff}</p>
      <br />
      <p>Press [Enter] to continue.</p>
      <br />
    </div>
  `;
}

function renderProductionScreen(state: GameState, currency: PurchaseCurrency): string {
  return `
    <div class="purchase-screen">
      <div class="production-list">
        ${BUILDING_DEFINITIONS.filter((building) => building.produces.some((unitType) => isUnitAvailableToOwner(unitType, "Player", state))).map((building) => renderProductionBuilding(state, building, currency)).join("")}
      </div>
      ${renderPurchaseCurrencyToggle("production", currency)}
    </div>
  `;
}

function renderProductionBuilding(state: GameState, building: BuildingDefinition, currency: PurchaseCurrency): string {
  const hasBuilding = ownerHasBuilding(state, "Player", building.type);
  const queueFull = state.economy.productionQueue.length >= MAX_QUEUE_ITEMS;
  return `
    <div class="production-building">
      <div class="production-heading">${building.type}${hasBuilding ? "" : " (locked)"}</div>
      ${building.produces
        .map((unitType) => {
          const unit = getUnitDefinition(unitType);
          const canProduce = canOwnerProduceUnit(state, "Player", unit.type);
          const canUseGain = canUseGainForProduction(unit.type);
          const available = currency === "funds" ? canProduce && !queueFull : canProduce && canUseGain;
          const gainCost = getProductionGainCost(unit.type, state.economy.unitLevels[unit.type]);
          const gainMeta = canUseGain ? `${gainCost} gain` : "gain unavailable";
          return `
            <div class="production-unit${available ? " clickable" : " disabled"}" ${
              available ? (currency === "funds" ? `data-produce="${unit.type}"` : `data-instant-produce="${unit.type}"`) : ""
            }>
              <div>
                <div class="production-name">${unit.type}</div>
                <div class="production-meta">${unit.domain} | £${unit.costPoundsBn}B | ${unit.productionDays} days | ${gainMeta}</div>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderResearchScreen(state: GameState, currency: PurchaseCurrency): string {
  const specialServicesDone = ownerHasBuilding(state, "Player", "Special Services");
  const eliteBuilding = getOwnerEliteBuilding(state, "Player");
  const eliteResearch = getOwnerEliteResearch(state, "Player");
  const eliteDone = ownerHasBuilding(state, "Player", eliteBuilding);
  const queueFull = state.economy.researchQueue.length >= MAX_QUEUE_ITEMS;
  return `
    <div class="purchase-screen">
      <div class="production-list">
        <div class="production-building">
          <div class="production-heading">Unit Upgrades</div>
          ${getOrderedHelpUnitDefinitions().filter((unit) => isUnitAvailableToOwner(unit.type, "Player", state)).map((unit) => {
            const level = getNextQueuedResearchStartLevel(state.economy, "UnitUpgrade", unit.type);
            const maxLevel = getMaxUnitLevel(unit.type);
            const nextLevel = Math.min(maxLevel, level + 1);
            const complete = level >= maxLevel;
            const queuedJob = getQueuedResearchJob(state.economy, "UnitUpgrade", unit.type);
            const available = currency === "funds" ? !complete && !queueFull : !complete && !queuedJob;
            const gainCost = getResearchGainCost("UnitUpgrade", unit.type, state.economy, level);
            const meta = complete
              ? `L${maxLevel} | complete`
              : `L${level} -> L${nextLevel} | £${getResearchCost("UnitUpgrade", unit.type, state.economy, level)}B | ${getResearchDays("UnitUpgrade", unit.type, state.economy, level)} days | ${gainCost} gain`;
            return `
              <div class="production-unit${available ? " clickable" : " disabled"}" ${
                available ? (currency === "funds" ? `data-research="UnitUpgrade" data-unit="${unit.type}"` : `data-instant-research="UnitUpgrade" data-unit="${unit.type}"`) : ""
              }>
                <div>
                  <div class="production-name">${unit.type}</div>
                  <div class="production-meta">${meta}</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
        <div class="production-building">
          <div class="production-heading">Facilities</div>
          ${renderFacilityResearchEntry(state, "Special Services", "UnlockSpecialServices", specialServicesDone, true, !queueFull, currency)}
          ${renderFacilityResearchEntry(state, eliteBuilding, eliteResearch, eliteDone, specialServicesDone, !queueFull, currency)}
        </div>
        <div class="production-building">
          <div class="production-heading">Economy</div>
          ${renderLevelResearchEntry(state, "Efficiency", "Efficiency", !queueFull, currency)}
          ${renderLevelResearchEntry(state, "Production Capacity", "ProductionCapacity", !queueFull, currency)}
          ${renderLevelResearchEntry(state, "Production Speed", "ProductionSpeed", !queueFull, currency)}
          ${renderLevelResearchEntry(state, "Research Capacity", "ResearchCapacity", !queueFull, currency)}
          ${renderLevelResearchEntry(state, "Research Speed", "ResearchSpeed", !queueFull, currency)}
        </div>
      </div>
      ${renderPurchaseCurrencyToggle("research", currency)}
    </div>
  `;
}

function renderPurchaseCurrencyToggle(kind: "production" | "research" | "field-upgrade", selectedCurrency: PurchaseCurrency): string {
  return `
    <div class="purchase-currency-toggle" aria-label="${kind} currency">
      ${renderPurchaseCurrencyButton(kind, "funds", selectedCurrency)}
      ${renderPurchaseCurrencyButton(kind, "gain", selectedCurrency)}
    </div>
  `;
}

function renderPurchaseCurrencyButton(kind: "production" | "research" | "field-upgrade", currency: PurchaseCurrency, selectedCurrency: PurchaseCurrency): string {
  const selected = currency === selectedCurrency;
  return `<button class="purchase-currency-button${selected ? " active" : ""}" type="button" data-${kind}-currency="${currency}" aria-pressed="${selected}">${currency === "funds" ? "Funds" : "Gain"}</button>`;
}

export function getOrderedHelpUnitDefinitions(): typeof UNIT_DEFINITIONS {
  const tankFactoryUnits = new Set<UnitType>(TANK_FACTORY_UNIT_ORDER);
  const orderedDefinitions = TANK_FACTORY_UNIT_ORDER.map((unitType) => getUnitDefinition(unitType));
  const result: typeof UNIT_DEFINITIONS = [];
  let insertedTankFactoryUnits = false;

  for (const unit of UNIT_DEFINITIONS) {
    if (!tankFactoryUnits.has(unit.type)) {
      result.push(unit);
      continue;
    }

    if (!insertedTankFactoryUnits) {
      result.push(...orderedDefinitions);
      insertedTankFactoryUnits = true;
    }
  }

  return result;
}

function describeResearchQueueJob(state: GameState, job: ResearchJob, economy: EconomyState = state.economy): string {
  if (job.type === "UnitUpgrade" && job.unitType) {
    const targetLevel = job.targetLevel ?? economy.unitLevels[job.unitType] + 1;
    return `${job.unitType} L${targetLevel - 1} -> L${targetLevel}`;
  }

  if (job.type === "Efficiency" || job.type === "ProductionCapacity" || job.type === "ResearchCapacity" || job.type === "ProductionSpeed" || job.type === "ResearchSpeed") {
    const targetLevel = job.targetLevel ?? getCurrentResearchLevel(economy, job.type, undefined) + 1;
    return `${describeResearch(job)} L${targetLevel - 1} -> L${targetLevel}`;
  }

  return describeResearch(job);
}

function renderLevelResearchEntry(state: GameState, label: string, researchType: ResearchType, queueAvailable: boolean, currency: PurchaseCurrency): string {
  const level = getNextQueuedResearchStartLevel(state.economy, researchType, undefined);
  const queuedJob = getQueuedResearchJob(state.economy, researchType, undefined);
  const gainCost = getResearchGainCost(researchType, undefined, state.economy, level);
  return renderResearchEntry(
    label,
    researchType,
    undefined,
    currency === "funds" ? queueAvailable : !queuedJob,
    `L${level} -> L${level + 1} | £${getResearchCost(researchType, undefined, state.economy, level)}B | ${getResearchDays(researchType, undefined, state.economy, level)} days | ${gainCost} gain`,
    gainCost,
    currency
  );
}

function renderFacilityResearchEntry(
  state: GameState,
  label: string,
  researchType: ResearchType,
  complete: boolean,
  prerequisitesMet: boolean,
  queueAvailable: boolean,
  currency: PurchaseCurrency
): string {
  const queuedJob = getQueuedResearchJob(state.economy, researchType, undefined);
  const prefix = prerequisitesMet ? "" : "Requires Special Services | ";
  const canUseGain = canUseGainForResearch(researchType);
  const gainMeta = canUseGain ? `${getResearchGainCost(researchType, undefined, state.economy)} gain` : "gain unavailable";
  const meta = queuedJob
    ? `${describeResearchQueueJob(state, queuedJob)} | researching`
    : `${prefix}£${getResearchCost(researchType, undefined, state.economy)}B | ${getResearchDays(researchType, undefined, state.economy)} days | ${gainMeta}${complete ? " | complete" : ""}`;

  return renderResearchEntry(
    label,
    researchType,
    undefined,
    prerequisitesMet && !complete && !queuedJob && (currency === "funds" ? queueAvailable : canUseGain),
    meta,
    getResearchGainCost(researchType, undefined, state.economy),
    currency
  );
}

function getNextQueuedResearchStartLevel(economy: EconomyState, researchType: ResearchType, unitType: UnitType | undefined): number {
  return economy.researchQueue
    .filter((job) => job.type === researchType && job.unitType === unitType)
    .reduce((level, job) => Math.max(level, job.targetLevel ?? level + 1), getCurrentResearchLevel(economy, researchType, unitType));
}

function getQueuedResearchJob(economy: EconomyState, researchType: ResearchType, unitType: UnitType | undefined): ResearchJob | undefined {
  return economy.researchQueue.find((job) => job.type === researchType && job.unitType === unitType);
}

function getCurrentResearchLevel(economy: EconomyState, researchType: ResearchType, unitType: UnitType | undefined): number {
  if (researchType === "Efficiency") {
    return economy.efficiencyLevel;
  }

  if (researchType === "ProductionCapacity") {
    return economy.productionCapacityLevel;
  }

  if (researchType === "ResearchCapacity") {
    return economy.researchCapacityLevel;
  }

  if (researchType === "ProductionSpeed") {
    return economy.productionSpeedLevel;
  }

  if (researchType === "ResearchSpeed") {
    return economy.researchSpeedLevel;
  }

  return unitType ? economy.unitLevels[unitType] : 1;
}

function renderResearchEntry(
  label: string,
  researchType: ResearchType,
  unitType: UnitType | undefined,
  available: boolean,
  meta: string,
  gainCost: number,
  currency: PurchaseCurrency
): string {
  return `
    <div class="production-unit${available ? " clickable" : " disabled"}" ${
      available
        ? currency === "funds"
          ? `data-research="${researchType}"${unitType ? ` data-unit="${unitType}"` : ""}`
          : `data-instant-research="${researchType}"${unitType ? ` data-unit="${unitType}"` : ""}`
        : ""
    }>
      <div>
        <div class="production-name">${label}</div>
        <div class="production-meta">${meta}</div>
      </div>
    </div>
  `;
}

function renderHelpScreen(state: GameState): string {
  const playerName = getOwnerSideName(state, "Player");
  const enemyName = getOwnerSideName(state, "Enemy");
  const playerBase = getOwnerBaseName(state, "Player");
  const enemyBase = getOwnerBaseName(state, "Enemy");
  return `
    <div class="section">
      <div class="section-heading">Rules</div>
      <div class="rules-section">
        <p>Build forces from material, place them on your back row, and advance through fog-of-war toward ${enemyBase}.</p>
        <p>To win, own both Gates, then hold the enemy Base. Capture Gates by holding them for two consecutive turns with an Infantry, Operator, Ghost, or a Spectral. Capture the Base in the same way, but for four turns. ${enemyName} wins in the same way against ${playerName}.</p>
        <p>Captured Gates reveal their side of the map and cost maintenance of £1B each, per day.</p>
        <p>${playerName}'s Area contains ${playerBase}. ${enemyName}'s Area contains ${enemyBase}. The centre Area is No Man's Land.</p>
        <p>Gain is a measure of momentum and captured material, and can be used to produce and research instantly, upgrade field units, and finish queued production and research, except for The Room, Drone Factory, Spectrals, and Reapers.</p>
        <p>Blue and red Barriers mark the borders between No Man’s Land and the protected Base Areas. You must own both Gates to move into, attack from, attack into, or capture the Base inside the enemy Area. That enemy Barrier disappears while both Gates are yours. If a Barrier is restored whilst your units are beyond it, each stranded unit loses 20% of its current HP each turn, until it retreats, or both Gates are recaptured.</p>
        <p>Units lose 1 movement, attack range, and sight range in No Man’s Land, 2 while in, or targeting the opposing Base Area. Ranges cannot fall below 1. Air and ground units can stack together, but matching domains cannot share a tile. Units on their own back row, or ground units within two tiles of another friendly Supply Truck or Command Heli, repair 20% of max HP at the start of each day.</p>
        <p>Damaged units do damage or repair in proportion to their current health. Attacks have a 10% miss chance. And a 10% critical chance, for 50% more damage. If a unit is strong against another, then it does 1.5x damage, if it is weak against, then it does 0.5x damage. Stealth attacks, where the attacker sees the target, but is in the opponent's fog-of-war, deal 20% more damage. Artillery and Anti-Air cannot move and fire on the same day. Jets, Bombers, and Reapers cannot be targeted by ground units, except Anti-Air. Supply Trucks and Command Helis cannot attack, but friendly ground units can repair within two tiles everywhere, and be placed within one tile, except in the enemy’s Area, though they cannot be placed next to and move in the same turn. Command Helis also produce a small amount of Gain per day.</p>
        <p>Destroying opposing units awards reduced gain based on the destroyed unit's gain value and level. Gain can instantly produce unit material, complete research, upgrade field units, or finish queued production and research, except for The Room, Drone Factory, Spectrals, and Reapers.</p>
        <p>Unit upgrade research affects future production only. Existing units and units already in production need to be upgraded manually. Field units can upgrade one level at a time with funds by default, or gain as the alternative. Units cap at Level III.</p>
        <p>Player unit tiles show abbreviation, HP/max HP, movement left, attack status, and level. Enemy unit tiles show abbreviation, HP/max HP, and level. A plus sign means ready to attack, a minus sign means attack not ready. Air units above ground units show a ^ symbol.</p>
      </div>
    </div>
    <div class="section">
      <div class="section-heading">Unit Cards</div>
      <div class="unit-card-list">
        ${renderHelpUnitCards()}
      </div>
    </div>
  `;
}

function renderHelpUnitCards(): string {
  return getOrderedHelpUnitDefinitions().map((unit) => renderHelpUnitCard(unit)).join(`<br /><br />`);
}

function renderHelpUnitCard(unit: typeof UNIT_DEFINITIONS[number]): string {
  const baseStats = getBaseEffectiveUnitStats(unit.type, 1);
  return `
    <article class="unit-card">
      <div class="unit-card-title">
        <span>${unit.type}</span>
        <span>${unit.label}</span>
      </div>
      <div class="unit-card-grid">
        <span>Unit</span><strong>${unit.type}</strong>
        <span>Tile</span><strong>${unit.label}</strong>
        <span>Available To</span><strong>${formatAvailableOwners(unit)}</strong>
        <span>Domain</span><strong>${unit.domain}</strong>
        <span>Human Based</span><strong>${formatBoolean(unit.humanBased)}</strong>
        <span>Produced By</span><strong>${unit.producedBy.join(", ")}</strong>
        <span>Cost</span><strong>£${unit.costPoundsBn}B</strong>
        <span>Gain Value</span><strong>${unit.gainValue}</strong>
        <span>Daily Gain</span><strong>${getUnitDailyGainValue(unit.type, 1) || "-"}</strong>
        <span>Build Time</span><strong>${unit.productionDays}d</strong>
        <span>Max Level</span><strong>L${getMaxUnitLevel(unit.type)}</strong>
        <span>Damage Bonus</span><strong>${unit.damageBonus ?? 0}</strong>
        <span>Base HP</span><strong>${unit.health}</strong>
        <span>Base Move</span><strong>${unit.moveRange}</strong>
        <span>Base Attack Range</span><strong>${unit.cannotAttack ? "-" : baseStats.attackRange}</strong>
        <span>Base Sight Range</span><strong>${unit.visibilityRange}</strong>
        <span>Target Domains</span><strong>${unit.cannotAttack ? "None" : (unit.targetDomains?.join(", ") ?? "Ground, Air")}</strong>
        <span>Targets</span><strong>${formatTargetDomains(unit)}</strong>
        <span>Move And Attack</span><strong>${unit.cannotAttack || unit.cannotMoveAndAttack ? "No" : "Yes"}</strong>
      </div>
      <div class="unit-card-profile">
        <div class="unit-card-subheading">Level Stats</div>
        <div class="unit-card-level-grid">
          <span>Level</span><span>HP</span><span>Damage</span><span>HP/Damage</span><span>Move</span><span>Attack Range</span><span>Sight Range</span><span>Daily Gain</span><span>Upgrade Cost</span>
          ${renderLevelStats(unit)}
        </div>
      </div>
      <div class="unit-card-profile">
        <div class="unit-card-subheading">Attack Profile</div>
        <div class="unit-card-profile-grid">
          ${renderAttackProfile(unit)}
        </div>
      </div>
      <div class="unit-card-profile">
        <div class="unit-card-subheading">Defence Profile</div>
        <div class="unit-card-profile-grid">
          ${renderDefenceProfile(unit)}
        </div>
      </div>
    </article>
  `;
}

function formatTargetDomains(unit: typeof UNIT_DEFINITIONS[number]): string {
  if (unit.cannotAttack) {
    return "None";
  }

  if (unit.targetDomains) {
    return unit.targetDomains.join(", ");
  }

  return unit.domain === "Ground" && unit.type !== "Anti-Air" ? "All but JET/BMB/RPR" : "All";
}

function renderLevelStats(unit: typeof UNIT_DEFINITIONS[number]): string {
  return Array.from({ length: getMaxUnitLevel(unit.type) }, (_item, index) => {
    const level = index + 1;
    const stats = getBaseEffectiveUnitStats(unit.type, level);
    const damage = unit.cannotAttack ? 0 : getBaseAttackDamage(unit.type, level);
    return `
      <strong>L${level}</strong>
      <strong>${stats.health}</strong>
      <strong>${damage}</strong>
      <strong>${damage > 0 ? formatHealthDamageRatio(stats.health, damage) : "-"}</strong>
      <strong>${stats.moveRange}</strong>
      <strong>${unit.cannotAttack ? "-" : stats.attackRange}</strong>
      <strong>${stats.visibilityRange}</strong>
      <strong>${getUnitDailyGainValue(unit.type, level) || "-"}</strong>
      <strong>${level === 1 ? "-" : `£${getFieldUnitUpgradeCost(unit.type, level - 1)}B / ${getFieldUnitUpgradeGainCost(unit.type, level - 1)}G`}</strong>
    `;
  }).join("");
}

function renderAttackProfile(unit: typeof UNIT_DEFINITIONS[number]): string {
  return UNIT_DEFINITIONS.map((target) => {
    const effectiveness = canUnitTargetUnit(unit.type, target.type) ? formatAttackEffectiveness(unit.attackProfile[target.type] ?? "weak") : "Cannot Target";
    return `
      <span>${target.label}</span>
      <strong>${effectiveness}</strong>
    `;
  }).join("");
}

function renderDefenceProfile(unit: typeof UNIT_DEFINITIONS[number]): string {
  return UNIT_DEFINITIONS.map((attacker) => {
    const effectiveness = canUnitTargetUnit(attacker.type, unit.type)
      ? formatAttackEffectiveness(attacker.attackProfile[unit.type] ?? "weak")
      : "Not a Target";
    return `
      <span>${attacker.label}</span>
      <strong>${effectiveness}</strong>
    `;
  }).join("");
}

function formatAttackEffectiveness(effectiveness: string): string {
  return effectiveness
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function formatAvailableOwners(unit: typeof UNIT_DEFINITIONS[number]): string {
  if (!unit.availableTo) {
    return "Empire, Alliance";
  }

  return unit.availableTo.map((owner) => owner === "Player" ? "Empire" : "Alliance").join(", ");
}

function formatBoolean(value: boolean): "Yes" | "No" {
  return value ? "Yes" : "No";
}

function formatHealthDamageRatio(health: number, damage: number): string {
  return (health / damage).toFixed(1);
}

function renderMenuScreen(options: RenderOptions): string {
  const soundVolume = options.soundVolume ?? 40;
  const soundMuted = options.soundMuted ?? false;
  return `
    <div class="menu-panel">
      <div class="menu-stack">
        <button class="text-button wide" type="button" data-system="new">New Game</button>
        <button class="text-button wide" type="button" data-system="save">Save Game</button>
        <button class="text-button wide" type="button" data-system="load">Load Game</button>
        <button class="text-button wide" type="button" data-system="exit">Exit</button>
      </div>
      ${renderVolumeControl(soundVolume, soundMuted)}
    </div>
  `;
}

function renderLog(target: HTMLElement, state: GameState, debugMode: boolean): void {
  const entries = state.log.length
    ? state.log
    : [
        {
          id: 0,
          day: state.day,
          text: "Awaiting start."
        }
      ];
  const latestEntryId = entries.at(-1)?.id ?? 0;
  const previousLatestEntryId = Number(target.dataset.latestLogEntryId ?? -1);
  const hasNewEntries = latestEntryId !== previousLatestEntryId;

  const downloadButton = debugMode
    ? `<button class="log-download-button" type="button" data-download-log aria-label="Download log as text file">Download Log</button>`
    : "";
  const logHtml = entries
    .map((entry, index) => {
      const dayBreak = index > 0 && entry.day !== entries[index - 1].day ? `<div class="log-day-break"></div>` : "";
      const sideBreak =
        !dayBreak && index > 0 && entry.day === entries[index - 1].day && isLogSideSwitch(entries[index - 1].text, entry.text)
          ? `<div class="log-side-break"></div>`
          : "";
      return `
      ${dayBreak}
      ${sideBreak}
      <div class="log-entry">
        <span class="log-turn">Day ${entry.day}</span>
        <span class="log-text ${getLogTextClass(entry.text, state)}">${formatLogText(entry.text, state)}</span>
      </div>
    `;
    })
    .join("");
  target.innerHTML = `${downloadButton}${logHtml}`;
  target.dataset.latestLogEntryId = String(latestEntryId);

  if (hasNewEntries) {
    target.scrollTop = target.scrollHeight;
  }
}

function formatLogText(text: string, state: GameState): string {
  const unitPattern = UNIT_DEFINITIONS.map((unit) => escapeRegExp(unit.type)).join("|");
  const adjectivalContexts =
    "production|research|placement|move|movement|attack|field upgrade|command|fallback|Efficiency|Production Capacity|Research Capacity|Production Speed|Research Speed";

  return text
    .replace(new RegExp(`\\b(Player|Enemy) (${unitPattern})\\b`, "g"), (_match, owner: Owner, unitType: string) => `${formatSideAdjective(state, owner)} ${unitType}`)
    .replace(/\b(Player|Enemy) base\b/gi, (_match, owner: Owner) => `${formatSideAdjective(state, owner)} Base`)
    .replace(/\b(Player|Enemy) Base\b/g, (_match, owner: Owner) => `${formatSideAdjective(state, owner)} Base`)
    .replace(new RegExp(`^(Player|Enemy) (${adjectivalContexts})\\b`), (_match, owner: Owner, context: string) => `${formatSideAdjective(state, owner)} ${context}`)
    .replace(/^(Player|Enemy) (placed|captured|ended turn|started|queued|cancell?ed|completed|upgraded field)\b/, (_match, owner: Owner, action: string) => `${formatSideName(state, owner)} ${action === "canceled" ? "cancelled" : action}`)
    .replace(/\bPlayer \+£/g, `${formatSideAdjective(state, "Player")} Income +£`)
    .replace(/\bEnemy \+£/g, `${formatSideAdjective(state, "Enemy")} Income +£`)
    .replace(/\bPlayer -£/g, `${formatSideAdjective(state, "Player")} Income -£`)
    .replace(/\bEnemy -£/g, `${formatSideAdjective(state, "Enemy")} Income -£`)
    .replace(/^Empire wins\./, "The Empire wins.")
    .replace(/^Alliance wins\./, "The Alliance wins.")
    .replace(/\bPlayer\b/g, formatSideName(state, "Player"))
    .replace(/\bEnemy\b/g, formatSideName(state, "Enemy"));
}

function formatSideName(state: GameState, owner: Owner): "The Empire" | "The Alliance" {
  return getOwnerSideName(state, owner);
}

function formatSideAdjective(state: GameState, owner: Owner): "Imperial" | "Alliance" {
  return getOwnerSideAdjective(state, owner);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLogSideSwitch(previousText: string, currentText: string): boolean {
  const previousSide = getLogSide(previousText);
  const currentSide = getLogSide(currentText);
  return Boolean(previousSide && currentSide && previousSide !== currentSide);
}

function getLogSide(text: string): Owner | null {
  if (text.startsWith("Player ")) {
    return "Player";
  }

  if (text.startsWith("Enemy ")) {
    return "Enemy";
  }

  return null;
}

function getLogTextClass(text: string, state: GameState): string {
  if (isDestructionLog(text) || isEnemyCaptureLog(text) || isOwnerWinLog(text, state, "Enemy") || isOwnerBarrierEventLog(text, state, "Enemy")) {
    return getOwnerFaction(state, "Enemy") === "Empire" ? "player-event" : "enemy-event";
  }

  if (isPlayerCaptureLog(text) || isOwnerWinLog(text, state, "Player") || isOwnerBarrierEventLog(text, state, "Player")) {
    return getOwnerFaction(state, "Player") === "Empire" ? "player-event" : "enemy-event";
  }

  if (isHitLog(text)) {
    return "hit";
  }

  if (isResearchCompletedLog(text)) {
    return "research-complete";
  }

  if (isProductionCompletedLog(text)) {
    return "production-complete";
  }

  return "";
}

export function isHitLog(text: string): boolean {
  return /^(Player|Enemy) .+ (hit|missed) (Player|Enemy) .+ at \d+,\d+(?: for \d+)?(?: \([^)]+\))?\.(?: \([^)]*\)\.)?$/.test(text);
}

function isDestructionLog(text: string): boolean {
  return text.includes(" destroyed ");
}

function isResearchCompletedLog(text: string): boolean {
  return /^(Player|Enemy) .+ upgraded to level \d+\.$/.test(text) || /^(Player|Enemy) .+ future production upgraded to level \d+\.$/.test(text) || /^(Player|Enemy) upgraded field .+ to level \d+ for (£\d+B|\d+ gain)\.$/.test(text) || /^(Player|Enemy) completed .+\.$/.test(text) || /^(Player|Enemy) (Efficiency|Production Capacity|Research Capacity|Production Speed|Research Speed) level \d+\.$/.test(text);
}

function isProductionCompletedLog(text: string): boolean {
  return /^(Player|Enemy) .+ available\.$/.test(text);
}

function isPlayerCaptureLog(text: string): boolean {
  return text.startsWith("Player captured ");
}

function isEnemyCaptureLog(text: string): boolean {
  return text.startsWith("Enemy captured ");
}

function isOwnerBarrierEventLog(text: string, state: GameState, owner: Owner): boolean {
  const controller = getOwnerSideName(state, owner);
  const barrier = getOwnerSideName(state, owner === "Player" ? "Enemy" : "Player");
  return (
    text === `${controller} has captured both Gates. ${barrier}'s Barrier has fallen.` ||
    text === `${controller} no longer controls both Gates. ${barrier}'s Barrier has been restored.`
  );
}

function isOwnerWinLog(text: string, state: GameState, owner: Owner): boolean {
  const sideName = getOwnerSideName(state, owner);
  return text.startsWith(`${sideName} wins.`) || text.startsWith(`${sideName.replace("The ", "")} wins.`) || text.startsWith(`${owner} wins.`);
}

function renderMapUnitSelector(target: HTMLElement, state: GameState, options: RenderOptions): void {
  if (!state.started) {
    target.className = "map-unit-selector hidden";
    target.innerHTML = "";
    return;
  }

  const selectedUnitType = options.selectedPlacementUnit ?? null;
  const selectedUnitLevel = options.selectedPlacementLevel ?? null;
  const selectedUnit = selectedUnitType ? getUnitDefinition(selectedUnitType) : null;
  const availableMaterial = getOrderedHelpUnitDefinitions()
    .slice()
    .filter((unit) => isUnitAvailableToOwner(unit.type, "Player", state) && getAvailableMaterialCount(state, unit.type) > 0);
  const hasAvailableMaterial = availableMaterial.length > 0;

  target.className = `map-unit-selector${state.playerFaction === "Alliance" ? " alliance-player" : ""}${hasAvailableMaterial ? " available" : ""}${options.placementSelectorPinned ? " pinned" : ""}${options.placementSelectorHoverOpen ? " hover-open" : ""}${options.placementSelectorHoverSuppressed ? " suppress-hover" : ""}${options.placementSelectorClosing ? " closing" : ""}${selectedUnit ? " has-selection" : ""}`;
  target.innerHTML = `
    <div class="unit-selector-list">
      ${availableMaterial
        .map((unit) => {
          const availableLevels = getAvailableMaterialLevels(state, unit.type);
          const primaryLevel = availableLevels[0] ?? getAvailableMaterialLevel(state, unit.type);
          const alternateLevels = availableLevels.filter((level) => level !== primaryLevel);
          const selected = unit.type === selectedUnitType && selectedUnitLevel === primaryLevel;
          return `
            <div class="unit-selector-unit">
              <button class="unit-selector-tile${selected ? " selected" : ""}" type="button" data-placement-unit="${unit.type}" data-placement-level="${primaryLevel}" aria-label="Select ${unit.type} level ${primaryLevel} for placement">
                <span class="unit-selector-level">${formatRomanLevel(primaryLevel)}</span>
                <span class="unit-selector-label">${unit.label}</span>
                <span class="unit-selector-stats">${getAvailableMaterialLevelCount(state, unit.type, primaryLevel)}</span>
              </button>
              ${
                alternateLevels.length
                  ? `
                    <div class="unit-selector-level-list">
                      ${alternateLevels
                        .map((level) => {
                          const variantSelected = unit.type === selectedUnitType && selectedUnitLevel === level;
                          return `
                            <button class="unit-selector-tile${variantSelected ? " selected" : ""}" type="button" data-placement-unit="${unit.type}" data-placement-level="${level}" aria-label="Select ${unit.type} level ${level} for placement">
                              <span class="unit-selector-level">${formatRomanLevel(level)}</span>
                              <span class="unit-selector-label">${unit.label}</span>
                              <span class="unit-selector-stats">${getAvailableMaterialLevelCount(state, unit.type, level)}</span>
                            </button>
                          `;
                        })
                        .join("")}
                    </div>
                  `
                  : ""
              }
            </div>
          `;
        })
        .join("")}
    </div>
    <button class="unit-selector-tile unit-selector-home" type="button" data-unit-selector-toggle ${hasAvailableMaterial ? "" : "disabled"} aria-label="${
      options.placementSelectorPinned ? "Close material selector" : "Open material selector"
    }">
      <span class="unit-selector-label">INV</span>
    </button>
  `;
}

function formatRomanLevel(level: number): string {
  return ROMAN_LEVELS[level] ?? String(level);
}

function getAvailableMaterialCount(state: GameState, unitType: UnitType): number {
  return Math.max(0, Math.floor(state.economy.inventory[unitType] ?? 0));
}

function getAvailableMaterialLevels(state: GameState, unitType: UnitType): number[] {
  const levels = state.economy.inventoryByLevel?.[unitType] ?? {};
  return Object.entries(levels)
    .filter(([, count]) => Number(count) > 0)
    .map(([level]) => Number(level))
    .filter((level) => Number.isFinite(level))
    .sort((first, second) => second - first);
}

function getAvailableMaterialLevel(state: GameState, unitType: UnitType): number {
  const availableLevel = getAvailableMaterialLevels(state, unitType)[0];
  return availableLevel ?? state.economy.unitLevels[unitType] ?? 1;
}

function getAvailableMaterialLevelCount(state: GameState, unitType: UnitType, level: number): number {
  return Math.max(0, Math.floor(Number(state.economy.inventoryByLevel?.[unitType]?.[level] ?? 0)));
}

export function renderMapSelection(target: HTMLElement, state: GameState, options: RenderOptions = {}): void {
  const selectedHex = state.selection.selectedHexId ? parseHexId(state.selection.selectedHexId) : null;
  const selectedUnit = getSelectedUnit(state);
  const selectedOccupants = selectedHex ? getUnitsAt(state, selectedHex).filter((unit) => canPlayerInspectUnit(state, unit)) : [];
  const selectedSpottedUnits = selectedHex ? getPlayerSpottedUnitsAt(state, selectedHex) : [];

  if (!selectedHex) {
    target.classList.add("hidden");
    target.innerHTML = "";
    return;
  }

  target.classList.remove("hidden");
  const selectedId = hexId(selectedHex);
  const selectedDisplayId = displayHexId(state.map, selectedHex);
  const selectedGate = (state.gates ?? []).find((gate) => hexId(gate.coord) === selectedId);
  const selectedGateVisible = state.fog[selectedId] === "visible";
  const selectedGateOwner = selectedGateVisible ? selectedGate?.owner : selectedGate?.knownOwner;
  const baseLabel =
    selectedId === hexId(state.bases.Player)
      ? getOwnerBaseName(state, "Player")
      : selectedId === hexId(state.bases.Enemy)
        ? getOwnerBaseName(state, "Enemy")
        : selectedGate
          ? `${selectedGate.label} | ${selectedGateOwner ?? "Neutral"}`
          : "Open";

  target.innerHTML = `
    <div class="selection-title">${selectedDisplayId} | ${baseLabel}</div>
    ${selectedGate ? renderGateStatus(selectedGate, selectedGateVisible, state) : ""}
    ${renderTileUnits(state, selectedOccupants, selectedUnit)}
    ${renderSpottedTileUnits(state, selectedSpottedUnits, selectedUnit)}
    ${selectedUnit ? renderSelectedUnit(selectedUnit, state, options.fieldUpgradeCurrency ?? "funds", options.debugMode ?? false) : ""}
    ${!selectedUnit && !selectedOccupants.length && !selectedSpottedUnits.length ? `<div class="empty-line">No available action.</div>` : ""}
  `;
}

function renderGateStatus(gate: NonNullable<GameState["gates"]>[number], visible: boolean, state: GameState): string {
  const playerCost = getGateIncomeBonusForEconomy(state.economy);
  const enemyCost = getGateIncomeBonusForEconomy(state.enemyEconomy);
  const visibleCost = gate.owner === "Enemy" ? enemyCost : playerCost;
  const visibleCostLabel = gate.owner ? `-£${visibleCost}B` : `P -£${playerCost}B | E -£${enemyCost}B`;
  if (!visible) {
    return `
      <div class="compact-grid">
        <span>Cost</span><strong>-£${GATE_INCOME_BONUS}B + Eff/level</strong>
        <span>Reveal</span><strong>Side Map</strong>
      </div>
    `;
  }

  return `
    <div class="compact-grid">
      <span>${getOwnerSideName(state, "Player").replace("The ", "")} Hold</span><strong>${gate.occupation.Player}/2</strong>
      <span>${getOwnerSideName(state, "Enemy").replace("The ", "")} Hold</span><strong>${gate.occupation.Enemy}/2</strong>
      <span>Cost</span><strong>${visibleCostLabel}</strong>
      <span>Reveal</span><strong>Side Map</strong>
    </div>
  `;
}

function renderTileUnits(state: GameState, units: UnitInstance[], selectedUnit: UnitInstance | undefined): string {
  if (!units.length) {
    return "";
  }

  return `
    <div class="tile-unit-list">
      ${units
        .map((unit) => {
          const attackable =
            selectedUnit?.owner === "Player" && unit.owner === "Enemy" && canAttackHex(state, selectedUnit, unit.coord);
          return `
            <button class="text-button tile-unit-button${unit.id === selectedUnit?.id ? " active" : ""}" type="button" ${
              attackable ? `data-attack-at="${hexId(unit.coord)}"` : `data-select-unit="${unit.id}"`
            }>
              ${getOwnerSideAdjective(state, unit.owner)} ${getUnitDomain(unit.type)}: ${unit.type}
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderSpottedTileUnits(state: GameState, units: SpottedUnit[], selectedUnit: UnitInstance | undefined): string {
  if (!units.length) {
    return "";
  }

  return `
    <div class="tile-unit-list">
      ${units
        .map(
          (unit) => `
            <button class="text-button tile-unit-button tile-unit-memory${unit.id === selectedUnit?.id ? " active" : ""}" type="button" data-select-unit="${unit.id}">
              Last known ${getOwnerSideAdjective(state, unit.owner)} ${getUnitDomain(unit.type)}: ${unit.type} (${unit.health}/${unit.maxHealth})
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderSelectedUnit(unitInstance: UnitInstance, state: GameState, fieldUpgradeCurrency: PurchaseCurrency, debugMode: boolean): string {
  const unit = getUnitDefinition(unitInstance.type);
  const unitLevel = getUnitInstanceLevel(state, unitInstance);
  const stats = getEffectiveUnitStats(state, unitInstance.owner, unitInstance.type, unitLevel, unitInstance.coord);
  const levels = unitInstance.owner === "Player" ? state.economy.unitLevels : state.enemyEconomy.unitLevels;
  const queuedMovement = unitInstance.queuedMovement;
  const fieldUpgradeFundsCost = getFieldUnitUpgradeCost(unitInstance.type, unitLevel);
  const fieldUpgradeGainCost = getFieldUnitUpgradeGainCost(unitInstance.type, unitLevel);
  const selectedFieldUpgradeCost = fieldUpgradeCurrency === "gain" ? `${fieldUpgradeGainCost} gain` : `£${fieldUpgradeFundsCost}B`;
  const hasFieldUpgradeAvailable = unitInstance.owner === "Player" && unitLevel < levels[unit.type];
  return `
    <div class="compact-grid">
      <span>Side</span><strong>${getOwnerSideName(state, unitInstance.owner)}</strong>
      <span>Unit</span><strong>${unit.type}</strong>
      ${debugMode ? `<span>ID</span><strong>${unitInstance.id}</strong><span>Mission</span><strong>${getDebugUnitMission(state, unitInstance)}</strong>` : ""}
      <span>Level</span><strong>L${unitLevel}${unitLevel < levels[unit.type] ? ` / L${levels[unit.type]}` : ""}</strong>
      <span>HP</span><strong>${unitInstance.health}/${unitInstance.maxHealth}</strong>
      <span>Move</span><strong>${getRemainingMovementPoints(state, unitInstance)}/${stats.moveRange}</strong>
      <span>Attack</span><strong>${unit.cannotAttack ? "None" : canUnitAttackThisDay(state, unitInstance) ? "Ready" : "Used"}</strong>
      <span>Range</span><strong>${unit.cannotAttack ? "-" : stats.attackRange}</strong>
      <span>Sight</span><strong>${stats.visibilityRange}</strong>
      ${
        queuedMovement
          ? `
            <span>Queued</span><strong>${displayHexId(state.map, queuedMovement.destination)}</strong>
            <span>Moves</span><strong>${getQueuedMovementMoveCount(state, unitInstance)}</strong>
          `
          : ""
      }
    </div>
    ${
      hasFieldUpgradeAvailable
        ? `
          ${renderPurchaseCurrencyToggle("field-upgrade", fieldUpgradeCurrency)}
          <button class="text-button wide" type="button" data-upgrade-unit="${unitInstance.id}" data-upgrade-currency="${fieldUpgradeCurrency}">Upgrade Field Unit (${selectedFieldUpgradeCost})</button>
        `
        : ""
    }
    ${
      queuedMovement && unitInstance.owner === "Player"
        ? `<button class="text-button wide" type="button" data-cancel-movement="${unitInstance.id}">Cancel Movement</button>`
        : ""
    }
  `;
}

function getDebugUnitMission(state: GameState, unit: UnitInstance): string {
  return state.debugUnitMissions?.[unit.id] ?? (unit.owner === "Player" ? "Player command" : "Unassigned");
}

function canPlayerInspectUnit(state: GameState, unit: UnitInstance): boolean {
  return unit.owner === "Player" || state.fog[hexId(unit.coord)] === "visible" || Boolean(state.debugOptions?.showAiUnits);
}

function getPlayerSpottedUnitsAt(state: GameState, coord: UnitInstance["coord"]): SpottedUnit[] {
  return Object.values(state.spottedUnits?.Player ?? {}).filter((spottedUnit) => {
    const currentUnit = state.units.find((unit) => unit.id === spottedUnit.id);
    return sameHex(spottedUnit.coord, coord) && !(currentUnit && state.fog[hexId(currentUnit.coord)] === "visible");
  });
}

function screenTitle(screen: Screen): string {
  if (screen === "production") {
    return "Production";
  }
  if (screen === "research") {
    return "Research";
  }
  if (screen === "help") {
    return "Help";
  }
  if (screen === "welcome") {
    return "Welcome";
  }
  if (screen === "menu") {
    return "Menu";
  }
  return "Map";
}
