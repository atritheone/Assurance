import { build } from "esbuild";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

async function findTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return findTestFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
    })
  );
  return files.flat();
}

const testRoot = resolve("tests");
const entryPoints = await findTestFiles(testRoot);
if (entryPoints.length === 0) {
  console.log("No TypeScript tests found.");
  process.exit(0);
}

const outdir = await mkdtemp(join(tmpdir(), "assurance-ts-tests-"));
try {
  await build({
    entryPoints,
    bundle: true,
    format: "esm",
    platform: "node",
    outdir,
    outbase: testRoot,
    sourcemap: "inline",
    logLevel: "silent"
  });

  const compiledTests = entryPoints.map((entry) => join(outdir, relative(testRoot, entry).replace(/\.ts$/, ".js")));
  const result = await new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["--test", ...compiledTests], {
      stdio: "inherit"
    });
    child.on("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.signal) {
    throw new Error(`node --test exited with signal ${result.signal}`);
  }
  process.exitCode = result.code ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}
