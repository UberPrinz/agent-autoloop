// Failure modes: an MR link message is dropped or delayed forever while the MR's dispatch interval runs; several
// messages for one head dispatch more than once or raise cards; a head delivered by the scan is reviewed again because
// of chat; a multi-MR message keeps asking about MRs that need nothing; a skipped head is dispatched later.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { nextObservation, saveRequest, latestRequest } from "../plugins/gitlab/request.ts";

const minute = 60_000;
const sha = (c: string) => c.repeat(40);
const link = (n: number) => `https://gitlab.example.com/team/repo/-/merge_requests/${n}`;

test("link messages dispatch at once, wait out the per-MR interval with a keyed later, merge by MR and head, and never ask or dispatch twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-settle-"));
  const events = new Map<string, any>();
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const event = JSON.parse(text);
    const duplicate = events.has(event.id);
    events.set(event.id, event);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ event: events.size, duplicate, routed: ["rule"] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const bare = join(root, "cache.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", bare, "remote", "add", "origin", "https://gitlab.example.com/team/repo.git"]);
    const glab = join(root, "glab.cjs"),
      lark = join(root, "lark.cjs"),
      mrFile = join(root, "mr.json"),
      messagesFile = join(root, "messages.json"),
      contextFile = join(root, "context.json"),
      glConfig = join(root, "gitlab.json"),
      config = join(root, "feishu.json");
    const setMr = (head: string, state = "opened") =>
      writeFileSync(
        mrFile,
        JSON.stringify({ iid: 7, state, draft: false, sha: head, reviewers: [], head_pipeline: null }),
      );
    setMr(sha("a"));
    writeFileSync(
      glab,
      `#!/usr/bin/env node\nconst p=process.argv[3];console.log(JSON.stringify(p==='user'?{id:8}:p==='projects/42'?{id:42,path_with_namespace:'team/repo',http_url_to_repo:'https://gitlab.example.com/team/repo.git'}:JSON.parse(require('fs').readFileSync(${JSON.stringify(mrFile)}))));`,
      { mode: 0o700 },
    );
    const messages: any[] = [];
    const say = (id: string, content: string) => {
      messages.push({
        message_id: id,
        chat_id: "oc_1",
        chat_type: "p2p",
        sender: { id: "ou_peer", sender_type: "user" },
        content,
        create_time: String(Date.now()),
      });
      writeFileSync(messagesFile, JSON.stringify(messages));
    };
    writeFileSync(messagesFile, "[]");
    writeFileSync(
      lark,
      `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='auth')console.log(JSON.stringify({identities:{user:{openId:'ou_me'}}}));else console.log(JSON.stringify({ok:true,data:{messages:a.includes('group')?[]:JSON.parse(require('fs').readFileSync(${JSON.stringify(messagesFile)})),has_more:false}}))`,
      { mode: 0o700 },
    );
    writeFileSync(join(root, "key"), "secret", { mode: 0o600 });
    writeFileSync(
      glConfig,
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
    writeFileSync(config, JSON.stringify({ user: "ou_me", gitlabConfig: glConfig, lark }));
    writeFileSync(
      join(root, "rules.json"),
      JSON.stringify({
        agents: { review: { use: "gitlab", command: ["review", "--config", glConfig] } },
        rules: [{ name: "review", when: { source: "gitlab", types: ["mr.review.42"] }, to: "review", prompt: "p" }],
      }),
    );
    const run = (action: string, context: any = { events: [], answers: [] }) => {
      writeFileSync(contextFile, JSON.stringify(context));
      return new Promise<any>((r) =>
        execFile(
          process.execPath,
          [resolve("plugins/feishu/review-runtime.ts"), action, "--config", config],
          { env: { ...process.env, AGENT_AUTOLOOP_HOME: root, AGENT_AUTOLOOP_CONTEXT: contextFile }, encoding: "utf8" },
          (error, stdout, stderr) => {
            assert.equal(error, null, stderr);
            r(JSON.parse(stdout.split("```agent-autoloop\n")[1].split("\n```")[0]));
          },
        ),
      );
    };
    const dispatched = () => [...events.values()].filter((e) => e.type === "mr.review.42");
    const requests = async () => {
      await run("scan");
      return [...events.values()].filter((e) => e.type === "feishu.review.request");
    };
    const stateFile = (iid: number) => join(root, `gitlab/interval/42/${iid}.json`);
    const backdate = (iid: number) => {
      const state = JSON.parse(readFileSync(stateFile(iid), "utf8"));
      writeFileSync(stateFile(iid), JSON.stringify({ lastDispatchedAt: state.lastDispatchedAt - 11 * minute }));
    };
    const first = async (event: any) => run("review", { events: [{ ...event, source: "gitlab" }], answers: [] });
    const wake = async (event: any, later: any) =>
      run("review", {
        events: [{ id: "timer:1", source: "gitlab", type: "timer.due", subject: event.subject }],
        answers: [],
        timers: [{ key: later.key, about: later.about, at: later.at }],
      });
    const idsSeen = new Set<string>();
    const fresh = async () => {
      const all = await requests();
      const next = all.filter((e) => !idsSeen.has(e.id));
      next.forEach((e) => idsSeen.add(e.id));
      return next;
    };

    // Three messages for one MR and head: the first dispatches at once, the others find it delivered.
    say("om_1", link(7));
    say("om_2", `帮我看看 ${link(7)}`);
    say("om_3", `不用急 ${link(7)}`);
    const three = await fresh();
    assert.equal(three.length, 3);
    for (const event of three) assert.deepEqual(await first(event), { ask: [] });
    assert.equal(dispatched().length, 1, "three messages, one dispatch, no card, no wait");
    assert.equal(JSON.parse(dispatched()[0].detail).headSha, sha("a"));
    const sent = JSON.parse(readFileSync(stateFile(7), "utf8")).lastDispatchedAt;
    assert.ok(Number.isSafeInteger(sent));
    assert.deepEqual(JSON.parse(readFileSync(join(root, "gitlab/requests/42/7.json"), "utf8")).overrides, ["reviewer"]);

    // A new head inside the interval waits for last dispatch + interval; waking early waits again.
    setMr(sha("b"));
    say("om_4", link(7));
    const [fourth] = await fresh();
    let receipt = await first(fourth);
    assert.deepEqual(receipt.ask, []);
    assert.equal(receipt.later.length, 1);
    assert.equal(receipt.later[0].key, "feishu-review:mr:42:7");
    assert.equal(Date.parse(receipt.later[0].at), sent + 10 * minute);
    assert.equal(JSON.parse(receipt.later[0].about).url, link(7));
    assert.equal(dispatched().length, 1);
    let woke = await wake(fourth, receipt.later[0]);
    assert.equal(woke.later.length, 1, "still inside the interval");
    assert.equal(dispatched().length, 1);
    // Heads pushed while waiting are skipped: the wake dispatches whatever is current, once.
    setMr(sha("c"));
    setMr(sha("d"));
    backdate(7);
    woke = await wake(fourth, receipt.later[0]);
    assert.equal(woke.later, undefined);
    assert.deepEqual(
      dispatched().map((e) => JSON.parse(e.detail).headSha),
      [sha("a"), sha("d")],
    );
    await wake(fourth, receipt.later[0]);
    assert.equal(dispatched().length, 2, "waking twice dispatches once");

    // Merged or closed while waiting: nothing dispatched, no new wait.
    setMr(sha("e"));
    say("om_5", link(7));
    const [fifth] = await fresh();
    receipt = await first(fifth);
    assert.equal(receipt.later.length, 1);
    backdate(7);
    for (const state of ["merged", "closed"]) {
      setMr(sha("e"), state);
      assert.deepEqual(await wake(fifth, receipt.later[0]), { ask: [] });
    }
    assert.equal(dispatched().length, 2);

    // A head the scan delivered is skipped by chat, and a never-dispatched MR in a multi-MR message goes out at once.
    setMr(sha("f"));
    const prior = latestRequest(join(root, "gitlab"), 42, 7)!;
    saveRequest(join(root, "gitlab"), {
      ...nextObservation(prior, {
        instanceKey: "work",
        projectId: 42,
        mrIid: 7,
        headSha: sha("f"),
        policyHash: "f".repeat(64),
        eligible: true,
      }),
      origin: "auto" as const,
      delivered: true,
    });
    writeFileSync(stateFile(7), JSON.stringify({ lastDispatchedAt: Date.now() }));
    say("om_6", link(7));
    say("om_7", `${link(7)} ${link(8)}`);
    const [sixth, seventh] = await fresh();
    assert.deepEqual(await first(sixth), { ask: [] }, "a version the scan delivered produces nothing from chat");
    // One MR left after the delivered one is dropped: no card, and MR 8 has never been dispatched, so it goes now.
    assert.deepEqual(await first(seventh), { ask: [] });
    assert.equal(dispatched().length, 3);
    assert.equal(dispatched()[2].subject, "work/42/8");
    assert.equal(JSON.parse(readFileSync(stateFile(8), "utf8")).lastDispatchedAt > 0, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
