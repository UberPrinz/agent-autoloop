// Failure modes: CLI diagnostics disappear, secrets reach cards, and configuration bugs masquerade as network outages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitLab, TemporaryError, GitLabWriteError } from "../plugins/gitlab/api.ts";

test("GitLab read and write retain redacted proxy diagnostics within the worker tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-errors-"));
  try {
    const fake = join(root, "glab");
    writeFileSync(
      fake,
      `#!${process.execPath}\nprocess.stderr.write('Authorization: Bearer private-secret\\ntoken=other-secret glpat-abc123 u-larksecret t-tenantsecret https://user:password@proxy.invalid/path?key=query-secret proxyconnect ECONNREFUSED');process.exitCode=7;`,
      { mode: 0o700 },
    );
    const api = new GitLab(fake, "https://gitlab.example.com");
    for (const action of [() => api.get("user"), () => api.post("projects/1/discussions", {})]) {
      await assert.rejects(action(), (e: any) => {
        assert.match(e.message, /7/);
        assert.match(e.message, /proxyconnect.*ECONNREFUSED/);
        assert.doesNotMatch(
          e.message,
          /private-secret|other-secret|abc123|larksecret|tenantsecret|query-secret|password/,
        );
        assert.ok(e.message.length <= 300);
        assert.ok(e instanceof TemporaryError || e instanceof GitLabWriteError);
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing CLI without network evidence is not a temporary error and preserves JSON diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-errors-"));
  try {
    const fake = join(root, "glab");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconsole.log(JSON.stringify({error:{type:'configuration',code:'BAD_CONFIG',message:'invalid field'}}));process.exitCode=2;`,
      { mode: 0o700 },
    );
    await assert.rejects(new GitLab(fake, "https://gitlab.example.com").get("user"), (e: any) => {
      assert.equal(e instanceof TemporaryError, false);
      assert.match(e.message, /2.*configuration.*BAD_CONFIG.*invalid field/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetch diagnostics retain cause and host while TypeError alone is not transient", async () => {
  const { postEvent, classified, AccessError, cliFailure } = await import("../plugins/gitlab/errors.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      });
    };
    await assert.rejects(postEvent("http://hub.invalid:3000/v1/events?token=secret", {}), (e: any) => {
      assert.ok(e instanceof TemporaryError);
      assert.match(e.message, /hub.invalid:3000.*ECONNREFUSED/);
      assert.doesNotMatch(e.message, /secret/);
      return true;
    });
    assert.equal(
      classified(new TypeError("Cannot read properties of undefined").message) instanceof TemporaryError,
      false,
    );
    for (const status of [429, 503]) {
      globalThis.fetch = async () => new Response("", { status });
      await assert.rejects(postEvent("http://hub.invalid/v1/events", {}), TemporaryError);
    }
    assert.ok(
      cliFailure(
        "飞书",
        1,
        "",
        JSON.stringify({ error: { type: "authentication", code: 42, message: "expired" } }),
      ) instanceof AccessError,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("unknown comment writes preserve sanitized diagnostics on first failure and replay without reposting", async () => {
  const { publishOne } = await import("../plugins/gitlab/publish.ts");
  const { readFileSync } = await import("node:fs");
  const command = (await import("../plugins/command/agent.ts")).default;
  const root = mkdtempSync(join(tmpdir(), "publish-diagnostics-"));
  const logs: string[] = [];
  const original = console.error;
  console.error = (text) => {
    logs.push(String(text));
  };
  let posts = 0;
  try {
    const item = { actionKey: "a".repeat(64), body: "review", position: null };
    const io = {
      current: async () => true,
      find: async () => null,
      post: async () => {
        posts++;
        throw new GitLabWriteError(null, "GitLab 写入（退出码 7）：proxyconnect ECONNREFUSED glpat-private-value");
      },
    };
    for (let round = 0; round < 2; round++) {
      logs.length = 0;
      assert.equal(await publishOne(root, "b".repeat(64), item, io), "unknown");
      const error = command.read("", 1, logs.join("\n") + "\n评论发送结果不明，请本人在 GitLab 核查").error!;
      assert.match(error, /proxyconnect.*ECONNREFUSED/);
      assert.doesNotMatch(error, /private-value/);
    }
    assert.equal(posts, 1);
    const raw = readFileSync(join(root, "actions", item.actionKey, "post-failure.json"), "utf8");
    assert.match(raw, /ECONNREFUSED/);
    assert.doesNotMatch(raw, /private-value/);
  } finally {
    console.error = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a connection lost while reading the Hub receipt retains host and transport cause", async () => {
  const { postEvent } = await import("../plugins/gitlab/errors.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => {
          throw new TypeError("terminated", {
            cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
          });
        },
      }) as unknown as Response;
    await assert.rejects(postEvent("http://hub.invalid/v1/events", {}), (error: any) => {
      assert.ok(error instanceof TemporaryError);
      assert.match(error.message, /hub.invalid.*ECONNRESET/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
