import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererDir = resolve(rootDir, "dist", "renderer");
const inputHtmlPath = resolve(rendererDir, "index.html");
const outputHtmlPath = resolve(rootDir, "dist", "assurance-standalone.html");
const faviconPath = resolve(rootDir, "build", "icon.ico");
const soundDir = resolve(rootDir, "build", "sound");
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

let html = await readFile(inputHtmlPath, "utf8");
const faviconBase64 = (await readFile(faviconPath)).toString("base64");
const soundBase64 = await readSoundBase64();

html = await inlineStyles(html);
html = await inlineScripts(html);
html = inlineFavicon(html, faviconBase64);
html = inlineSoundBase64(html, soundBase64);
html = html.replace(/ crossorigin/g, "");

await writeFile(outputHtmlPath, html, "utf8");
console.log(`Standalone file written to ${outputHtmlPath}`);

async function inlineStyles(source) {
  return replaceAsync(
    source,
    /<link\s+rel="stylesheet"\s+crossorigin\s+href="\.\/([^"]+)"\s*\/?>/g,
    async (_match, href) => {
      const cssPath = resolve(rendererDir, href);
      const css = await inlineCssAssets(await readFile(cssPath, "utf8"), cssPath);
      return `<style>\n${css}\n</style>`;
    }
  );
}

async function inlineCssAssets(source, cssPath) {
  return replaceAsync(
    source,
    /url\((["']?)(?!data:)([^"')]+?\.(?:ttf|otf|woff2?|eot))\1\)/g,
    async (_match, _quote, assetPath) => {
      const absolutePath = resolveCssAssetPath(cssPath, assetPath);
      const bytes = await readFile(absolutePath);
      return `url("data:${getFontMimeType(assetPath)};base64,${bytes.toString("base64")}")`;
    }
  );
}

function resolveCssAssetPath(cssPath, assetPath) {
  if (assetPath.startsWith("/")) {
    return resolve(rendererDir, `.${assetPath}`);
  }

  return resolve(dirname(cssPath), assetPath);
}

function getFontMimeType(assetPath) {
  if (assetPath.endsWith(".woff2")) {
    return "font/woff2";
  }

  if (assetPath.endsWith(".woff")) {
    return "font/woff";
  }

  if (assetPath.endsWith(".otf")) {
    return "font/otf";
  }

  if (assetPath.endsWith(".eot")) {
    return "application/vnd.ms-fontobject";
  }

  return "font/ttf";
}

async function inlineScripts(source) {
  return replaceAsync(
    source,
    /<script\s+type="module"\s+crossorigin\s+src="\.\/([^"]+)"><\/script>/g,
    async (_match, src) => {
      const js = await readFile(resolve(rendererDir, src), "utf8");
      return `<script type="module">\n${js.replaceAll("</script>", "<\\/script>")}\n</script>`;
    }
  );
}

function inlineFavicon(source, faviconBase64) {
  const faviconLink = `<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,${faviconBase64}" />`;
  if (/<link\s+[^>]*rel=["'](?:shortcut icon|icon)["'][^>]*>/i.test(source)) {
    return source.replace(/<link\s+[^>]*rel=["'](?:shortcut icon|icon)["'][^>]*>/i, faviconLink);
  }

  return source.replace("</head>", `    ${faviconLink}\n  </head>`);
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

function inlineSoundBase64(source, soundBase64) {
  const script = `<script>window.__ASSURANCE_SOUND_BASE64__=${JSON.stringify(soundBase64)};</script>`;
  if (source.includes("</head>")) {
    return source.replace("</head>", `    ${script}\n  </head>`);
  }

  return `${script}\n${source}`;
}

async function replaceAsync(source, pattern, replacer) {
  const replacements = await Promise.all(Array.from(source.matchAll(pattern), (match) => replacer(...match)));
  let index = 0;
  return source.replace(pattern, () => replacements[index++]);
}
