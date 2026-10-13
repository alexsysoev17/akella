import { chromium, type Browser } from "playwright";
import { readFile, readdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { atomicJson, noSymlinkPath, safeDirectory } from "../files.js";
import { motionQA } from "../motion/qa/render.js";
import type { MotionState } from "../motion/schema.js";
import type { IntentTask } from "../motion/intent/compiler.js";
import type { HarnessRun } from "./runtime.js";
import { digest } from "./context.js";
export class RunQA {
  private browser?: Browser;
  constructor(private run: HarnessRun) {}
  async verify(
    task: IntentTask,
    next: MotionState,
    before: MotionState,
    attempt: number,
  ) {
    this.run.checkpoint();
    const start = performance.now();
    const dir = `motion/qa/${this.run.runId}/${task.taskId}-attempt-${attempt}`,
      scope =
        task.kind === "sceneTiming" ||
        task.techniques.some((t) => String(t) === "objectStateTransition")
          ? undefined
          : task.targetReference;
    const key = digest([
      this.run.project.inspection.fingerprint,
      next,
      before,
      scope,
      task.userIntent,
      this.run.references,
    ]);
    const cacheRoot = await safeDirectory(
        this.run.project.root,
        "motion/harness/cache/qa",
      ),
      cacheFile = path.join(cacheRoot, key + ".json");
    if (
      this.run.config.privacy === "full" &&
      this.run.config.qaCacheEntries > 0
    ) {
      try {
        await noSymlinkPath(this.run.project.root, cacheFile);
        const saved = JSON.parse(await readFile(cacheFile, "utf8"));
        await noSymlinkPath(
          this.run.project.root,
          path.join(this.run.project.root, saved.directory),
        );
        await cp(
          path.join(this.run.project.root, saved.directory),
          await safeDirectory(this.run.project.root, dir),
          { recursive: true },
        );
        this.run.cacheHits++;
        this.run.qaDurationMs += performance.now() - start;
        await this.run.record("qa-cache-hit", { key, from: saved.directory });
        return { ...saved.report, cacheHit: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    this.run.cacheMisses++;
    this.browser ??= await chromium.launch({ headless: true });
    const renderStart = performance.now();
    const report = await motionQA(
      this.run.project,
      next,
      dir,
      task.userIntent,
      before,
      scope,
      {
        signal: this.run.signal,
        beforeRender: () => this.run.beforeRender(),
        browser: this.browser,
      },
    );
    this.run.renderDurationMs += performance.now() - renderStart;
    this.run.qaDurationMs += performance.now() - start;
    this.run.checkpoint();
    await this.run.record("motion-qa", {
      taskId: task.taskId,
      directory: dir,
      status: report.status,
      checks: report.checks.map(({ name, status, reason }) => ({
        name,
        status,
        reason,
      })),
      samples: report.samples,
    });
    if (
      report.status !== "FAILED" &&
      this.run.config.privacy === "full" &&
      this.run.config.qaCacheEntries > 0
    ) {
      await atomicJson(cacheFile, { directory: dir, report });
      const files = (await readdir(cacheRoot)).filter((f) =>
        /^[a-f0-9]{64}\.json$/.test(f),
      );
      for (const file of files.slice(
        0,
        Math.max(0, files.length - this.run.config.qaCacheEntries),
      ))
        await rm(path.join(cacheRoot, file), { force: true });
    }
    return report;
  }
  async close() {
    await this.browser?.close();
  }
}
