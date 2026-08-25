import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const tempDir = join(tmpdir(), `assurance-ai-behavior-${process.pid}-${Date.now()}`);
const bundlePath = join(tempDir, "ai-behavior-scenarios.mjs");

async function runNode(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: resolve("."),
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function chunkIndexes(checkCount, workerCount) {
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < checkCount; index += 1) {
    chunks[index % workerCount].push(index);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function getWorkerCount(checkCount) {
  const requested = Number(process.env.AI_BEHAVIOR_WORKERS);
  if (Number.isInteger(requested) && requested > 0) {
    return Math.min(requested, checkCount);
  }

  return Math.min(4, checkCount, Math.max(1, cpus().length - 1));
}

try {
  const result = await build({
    entryPoints: [resolve("scripts/ai-behavior-scenarios.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent"
  });

  await mkdir(tempDir, { recursive: true });
  await writeFile(bundlePath, result.outputFiles[0].text, "utf8");

  const listResult = await runNode({ AI_BEHAVIOR_LIST_CHECKS: "1" });
  if (listResult.code !== 0) {
    throw new Error(`Failed to list AI behavior checks.\n${listResult.stderr || listResult.stdout}`);
  }

  const checks = JSON.parse(listResult.stdout);
  const chunks = chunkIndexes(checks.length, getWorkerCount(checks.length));
  const results = await Promise.all(
    chunks.map((chunk, workerIndex) =>
      runNode({
        AI_BEHAVIOR_CHECKS: chunk.join(","),
        AI_BEHAVIOR_WORKER: String(workerIndex + 1)
      })
    )
  );
  const failed = results.find((workerResult) => workerResult.code !== 0);
  if (failed) {
    throw new Error(failed.stderr || failed.stdout || "AI behavior worker failed without output.");
  }

  console.log("AI behavior checks passed.");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
