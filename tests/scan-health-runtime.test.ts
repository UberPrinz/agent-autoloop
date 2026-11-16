// Failure modes: real scan entry points still report failed, hide CLI causes, or fail to recover a persistent outage notice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { readMessage, resultFrom } from "../worker/contract.ts";

test("fake glab and lark scans preserve causes, finish without backoff, notify long outages and recover", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-runtime-"));
  try {
    const glab = join(root, "glab"),
      lark = join(root, "lark"),
      mode = join(root, "mode");
    const bare = join(root, "cache.git"),
      config = join(root, "gitlab.json"),
      feishu = join(root, "feishu.json"),
      context = join(root, "context.json");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", bare, "remote", "add", "origin", "https://gitlab.example.com/team/repo.git"]);
    const fail = `const mode=require('fs').readFileSync(${JSON.stringify(mode)},'utf8');if(mode==='network'){console.error('proxyconnect ECONNREFUSED glpat-private-secret');process.exit(7);}if(mode==='rate'){process.stdout.write('HTTP/1.1 429 Too Many Requests\\r\\nRetry-After: 0\\r\\n\\r\\n{}');process.exit(1);}if(mode==='lark-rate'){console.log(JSON.stringify({ok:false,error:{type:'rate_limit',code:99991400,message:'request limit reached'}}));process.exit(2);}if(mode==='http503'){console.error('HTTP 503 Service Unavailable');process.exit(3);}if(mode==='http429'){console.error('HTTP 429 Too Many Requests');process.exit(3);}if(mode==='json503'){console.log(JSON.stringify({error:{type:'api',code:503,message:'service unavailable'}}));process.exit(3);}if(mode==='access'){console.log(JSON.stringify({error:{type:'authentication',code:'EXPIRED',message:'login expired'}}));process.exit(8);}if(mode==='bug'){console.error('unknown option --bad');process.exit(9);}`;
    writeFileSync(
      glab,
      `#!${process.execPath}\n${fail}const p=process.argv[3];console.log(JSON.stringify(p==='user'?{id:8}:p==='projects/42'?{id:42,path_with_namespace:'team/repo',http_url_to_repo:'https://gitlab.example.com/team/repo.git'}:[]));`,
      { mode: 0o700 },
    );
    writeFileSync(
      lark,
      `#!${process.execPath}\n${fail}console.log(JSON.stringify(process.argv[2]==='auth'?{identities:{user:{openId:'ou_me'}}}:{ok:true,data:{messages:[],has_more:false}}));`,
      { mode: 0o700 },
    );
    writeFileSync(join(root, "key"), "secret", { mode: 0o600 });
    writeFileSync(
      config,
      JSON.stringify({
        schema: 1,
        instanceKey: "work",
        instanceUrl: "https://gitlab.example.com",
        reviewerId: 8,
        hubUrl: "http://127.0.0.1:1234",
        sourceKeyPath: join(root, "key"),
        dataRoot: root,
        model: "test",
        codexPath: process.execPath,
        glabPath: glab,
        projects: [{ id: 42, projectPath: "team/repo", cachePath: bare }],
      }),
    );
    writeFileSync(feishu, JSON.stringify({ user: "ou_me", gitlabConfig: config, lark }));
    writeFileSync(
      join(root, "rules.json"),
      JSON.stringify({
        agents: { review: { use: "gitlab", command: ["review", "--config", config] } },
        rules: [
          { name: "review", when: { source: "gitlab", types: ["mr.review.42"] }, to: "review", prompt: "可信审查" },
        ],
      }),
    );
    const timeoutHook = join(root, "timeout-hook.mjs");
    writeFileSync(
      timeoutHook,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {readFileSync} from 'node:fs';const real=cp.execFile;cp.execFile=(program,args,options,callback)=>real(program,args,{...options,timeout:program===${JSON.stringify(lark)}&&readFileSync(${JSON.stringify(mode)},'utf8')==='timeout'?50:options.timeout},callback);syncBuiltinESMExports();`,
    );
    const originalLark = readFileSync(lark, "utf8");
    writeFileSync(
      lark,
      originalLark.replace(
        "console.log(JSON.stringify(process.argv[2]",
        "if(mode==='timeout'){setInterval(()=>{},1000);}else console.log(JSON.stringify(process.argv[2]",
      ),
    );
    for (const kind of ["gitlab", "feishu-review"]) {
      const run = (state: string, open: any[] = []) => {
        writeFileSync(mode, state);
        writeFileSync(context, JSON.stringify({ events: [], answers: [], open }));
        const child = spawnSync(
          process.execPath,
          kind === "gitlab"
            ? [resolve("plugins/gitlab/poll.ts"), "--config", config]
            : ["--import", timeoutHook, resolve("plugins/feishu/review-runtime.ts"), "scan", "--config", feishu],
          {
            encoding: "utf8",
            timeout: 3000,
            env: { ...process.env, AGENT_AUTOLOOP_HOME: root, AGENT_AUTOLOOP_CONTEXT: context },
          },
        );
        return { ...child, parsed: resultFrom(readMessage(child.stdout), {}) };
      };
      const first = run("network");
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.parsed.result.outcome, "done");
      assert.match(first.stdout, /proxyconnect.*ECONNREFUSED/);
      assert.doesNotMatch(first.stdout, /private-secret/);
      assert.equal(first.parsed.result.notice?.length ?? 0, 0);
      const directory = join(root, kind, "health", "work"),
        file = join(directory, readdirSync(directory)[0]);
      const state = JSON.parse(readFileSync(file, "utf8"));
      state.firstFailureAt -= 31 * 60_000;
      writeFileSync(file, JSON.stringify(state));
      const long = run("network"),
        notice = long.parsed.result.notice![0];
      assert.equal(long.parsed.problem, undefined);
      assert.match(notice.text, /ECONNREFUSED/);
      const open = [{ card: 3, title: notice.title, text: notice.text, at: new Date().toISOString() }];
      assert.equal(run("network", open).parsed.result.notice?.length ?? 0, 0);
      const recovered = run("ok", open);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(recovered.parsed.result.resolve?.[0].card, 3);
      if (kind === "gitlab") {
        const limited = run("rate");
        assert.equal(limited.status, 0, limited.stderr);
        assert.equal(limited.parsed.result.outcome, "done");
        assert.match(limited.stdout, /429/);
      }
      if (kind === "feishu-review") {
        for (const state of ["lark-rate", "http503", "http429", "json503"]) {
          const unavailable = run(state);
          assert.equal(unavailable.status, 0, unavailable.stderr);
          assert.equal(unavailable.parsed.result.outcome, "done");
          assert.equal(unavailable.parsed.result.notice?.length ?? 0, 0);
          assert.match(unavailable.stdout, /99991400|503|429/);
        }
        const timeout = run("timeout");
        assert.equal(timeout.status, 0, timeout.stderr);
        assert.equal(timeout.parsed.result.outcome, "done");
        assert.match(timeout.stdout, /ETIMEDOUT/);
        assert.equal(timeout.parsed.result.notice?.length ?? 0, 0);
      }
      const access = run("access");
      assert.equal(access.status, 0, access.stderr);
      assert.match(access.stdout, /EXPIRED/);
      assert.equal(access.parsed.result.ask?.length, 1);
      const bug = run("bug");
      assert.match(bug.stdout + bug.stderr, /unknown option --bad/);
      assert.doesNotMatch(bug.stdout, /等待下次定时重试/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
