import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicFile, hash } from "./storage.ts";
import { TemporaryError, diagnostic } from "./errors.ts";
import type { Job } from "../../protocol/job.ts";
import type { Result } from "../../protocol/validate.ts";

type Receipt = Pick<Result, "ask" | "notice" | "resolve">;
type Options = {
  root: string;
  instance: string;
  task: string;
  label?: string;
  kind: "gitlab" | "feishu-review";
  open: Job["context"]["open"];
  now?: number;
};

export function scanIdentity(configFile: string) {
  const file = process.env.AGENT_AUTOLOOP_CONTEXT;
  const context = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const entryFile = file ? join(dirname(file), "entry.json") : "";
  const rule = entryFile && existsSync(entryFile) ? JSON.parse(readFileSync(entryFile, "utf8")).job?.rule?.name : "";
  return {
    task: hash(`${configFile}:${rule || "scan"}`),
    label: rule || basename(configFile),
    open: context.open ?? [],
  };
}

export async function scanHealth(options: Options, work: () => Promise<Receipt>): Promise<Receipt> {
  const { root, instance, task, kind, open } = options;
  const now = options.now ?? Date.now();
  const file = join(root, kind, "health", instance, `${task}.json`);
  const title = `${kind === "gitlab" ? "GitLab" : "飞书"}扫描连接中断：${options.label ?? task}`;
  // context.open contains only cards the current run may resolve, but does not expose card keys.
  const cards = open.filter((card) => card.title === title);
  let receipt: Receipt;
  try {
    receipt = await work();
  } catch (error) {
    if (!(error instanceof TemporaryError)) throw error;
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const state = {
      firstFailureAt: previous?.firstFailureAt ?? now,
      count: (previous?.count ?? 0) + 1,
      reason: diagnostic(error.message),
    };
    atomicFile(file, JSON.stringify(state));
    console.log(`本轮扫描结束，等待下次定时重试：${state.reason}`);
    const minutes = Math.floor((now - state.firstFailureAt) / 60_000);
    return minutes >= 30 && !cards.length
      ? {
          notice: [
            {
              key: `${kind}:scan-outage`,
              title,
              text: `扫描连接已中断 ${minutes} 分钟。最近原因：${state.reason}\n恢复后自动关闭。`,
            },
          ],
        }
      : { ask: [] };
  }
  rmSync(file, { force: true });
  return {
    ...receipt,
    ...(cards.length
      ? {
          resolve: [
            ...(receipt.resolve ?? []),
            ...cards.map((card) => ({
              card: card.card,
              reason: `扫描已恢复，核实时间：${new Date(now).toISOString()}`,
            })),
          ],
        }
      : {}),
  };
}
