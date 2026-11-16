// Failure modes: cron scans enter backoff, short outages notify, notices repeat, recovery closes unrelated cards, or tasks share outage state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanHealth } from "../plugins/gitlab/scan-health.ts";
import { TemporaryError, AccessError } from "../plugins/gitlab/errors.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

test("outage duration survives rounds, is task-scoped, notifies once while open and resolves only matching open cards", async () => {
  const root = mkdtempSync(join(tmpdir(), "scan-health-"));
  const options = { root, instance: "work", task: "scan-a", kind: "gitlab" as const, open: [] as any[], now: 1000 };
  const down = async () => {
    throw new TemporaryError("proxyconnect ECONNREFUSED token=hidden");
  };
  try {
    assert.deepEqual(await scanHealth(options, down), { ask: [] });
    const file = join(root, "gitlab", "health", "work", "scan-a.json");
    const first = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(first.firstFailureAt, 1000);
    assert.equal(first.count, 1);
    assert.match(first.reason, /ECONNREFUSED/);
    assert.doesNotMatch(first.reason, /hidden/);
    assert.deepEqual(await scanHealth({ ...options, now: 1000 + 29 * 60_000 }, down), { ask: [] });
    const outage = await scanHealth({ ...options, now: 1000 + 31 * 60_000 }, down);
    assert.equal(outage.notice?.length, 1);
    assert.equal(outage.notice![0].key, "gitlab:scan-outage");
    assert.match(outage.notice![0].text, /31.*分钟/);
    assert.match(outage.notice![0].text, /恢复后自动关闭/);
    const receipt = resultFrom(
      readMessage(`本轮扫描结束\n\`\`\`agent-autoloop\n${JSON.stringify(outage)}\n\`\`\``),
      {},
    );
    assert.equal(receipt.problem, undefined);
    assert.equal(receipt.result.outcome, "done");
    const open = [
      { card: 9, title: outage.notice![0].title, text: outage.notice![0].text, at: "1970-01-01" },
      { card: 10, title: "其他扫描", text: "", at: "1970-01-01" },
    ];
    assert.deepEqual(await scanHealth({ ...options, open, now: 1000 + 35 * 60_000 }, down), { ask: [] });
    assert.deepEqual(await scanHealth({ ...options, task: "scan-b", now: 1000 + 35 * 60_000 }, down), { ask: [] });
    const recovered = await scanHealth({ ...options, open, now: 1000 + 40 * 60_000 }, async () => ({ ask: [] }));
    assert.deepEqual(recovered.resolve, [
      { card: 9, reason: `扫描已恢复，核实时间：${new Date(1000 + 40 * 60_000).toISOString()}` },
    ]);
    assert.deepEqual(await scanHealth({ ...options, now: 1000 + 41 * 60_000 }, down), { ask: [] });
    // A lost recovery receipt must still be able to close a card on the next successful round.
    assert.equal((await scanHealth({ ...options, open }, async () => ({ ask: [] }))).resolve?.[0].card, 9);
    await assert.rejects(
      scanHealth(options, async () => {
        throw new AccessError("登录失效");
      }),
      AccessError,
    );
    await assert.rejects(
      scanHealth(options, async () => {
        throw new TypeError("program bug");
      }),
      TypeError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
