import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import type { GameState } from "../renderer/game/types";

let mainWindow: BrowserWindow | null = null;
const appUserModelId = "com.slayer.assurance";

app.setName("Assurance");

if (process.platform === "win32") {
  app.setAppUserModelId(appUserModelId);
}

function getAppIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "icon.ico") : join(__dirname, "../../build/icon.ico");
}

interface SaveFilePayload {
  id: string;
  name: string;
  day: number;
  savedAt: string;
  timestamp: string;
  state: GameState;
}

interface SaveFileSummary {
  id: string;
  name: string;
  day: number;
  savedAt: string;
}

interface TextFilePayload {
  defaultFileName: string;
  content: string;
}

function getSaveDirectory(): string {
  return app.getPath("downloads");
}

function ensureSaveDirectory(): string {
  const directory = getSaveDirectory();
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  return directory;
}

function getSavePath(id: string): string {
  return join(ensureSaveDirectory(), basename(id));
}

function readSaveFile(id: string): SaveFilePayload | null {
  try {
    const raw = readFileSync(getSavePath(id), "utf8");
    return JSON.parse(raw) as SaveFilePayload;
  } catch {
    return null;
  }
}

function listSaveFiles(): SaveFileSummary[] {
  return readdirSync(ensureSaveDirectory())
    .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
    .map((fileName) => readSaveFile(fileName))
    .filter((save): save is SaveFilePayload => Boolean(save?.state))
    .map(({ state: _state, timestamp: _timestamp, ...summary }) => summary)
    .sort((first, second) => second.savedAt.localeCompare(first.savedAt));
}

function registerSaveIpc(): void {
  ipcMain.on("assurance:saves:list", (event) => {
    event.returnValue = listSaveFiles();
  });

  ipcMain.on("assurance:saves:load", (event, id: string) => {
    event.returnValue = readSaveFile(id)?.state ?? null;
  });

  ipcMain.on("assurance:saves:save", (event, payload: SaveFilePayload) => {
    writeFileSync(getSavePath(payload.id), JSON.stringify(payload, null, 2), "utf8");
    const { state: _state, timestamp: _timestamp, ...summary } = payload;
    event.returnValue = summary;
  });

  ipcMain.handle("assurance:saves:saveAs", async (_event, payload: SaveFilePayload) => {
    const options: SaveDialogOptions = {
      title: "Save Game",
      defaultPath: join(ensureSaveDirectory(), payload.id),
      filters: [{ name: "Assurance Save Files", extensions: ["json"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    const { state: _state, timestamp: _timestamp, ...summary } = payload;
    return {
      ...summary,
      id: basename(result.filePath)
    };
  });

  ipcMain.handle("assurance:saves:loadFile", async () => {
    const options: OpenDialogOptions = {
      title: "Load Game",
      defaultPath: ensureSaveDirectory(),
      properties: ["openFile"],
      filters: [{ name: "Assurance Save Files", extensions: ["json"] }]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    try {
      const raw = readFileSync(result.filePaths[0], "utf8");
      const parsed = JSON.parse(raw) as SaveFilePayload | GameState;
      return "state" in parsed ? parsed.state : parsed;
    } catch {
      return null;
    }
  });

  ipcMain.handle("assurance:files:saveTextAs", async (_event, payload: TextFilePayload) => {
    const options: SaveDialogOptions = {
      title: "Download Log",
      defaultPath: join(ensureSaveDirectory(), basename(payload.defaultFileName)),
      filters: [{ name: "Text Files", extensions: ["txt"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return false;
    }

    writeFileSync(result.filePath, payload.content, "utf8");
    return true;
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    fullscreen: true,
    resizable: false,
    show: false,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.setFullScreen(true);
    mainWindow?.show();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerSaveIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
