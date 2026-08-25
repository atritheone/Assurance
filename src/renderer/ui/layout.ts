export interface LayoutElements {
  welcomeOverlay: HTMLElement;
  welcomeLoadList: HTMLElement;
  blockingOverlay: HTMLElement;
  blockingModal: HTMLElement;
  blockingMessage: HTMLElement;
  topBrand: HTMLElement;
  topStatus: HTMLElement;
  leftPanel: HTMLElement;
  rightPanel: HTMLElement;
  centerTitle: HTMLElement;
  centerContent: HTMLElement;
  mapFrame: HTMLElement;
  mapUnitSelector: HTMLElement;
  mapSelection: HTMLElement;
  endTurnButton: HTMLButtonElement;
  eventLog: HTMLElement;
  canvas: HTMLCanvasElement;
}

export function getLayoutElements(): LayoutElements {
  return {
    welcomeOverlay: getElement("welcomeOverlay"),
    welcomeLoadList: getElement("welcomeLoadList"),
    blockingOverlay: getElement("blockingOverlay"),
    blockingModal: getElement("blockingModal"),
    blockingMessage: getElement("blockingMessage"),
    topBrand: getElement("topBrand"),
    topStatus: getElement("topStatus"),
    leftPanel: getElement("leftPanel"),
    rightPanel: getElement("rightPanel"),
    centerTitle: getElement("centerTitle"),
    centerContent: getElement("centerContent"),
    mapFrame: getElement("mapFrame"),
    mapUnitSelector: getElement("mapUnitSelector"),
    mapSelection: getElement("mapSelection"),
    endTurnButton: getButton("endTurnButton"),
    eventLog: getElement("eventLog"),
    canvas: getCanvas("hexMapCanvas")
  };
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function getCanvas(id: string): HTMLCanvasElement {
  const element = getElement(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`Missing canvas: ${id}`);
  }
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${id}`);
  }
  return element;
}
