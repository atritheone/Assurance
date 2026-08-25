(function () {
  const SAVE_INDEX_KEY = "assurance.android.saves.v1";
  const LEGACY_SAVE_INDEX_KEY = "assurance.saves.v2";
  const LEGACY_SAVE_KEY = "assurance.save.v1";
  const MAX_SAVES = 8;
  let nextLoadId = null;

  function readSavesFrom(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(isStoredSave) : [];
    } catch {
      return [];
    }
  }

  function readLegacySingleSave() {
    try {
      const raw = localStorage.getItem(LEGACY_SAVE_KEY);
      if (!raw) {
        return [];
      }

      const state = JSON.parse(raw);
      const savedAt = new Date().toISOString();
      return [{
        id: "legacy-save",
        name: `Day ${Number(state.day ?? 0)} - Legacy Save`,
        day: Number(state.day ?? 0),
        savedAt,
        timestamp: savedAt.replace(/\D/g, "").slice(2, 14),
        state
      }];
    } catch {
      return [];
    }
  }

  function readSaves() {
    const byId = new Map();
    for (const save of [...readSavesFrom(SAVE_INDEX_KEY), ...readSavesFrom(LEGACY_SAVE_INDEX_KEY), ...readLegacySingleSave()]) {
      byId.set(save.id, save);
    }

    return [...byId.values()].sort((first, second) => Date.parse(second.savedAt) - Date.parse(first.savedAt));
  }

  function writeSaves(saves) {
    const trimmed = saves.slice(0, MAX_SAVES);
    try {
      localStorage.setItem(SAVE_INDEX_KEY, JSON.stringify(trimmed));
      return trimmed;
    } catch {
      const latestOnly = trimmed.slice(0, 1);
      localStorage.setItem(SAVE_INDEX_KEY, JSON.stringify(latestOnly));
      return latestOnly;
    }
  }

  function savePayload(payload) {
    if (!isStoredSave(payload)) {
      return null;
    }

    const saves = readSaves().filter((save) => save.id !== payload.id);
    saves.unshift(payload);
    writeSaves(saves);
    return toSummary(payload);
  }

  function toSummary(save) {
    return {
      id: save.id,
      name: save.name,
      day: save.day,
      savedAt: save.savedAt
    };
  }

  function isStoredSave(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.savedAt === "string" &&
      typeof value.day === "number" &&
      value.state &&
      typeof value.state === "object"
    );
  }

  const androidSaves = {
    list() {
      return readSaves().map(toSummary);
    },
    load(id) {
      return readSaves().find((save) => save.id === id)?.state ?? null;
    },
    save(payload) {
      return savePayload(payload);
    },
    async saveAs(payload) {
      return savePayload(payload);
    },
    async loadFile() {
      const saves = readSaves();
      const selected = nextLoadId ? saves.find((save) => save.id === nextLoadId) : saves[0];
      nextLoadId = null;
      return selected?.state ?? null;
    },
    __setNextLoadId(id) {
      nextLoadId = id;
    }
  };

  window.assurance = {
    ...(window.assurance ?? {}),
    saves: androidSaves
  };
})();
