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
