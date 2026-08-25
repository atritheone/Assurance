import type { GameState } from "../game/types";

const SAVE_KEY = "assurance.save.v1";
const SAVE_INDEX_KEY = "assurance.saves.v2";
const SAVE_FILE_EXTENSION = ".json";
const AE_EPOCH_YEAR = 2020;

export interface StoredSaveSummary {
  id: string;
  name: string;
  day: number;
  savedAt: string;
}

interface StoredSave extends StoredSaveSummary {
  timestamp: string;
  state: GameState;
}

interface SaveBridge {
  list(): unknown;
  load(id: string): unknown;
  save(payload: StoredSave): unknown;
  saveAs?(payload: StoredSave): Promise<unknown>;
  loadFile?(): Promise<unknown>;
}

interface AssuranceApi {
  appName: string;
  saves?: SaveBridge;
}

export function serializeState(state: GameState): string {
  return JSON.stringify(state, null, 2);
}

export function deserializeState(serialized: string): GameState {
  return JSON.parse(serialized) as GameState;
}

export async function saveGameStub(state: GameState): Promise<string> {
  return serializeState(state);
}

export async function loadGameStub(serialized: string): Promise<GameState> {
  return deserializeState(serialized);
}

export function saveStoredGame(state: GameState): void {
  saveNamedGame(state);
}

export function loadStoredGame(): GameState | null {
  const latestId = getLatestSaveId();
  return latestId ? loadNamedGame(latestId) : null;
}

export function hasStoredGame(): boolean {
  return listStoredGames().length > 0 || (!getSaveBridge() && localStorage.getItem(SAVE_KEY) !== null);
}

export function saveNamedGame(state: GameState): StoredSaveSummary {
  const save = createSavePayload(state);
  const bridge = getSaveBridge();
  if (bridge) {
    return normalizeSummary(bridge.save(save)) ?? toSummary(save);
  }

  const saves = readLocalSaves().filter((candidate) => candidate.id !== save.id);
  saves.unshift(save);
  writeLocalSaves(saves.slice(0, 20));
  return toSummary(save);
}

export async function saveNamedGameAs(state: GameState): Promise<StoredSaveSummary | null> {
  const save = createSavePayload(state);
  const bridge = getSaveBridge();
  if (bridge?.saveAs) {
    return normalizeSummary(await bridge.saveAs(save));
  }

  const saves = readLocalSaves().filter((candidate) => candidate.id !== save.id);
  saves.unshift(save);
  writeLocalSaves(saves.slice(0, 20));
  return toSummary(save);
}

export function listStoredGames(): StoredSaveSummary[] {
  const bridge = getSaveBridge();
  if (bridge) {
    return normalizeSummaryList(bridge.list());
  }

  return readLocalSaves().map(toSummary);
}

export function loadNamedGame(id: string): GameState | null {
  const bridge = getSaveBridge();
  if (bridge) {
    return normalizeGameState(bridge.load(id));
  }

  return readLocalSaves().find((candidate) => candidate.id === id)?.state ?? null;
}

export async function loadGameFromFile(): Promise<GameState | null> {
  const bridge = getSaveBridge();
  if (bridge?.loadFile) {
    return normalizeGameState(await bridge.loadFile());
  }

  const latestId = getLatestSaveId();
  return latestId ? loadNamedGame(latestId) : null;
}

export function getLatestSaveId(): string | null {
  return listStoredGames()[0]?.id ?? null;
}

function getSaveBridge(): SaveBridge | undefined {
  return (window as Window & { assurance?: AssuranceApi }).assurance?.saves;
}

function readLocalSaves(): StoredSave[] {
  const raw = localStorage.getItem(SAVE_INDEX_KEY);
  if (!raw) {
    return migrateLegacySave();
  }

  try {
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed) ? parsed.map(normalizeStoredSave).filter((save): save is StoredSave => Boolean(save)) : [];
  } catch {
    return [];
  }
}

function writeLocalSaves(saves: StoredSave[]): void {
  localStorage.setItem(SAVE_INDEX_KEY, JSON.stringify(saves));
}

function migrateLegacySave(): StoredSave[] {
  const legacy = localStorage.getItem(SAVE_KEY);
  if (!legacy) {
    return [];
  }

  const state = deserializeState(legacy);
  const save = createSavePayload(state, "legacy-save");
  writeLocalSaves([save]);
  return [save];
}

function createSavePayload(state: GameState, legacyId?: string): StoredSave {
  const savedAt = new Date().toISOString();
  const timestamp = formatAeFileTimestamp(savedAt);
  return {
    id: legacyId ?? `${timestamp}${SAVE_FILE_EXTENSION}`,
    name: `Day ${state.day} - ${formatAeDisplayTimestamp(savedAt)}`,
    day: state.day,
    savedAt,
    timestamp,
    state
  };
}

function toSummary(save: StoredSave): StoredSaveSummary {
  return {
    id: save.id,
    name: save.name,
    day: save.day,
    savedAt: save.savedAt
  };
}

function normalizeStoredSave(value: unknown): StoredSave | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredSave> & { serializedState?: string };
  if (candidate.state && candidate.id && candidate.name && candidate.savedAt && typeof candidate.day === "number") {
    return {
      id: candidate.id,
      name: candidate.name,
      day: candidate.day,
      savedAt: candidate.savedAt,
      timestamp: candidate.timestamp ?? formatAeFileTimestamp(candidate.savedAt),
      state: candidate.state
    };
  }

  if (candidate.serializedState && candidate.id && candidate.name && candidate.savedAt && typeof candidate.day === "number") {
    return {
      id: candidate.id,
      name: candidate.name,
      day: candidate.day,
      savedAt: candidate.savedAt,
      timestamp: candidate.timestamp ?? formatAeFileTimestamp(candidate.savedAt),
      state: deserializeState(candidate.serializedState)
    };
  }

  return null;
}

function normalizeSummary(value: unknown): StoredSaveSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredSaveSummary>;
  return candidate.id && candidate.name && candidate.savedAt && typeof candidate.day === "number"
    ? {
        id: candidate.id,
        name: candidate.name,
        day: candidate.day,
        savedAt: candidate.savedAt
      }
    : null;
}

function normalizeSummaryList(value: unknown): StoredSaveSummary[] {
  return Array.isArray(value) ? value.map(normalizeSummary).filter((summary): summary is StoredSaveSummary => Boolean(summary)) : [];
}

function normalizeGameState(value: unknown): GameState | null {
  return value && typeof value === "object" ? (value as GameState) : null;
}

function formatAeFileTimestamp(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => part.toString().padStart(2, "0");
  const aeYear = Math.max(0, date.getFullYear() - AE_EPOCH_YEAR);
  return `${aeYear.toString().padStart(3, "0")}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatAeDisplayTimestamp(value: string): string {
  const date = new Date(value);
  const timestamp = formatAeFileTimestamp(value).slice(3);
  return `${Math.max(0, date.getFullYear() - AE_EPOCH_YEAR)}AE${timestamp}`;
}
