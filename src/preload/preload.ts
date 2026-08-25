import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("assurance", {
  appName: "Assurance",
  files: {
    saveTextAs(payload: unknown): Promise<unknown> {
      return ipcRenderer.invoke("assurance:files:saveTextAs", payload);
    }
  },
  saves: {
    list(): unknown {
      return ipcRenderer.sendSync("assurance:saves:list");
    },
    load(id: string): unknown {
      return ipcRenderer.sendSync("assurance:saves:load", id);
    },
    save(payload: unknown): unknown {
      return ipcRenderer.sendSync("assurance:saves:save", payload);
    },
    saveAs(payload: unknown): Promise<unknown> {
      return ipcRenderer.invoke("assurance:saves:saveAs", payload);
    },
    loadFile(): Promise<unknown> {
      return ipcRenderer.invoke("assurance:saves:loadFile");
    }
  }
});
