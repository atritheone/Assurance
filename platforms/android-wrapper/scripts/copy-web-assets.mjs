import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wrapperDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(wrapperDir, "..", "..");
const sourceDir = resolve(repoRoot, "dist", "renderer");
const targetDir = resolve(wrapperDir, "www");
const androidAssetsDir = resolve(wrapperDir, "android-assets");
const androidTargetDir = resolve(targetDir, "android");
const indexPath = resolve(targetDir, "index.html");
const soundDir = resolve(repoRoot, "build", "sound");
const soundNames = [
  "attritiondeath",
  "destruction",
  "enemybarrierdown",
  "enemygatecapture",
  "gameover",
  "hit",
  "miss",
  "movement",
  "newinventoryunit",
  "placement",
  "playerbarrierdown",
  "playergatecapture",
  "victory"
];

await assertDirectory(sourceDir);
await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
await cp(androidAssetsDir, androidTargetDir, { recursive: true });
await writeAndroidSoundBase64();
await injectAndroidAssets(indexPath);
await patchAndroidRendererBundle();

console.log(`Copied ${sourceDir} to ${targetDir}`);

async function assertDirectory(path) {
  try {
    const stats = await stat(path);
    if (stats.isDirectory()) {
      return;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(`Missing renderer build at ${path}. Run "npm run build" from the repository root first.`);
}

async function injectAndroidAssets(path) {
  let html = await readFile(path, "utf8");
  const saveBridgeScript = '    <script src="./android/android-save-bridge.js"></script>';
  const soundScript = '    <script src="./android/sound-base64.js"></script>';
  const cssLink = '    <link rel="stylesheet" href="./android/android-shell.css" />';
  const jsScript = '    <script type="module" src="./android/android-shell.js"></script>';

  if (!html.includes(saveBridgeScript)) {
    html = html.replace("</head>", `${saveBridgeScript}\n  </head>`);
  }

  if (!html.includes(soundScript)) {
    html = html.replace("</head>", `${soundScript}\n  </head>`);
  }

  if (!html.includes(cssLink)) {
    html = html.replace("</head>", `${cssLink}\n  </head>`);
  }

  if (!html.includes(jsScript)) {
    html = html.replace("</body>", `${jsScript}\n  </body>`);
  }

  await writeFile(path, html, "utf8");
}

async function writeAndroidSoundBase64() {
  const soundBase64 = await readSoundBase64();
  const source = `window.__ASSURANCE_SOUND_BASE64__=${JSON.stringify(soundBase64)};\n`;
  await writeFile(resolve(androidTargetDir, "sound-base64.js"), source, "utf8");
}

async function readSoundBase64() {
  return Object.fromEntries(
    await Promise.all(
      soundNames.map(async (name) => {
        const base64 = (await readFile(resolve(soundDir, `${name}.wav`))).toString("base64");
        return [name, base64];
      })
    )
  );
}

async function patchAndroidRendererBundle() {
  const assetsDir = resolve(targetDir, "assets");
  const files = await readdir(assetsDir);
  const jsFiles = files.filter((file) => file.endsWith(".js"));
  let patched = false;

  for (const file of jsFiles) {
    const path = resolve(assetsDir, file);
    let source = await readFile(path, "utf8");
    if (!source.includes("const MIN_HEX_SIZE = 16;")) {
      continue;
    }

    source = source.replace("const MIN_HEX_SIZE = 16;", "const MIN_HEX_SIZE = 10;");
    await writeFile(path, source, "utf8");
    patched = true;
  }

  if (!patched) {
    throw new Error("Could not patch Android map zoom limit. Expected renderer bundle to contain MIN_HEX_SIZE.");
  }
}
