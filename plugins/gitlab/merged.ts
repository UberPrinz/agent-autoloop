import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../../protocol/job.ts";
import type { EventInput, Later } from "../../protocol/validate.ts";
import { GitLab } from "./api.ts";
import { loadArtifact } from "./artifacts.ts";
import type { Config, Project } from "./config.ts";
import { readRequests } from "./request.ts";
import { atomicFile, canonical, hash } from "./storage.ts";
import { verifyProjectRemote } from "./trusted-rules.ts";

const positive = (number: number) => Number.isSafeInteger(number) && number > 0;
const subjectOf = (config: Config, projectId: number, iid: number) => `${config.instanceKey}/${projectId}/${iid}`;
const mergedId = (subject: string) => `gitlab:merged:${subject}`;
const linkOf = (config: Config, project: Project, iid: number) =>
  `${config.instanceUrl}/${project.projectPath}/-/merge_requests/${iid}`;

export async function scanMerged(
  config: Config,
  project: Project,
  ruleName: string,
  gl: Pick<GitLab, "list">,
  opened: Set<number>,
  retryUnrouted: boolean,
  post: (event: EventInput) => Promise<{ event: number; duplicate: boolean; routed: string[] }>,
) {
  const root = join(config.dataRoot, "gitlab");
  const requests = join(root, "requests", String(project.id));
  if (!existsSync(requests)) return;
  const scope = hash(canonical([config.hubUrl, config.instanceKey, config.instanceUrl, project.projectPath, ruleName]));
  const candidates = new Map<number, { file: string; previous?: number }>();
  for (const name of readdirSync(requests)) {
    if (!/^[1-9]\d*\.json$/.test(name)) continue;
    const iid = Number(name.slice(0, -5));
    if (!positive(iid) || opened.has(iid)) continue;
    const file = join(root, "merged", scope, name);
    const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    if (prior && (prior.routed || !retryUnrouted)) continue;
    if (!readRequests(root, project.id, iid).some((r) => r.instanceKey === config.instanceKey && r.eligible)) continue;
    candidates.set(iid, { file, previous: prior?.event });
  }
  const iids = [...candidates.keys()];
  for (let i = 0; i < iids.length; i += 100) {
    const batch = new Set(iids.slice(i, i + 100));
    const filter = [...batch].map((iid) => `&iids%5B%5D=${iid}`).join("");
    const items = (await gl.list(`projects/${project.id}/merge_requests?state=merged${filter}`)) as {
      iid: number;
      state: string;
    }[];
    for (const mr of items) {
      if (mr?.state !== "merged" || !batch.delete(mr.iid)) continue;
      const { file, previous } = candidates.get(mr.iid)!;
      const subject = subjectOf(config, project.id, mr.iid);
      const receipt = await post({
        id: mergedId(subject) + (previous === undefined ? "" : `:${previous}`),
        type: `mr.review.${project.id}`,
        subject,
        summary: "核对合入后仍待处理的审查卡片",
        detail: "",
        hops: 0,
        link: linkOf(config, project, mr.iid),
      });
      if (!positive(receipt.event) || typeof receipt.duplicate !== "boolean" || !Array.isArray(receipt.routed))
        throw new Error("中台回执无效");
      const routed = receipt.routed.length === 1 && receipt.routed[0] === ruleName;
      atomicFile(file, JSON.stringify({ event: receipt.event, routed }));
      if (!routed) throw new Error("合入结案未路由到项目审查规则，修复后使用 --retry-unrouted");
    }
  }
}

function reviewCard(card: Job["context"]["open"][number], config: Config, project: Project, iid: number) {
  if (
    card.title !== "确认发布审查评论" &&
    card.title !== "未发现问题，仍需人工审核" &&
    !/^(?:待确认：发布 [1-9]\d* 条审查评论|审查结果 [1-9]\d*\/[1-9]\d*)$/.test(card.title)
  )
    return false;
  const link = linkOf(config, project, iid);
  const lines = card.text.split("\n", 4);
  if (
    lines[0] === link ||
    (lines[0] === `仓库：${project.projectPath}` && lines[1] === `MR：!${iid}` && lines[3] === link)
  )
    return true;
  if (card.about) {
    try {
      const binding = JSON.parse(card.about);
      if (binding.schema !== 1 || binding.kind !== "publish") return false;
      const root = join(config.dataRoot, "gitlab");
      const manifest = loadArtifact(root, "manifests", binding.manifestHash) as { reportHash: string };
      const report = loadArtifact(root, "reports", manifest.reportHash) as {
        projectId: number;
        mrIid: number;
        instanceUrl?: string;
        projectPath?: string;
      };
      return (
        report.projectId === project.id &&
        report.mrIid === iid &&
        (report.instanceUrl === undefined || report.instanceUrl === config.instanceUrl) &&
        (report.projectPath === undefined || report.projectPath === project.projectPath)
      );
    } catch {
      return false;
    }
  }
  return (
    card.title === "确认发布审查评论" && new RegExp(`^MR ${project.id}/${iid}，版本 [a-f0-9]{40}，`).test(card.text)
  );
}

const mergeTimer = "gitlab:merged";
export async function resolveMerged(config: Config, context: Job["context"]) {
  const subjects = new Set<string>();
  for (const event of context.events) {
    if (event.source !== "gitlab") continue;
    const id = mergedId(event.subject);
    if (event.id === id || (event.id.startsWith(id + ":") && /^[1-9]\d*$/.test(event.id.slice(id.length + 1)))) {
      const projectId = event.subject.split("/")[1];
      if (event.type === `mr.review.${projectId}`) subjects.add(event.subject);
    }
  }
  for (const timer of context.timers ?? []) {
    if (timer.key.startsWith(mergeTimer + ":")) {
      for (const subject of timer.about.split("\n")) subjects.add(subject);
    }
  }
  const resolve: { card: number; reason: string }[] = [];
  const later: Later[] = [];
  if (!subjects.size || !context.open?.length) return { resolve, later };
  const gl = new GitLab(config.glabPath, config.instanceUrl);
  const user = (await gl.get("user")) as { id?: number };
  if (user?.id !== config.reviewerId) throw new Error("GitLab 登录身份与配置不符");
  const remaining: string[] = [];
  const resolved = new Set<number>();
  for (const subject of subjects) {
    const [, projectId, number] = subject.split("/");
    const iid = Number(number);
    const project = config.projects.find((p) => String(p.id) === projectId);
    if (!project || !positive(iid) || subject !== subjectOf(config, project.id, iid)) continue;
    const cards = context.open.filter((card) => !resolved.has(card.card) && reviewCard(card, config, project, iid));
    if (!cards.length) continue;
    await verifyProjectRemote(gl, project);
    const mr = (await gl.get(`projects/${project.id}/merge_requests/${iid}`)) as { iid?: number; state?: string };
    if (mr?.iid !== iid || mr.state !== "merged") continue;
    const available = 50 - resolve.length;
    for (const { card } of cards.slice(0, available)) {
      resolve.push({ card, reason: `GitLab 显示 MR !${iid} 已合入` });
      resolved.add(card);
    }
    if (cards.length > available) remaining.push(subject);
  }
  for (let i = 0; i < remaining.length; i += 50)
    later.push({
      key: `${mergeTimer}:${i}`,
      at: new Date().toISOString(),
      about: remaining.slice(i, i + 50).join("\n"),
    });
  return { resolve, later };
}
