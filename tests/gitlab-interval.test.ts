// Failure modes: a busy MR is reviewed on every push; the newest head is dropped or delayed past the interval;
// a skipped intermediate head is dispatched later; the chat and scan paths each keep their own clock so together they
// dispatch twice inside the interval; the dispatch time is stored before the hub acknowledged it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../plugins/gitlab/scan.ts";
import { parseConfig } from "../plugins/gitlab/config.ts";

const minute = 60_000;
const sha = (c: string) => c.repeat(40);
const policy = "b".repeat(64);
const project = { id: 42, ciMode: "required" as const };
const mr = (head: string, extra = {}) => ({
  iid: 1,
  state: "opened",
  draft: false,
  sha: head,
  reviewers: [{ id: 8 }],
  head_pipeline: null,
  ...extra,
});
// One scanner over memory-backed state, with a clock the test moves by hand. Clock starts at "10:00".
function world(minIntervalMinutes: number) {
  const records: any[] = [];
  const posted: any[] = [];
  const memory = new Map<number, { lastDispatchedAt: number }>();
  const state = { at: 600 * minute, mrs: [mr(sha("a"))] as any[] };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8, minIntervalMinutes };
  const scan = () =>
    scanProject(config, project, "team/project", policy, {
      now: () => state.at,
      interval: {
        read: (iid: number) => memory.get(iid),
        write: (iid: number, value: { lastDispatchedAt: number }) => void memory.set(iid, value),
      },
      list: async () => state.mrs,
      read: () => records.at(-1),
      write: (record: any) => void records.push(record),
      post: async (event: any) => {
        posted.push(event);
        return { event: posted.length, duplicate: false, routed: ["review"] };
      },
    } as any);
  return { state, scan, posted, records, memory };
}

test("the first push of a new MR dispatches immediately and records the dispatch time", async () => {
  const w = world(10);
  await w.scan();
  assert.equal(w.posted.length, 1);
  assert.deepEqual(w.memory.get(1), { lastDispatchedAt: 600 * minute });
});

test("a head pushed inside the interval waits, then the current head goes out once the interval has passed", async () => {
  const w = world(10);
  w.state.at = 605 * minute; // v1 dispatched at 10:05
  await w.scan();
  w.state.at = 610 * minute;
  w.state.mrs = [mr(sha("b"))]; // v2 pushed and seen at 10:10
  await w.scan();
  assert.equal(w.posted.length, 1, "v2 is only 5 minutes after v1");
  assert.equal(w.records.length, 2, "a waiting head leaves no request record (v1: observation + delivered)");
  w.state.at = 615 * minute;
  await w.scan();
  assert.equal(w.posted.length, 2);
  assert.equal(JSON.parse(w.posted[1].detail).headSha, sha("b"));
});

test("three pushes inside the interval dispatch only the latest, on the first scan after the interval; the rest never", async () => {
  const w = world(10);
  await w.scan(); // 10:00 v1
  for (const [at, head] of [
    [602, "b"],
    [604, "c"],
    [606, "d"],
  ] as const) {
    w.state.at = at * minute;
    w.state.mrs = [mr(sha(head))];
    await w.scan();
  }
  assert.equal(w.posted.length, 1);
  w.state.at = 609 * minute + 59_000;
  await w.scan();
  assert.equal(w.posted.length, 1, "one second early");
  w.state.at = 610 * minute;
  await w.scan();
  assert.deepEqual(
    w.posted.map((e) => JSON.parse(e.detail).headSha),
    [sha("a"), sha("d")],
  );
  w.state.at = 700 * minute;
  await w.scan();
  assert.equal(w.posted.length, 2, "skipped heads b and c are never dispatched later");
});

test("minIntervalMinutes 0 dispatches every new head immediately", async () => {
  const w = world(0);
  await w.scan();
  w.state.mrs = [mr(sha("b"))];
  await w.scan();
  assert.equal(w.posted.length, 2);
});

test("an MR merged or closed during the wait is not dispatched", async () => {
  const w = world(10);
  await w.scan();
  w.state.at += 2 * minute;
  w.state.mrs = [mr(sha("b"))];
  await w.scan();
  w.state.at += 20 * minute;
  w.state.mrs = []; // the scan lists opened MRs only, so merged and closed MRs are gone
  await w.scan();
  assert.equal(w.posted.length, 1);
});

test("a delivered head is still skipped, and an ineligible head does not use up the interval", async () => {
  const w = world(10);
  await w.scan();
  w.state.at += 60 * minute;
  await w.scan();
  assert.equal(w.posted.length, 1, "G1: same head, no second dispatch");
  w.state.mrs = [mr(sha("b"), { draft: true })];
  await w.scan();
  assert.equal(w.records.at(-1).eligible, false);
  assert.equal(w.memory.get(1)!.lastDispatchedAt, 600 * minute, "an ineligible record is not a dispatch");
  w.state.mrs = [mr(sha("b"))];
  await w.scan();
  assert.equal(w.posted.length, 2);
});

test("an unreadable dispatch time counts as no recent dispatch", async () => {
  const w = world(10);
  w.records.push({
    schema: 1,
    instanceKey: "work",
    projectId: 42,
    mrIid: 1,
    headSha: sha("z"),
    policyHash: policy,
    eligible: true,
    observation: 1,
    requestId: "d".repeat(64),
    origin: "auto",
    delivered: true,
  });
  await w.scan();
  assert.equal(w.posted.length, 1);
});

test("the dispatch time is written only after the hub acknowledged the event", async () => {
  const w = world(10);
  const scan = scanProject(
    { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8, minIntervalMinutes: 10 },
    project,
    "team/project",
    policy,
    {
      now: () => 600 * minute,
      interval: { read: (iid: number) => w.memory.get(iid), write: (iid: number, v: any) => void w.memory.set(iid, v) },
      list: async () => [mr(sha("a"))],
      read: () => undefined,
      write: () => {},
      post: async () => {
        throw new Error("lost");
      },
    } as any,
  );
  await assert.rejects(scan);
  assert.equal(w.memory.size, 0);
});

test("minIntervalMinutes defaults to 10 and must be a non-negative integer; settleMinutes is gone", () => {
  const input = () => ({
    schema: 1,
    instanceKey: "work",
    instanceUrl: "https://gitlab.example.com",
    reviewerId: 8,
    hubUrl: "http://127.0.0.1:3000",
    sourceKeyPath: "/private/source",
    dataRoot: "/private/data",
    model: "model",
    codexPath: "/bin/codex",
    glabPath: "/bin/glab",
    projects: [{ id: 42, cachePath: "/private/repo.git" }],
  });
  assert.equal((parseConfig(input()) as any).minIntervalMinutes, 10);
  assert.equal((parseConfig({ ...input(), minIntervalMinutes: 0 }) as any).minIntervalMinutes, 0);
  assert.equal((parseConfig({ ...input(), minIntervalMinutes: 30 }) as any).minIntervalMinutes, 30);
  for (const bad of [-1, 1.5, "10", null, Number.NaN, 2 ** 60])
    assert.throws(() => parseConfig({ ...input(), minIntervalMinutes: bad }));
  assert.equal("settleMinutes" in parseConfig(input()), false);
});

test("chat and scan share one dispatch time per MR; the terminal path never waits but still records", async () => {
  const root = mkdtempSync(join(tmpdir(), "interval-manual-"));
  process.env.AGENT_AUTOLOOP_HOME = root;
  process.env.AGENT_AUTOLOOP_RULES = join(root, "rules.json");
  const events: any[] = [];
  let acknowledge = true;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (!acknowledge) return void res.writeHead(503).end();
    events.push(JSON.parse(text));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ event: events.length, duplicate: false, routed: ["rule"] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const bare = join(root, "cache.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", bare, "remote", "add", "origin", "https://gitlab.example.com/team/repo.git"]);
    const mrFile = join(root, "mr.json");
    const glab = join(root, "glab.cjs");
    const write = (head: string, extra = {}) =>
      writeFileSync(mrFile, JSON.stringify({ ...mr(head), iid: 7, reviewers: [], ...extra }));
    write(sha("a"));
    writeFileSync(
      glab,
      `#!/usr/bin/env node\nconst p=process.argv[3];console.log(JSON.stringify(p==='user'?{id:8}:p==='projects/42'?{id:42,path_with_namespace:'team/repo',http_url_to_repo:'https://gitlab.example.com/team/repo.git'}:JSON.parse(require('fs').readFileSync(${JSON.stringify(mrFile)}))));`,
      { mode: 0o700 },
    );
    writeFileSync(join(root, "key"), "secret", { mode: 0o600 });
    const configFile = join(root, "gitlab.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        schema: 1,
        instanceKey: "work",
        instanceUrl: "https://gitlab.example.com",
        reviewerId: 8,
        hubUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        sourceKeyPath: join(root, "key"),
        dataRoot: root,
        model: "test",
        codexPath: process.execPath,
        glabPath: glab,
        projects: [{ id: 42, projectPath: "team/repo", cachePath: bare }],
      }),
    );
    writeFileSync(
      join(root, "rules.json"),
      JSON.stringify({
        agents: { review: { use: "gitlab", command: ["review", "--config", configFile] } },
        rules: [{ name: "review", when: { source: "gitlab", types: ["mr.review.42"] }, to: "review", prompt: "p" }],
      }),
    );
    const { scanGitlab } = await import("../plugins/gitlab/poll.ts");
    const target = "https://gitlab.example.com/team/repo/-/merge_requests/7";
    const chat = ["--config", configFile, "--mr", target, "--override", "reviewer", "--reason", "飞书请求"];
    const stateFile = join(root, "gitlab/interval/42/7.json");
    let at = 5_000 * minute;
    const now = () => at;
    // The first chat dispatch is immediate, and only a hub acknowledgement records its time.
    acknowledge = false;
    await assert.rejects(scanGitlab(chat, true, { now }));
    assert.equal(existsSync(stateFile), false);
    acknowledge = true;
    assert.deepEqual(await scanGitlab(chat, true, { now }), { kind: "dispatched" });
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { lastDispatchedAt: at });
    const first = at;
    // A new head 5 minutes later is blocked and reports when it can go out.
    at += 5 * minute;
    write(sha("b"));
    assert.deepEqual(await scanGitlab(chat, true, { now }), { kind: "notReady", readyAt: first + 10 * minute });
    assert.equal(events.length, 1);
    assert.equal(existsSync(join(root, "gitlab/requests/42/7.json")) && events.length > 1, false);
    // The scan path shares that clock: its dispatch is blocked inside the interval ...
    const { loadConfig } = await import("../plugins/gitlab/config.ts");
    const { fileIntervalStore } = await import("../plugins/gitlab/interval.ts");
    const { saveRequest, latestRequest } = await import("../plugins/gitlab/request.ts");
    const config = loadConfig(configFile);
    const autoScan = () =>
      scanProject(config, { id: 42, ciMode: "required" }, "team/repo", policy, {
        now,
        interval: fileIntervalStore(join(root, "gitlab"), 42),
        list: async () => [{ ...mr(sha("b")), iid: 7, reviewers: [{ id: 8 }] }],
        read: () => latestRequest(join(root, "gitlab"), 42, 7) as any,
        write: (record) => saveRequest(join(root, "gitlab"), record as any),
        post: async (event: any) => {
          events.push(event);
          return { event: events.length, duplicate: false, routed: ["rule"] };
        },
      });
    await autoScan();
    assert.equal(events.length, 1, "chat dispatch blocks the scan inside the interval");
    // ... and goes out on the first scan after it, which in turn blocks chat.
    at = first + 10 * minute;
    await autoScan();
    assert.equal(events.length, 2);
    assert.equal(JSON.parse(events[1].detail).origin, "auto");
    write(sha("c"));
    at += 3 * minute;
    assert.deepEqual(await scanGitlab(chat, true, { now }), {
      kind: "notReady",
      readyAt: at - 3 * minute + 10 * minute,
    });
    assert.equal(events.length, 2);
    // The terminal path never waits, but records its own dispatch.
    await scanGitlab(chat, false, { now });
    assert.equal(events.length, 3);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { lastDispatchedAt: at });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
