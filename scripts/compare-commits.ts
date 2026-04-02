/**
 * Compare wall-clock time for two git refs in this repo (same pipeline each time).
 *
 *   bun run compare-commits -- --base HEAD~1 --target HEAD --measure test
 *   bun run compare-commits -- --base abc123 --target def456 --measure build
 *
 * Env (optional, overridden by CLI flags):
 *   COMPARE_COMMIT_BASE, COMPARE_COMMIT_TARGET, COMPARE_GSTACK_MEASURE (test|build)
 *
 * measure=test:  bun install + playwright chromium + ./setup --host codex + bun run test
 * measure=build: bun install + bun run build
 */

import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type MeasureMode = "test" | "build";

function getRepoRoot(): string {
  const cwd = process.cwd();
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error("Not a git repository (git rev-parse --show-toplevel failed)");
  }
  return r.stdout.trim();
}

function resolveRefToSha(repoRoot: string, ref: string, label: string): string {
  const r = spawnSync("git", ["rev-parse", ref], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`${label}: git rev-parse ${ref} failed`);
  }
  return r.stdout.trim();
}

function runSync(
  cmd: string,
  args: string[],
  cwd: string,
  label: string
): void {
  process.stdout.write(`\n── ${label}: ${cmd} ${args.join(" ")} ──\n`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: process.env.CI || "true" },
  });
  const code = r.status ?? 1;
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}`);
  }
}

function ensureSetupExecutable(repoRoot: string): void {
  const setupPath = path.join(repoRoot, "setup");
  if (!existsSync(setupPath)) {
    throw new Error(`No ./setup in ${repoRoot}`);
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(setupPath, 0o755);
    } catch {
      // ignore
    }
  }
}

function parseArgs(): { base: string; target: string; measure: MeasureMode } {
  let base = process.env.COMPARE_COMMIT_BASE?.trim() || "HEAD~1";
  let target = process.env.COMPARE_COMMIT_TARGET?.trim() || "HEAD";
  let measure: MeasureMode =
    process.env.COMPARE_GSTACK_MEASURE?.trim().toLowerCase() === "build"
      ? "build"
      : "test";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" && argv[i + 1]) {
      base = argv[++i];
      continue;
    }
    if (a === "--target" && argv[i + 1]) {
      target = argv[++i];
      continue;
    }
    if (a === "--measure" && argv[i + 1]) {
      measure = argv[++i] === "build" ? "build" : "test";
      continue;
    }
  }
  return { base, target, measure };
}

function measureCommit(options: {
  repoRoot: string;
  ref: string;
  label: string;
  measure: MeasureMode;
}): { ms: number; sha: string } {
  const { repoRoot, ref, label, measure } = options;

  process.stdout.write(`\n======== ${label} (${ref}) ========\n`);

  const t0 = performance.now();

  runSync("git", ["checkout", "--detach", ref], repoRoot, `${label}: git checkout`);

  const rev = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (rev.status !== 0 || !rev.stdout) {
    throw new Error(`${label}: git rev-parse failed`);
  }
  const sha = rev.stdout.trim();

  runSync("bun", ["install"], repoRoot, `${label}: bun install`);

  if (measure === "test") {
    runSync(
      "bunx",
      ["playwright", "install", "--with-deps", "chromium"],
      repoRoot,
      `${label}: playwright install chromium`
    );
    ensureSetupExecutable(repoRoot);
    runSync("bash", ["./setup", "--host", "codex"], repoRoot, `${label}: ./setup --host codex`);
    runSync("bun", ["run", "test"], repoRoot, `${label}: bun run test`);
  } else {
    runSync("bun", ["run", "build"], repoRoot, `${label}: bun run build`);
  }

  const ms = performance.now() - t0;
  process.stdout.write(
    `\n[${label}] commit=${sha.slice(0, 7)} total wall time (${measure} path): ${ms.toFixed(2)} ms\n`
  );
  return { ms, sha };
}

function main(): void {
  const repoRoot = getRepoRoot();
  const { base: baseRef, target: targetRef, measure } = parseArgs();

  process.stdout.write(`compare-commits — repo=${repoRoot}\n`);
  process.stdout.write(`BASE=${baseRef} TARGET=${targetRef} MEASURE=${measure}\n`);

  const baseSha = resolveRefToSha(repoRoot, baseRef, "BASE ref");
  const targetSha = resolveRefToSha(repoRoot, targetRef, "TARGET ref");

  const first = measureCommit({
    repoRoot,
    ref: baseSha,
    label: "BASE",
    measure,
  });

  const second = measureCommit({
    repoRoot,
    ref: targetSha,
    label: "TARGET",
    measure,
  });

  const delta = second.ms - first.ms;
  process.stdout.write("\n======== SUMMARY ========\n");
  process.stdout.write(
    `Measure: ${measure} (${measure === "test" ? "install + playwright + setup + test" : "install + build"})\n`
  );
  process.stdout.write(
    `BASE (${baseRef}) ${first.sha.slice(0, 7)}: ${first.ms.toFixed(2)} ms\n`
  );
  process.stdout.write(
    `TARGET (${targetRef}) ${second.sha.slice(0, 7)}: ${second.ms.toFixed(2)} ms\n`
  );
  process.stdout.write(
    `Delta (TARGET − BASE): ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ms\n`
  );
}

main();
