// Failure modes: disabling the login shell still imports personal proxy/PATH settings, or cached program discovery ignores the environment mode.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "worker-login-"));
process.env.AGENT_AUTOLOOP_HOME = root;
const originalShell = process.env.SHELL,
  originalPath = process.env.PATH;
const personal = join(root, "personal"),
  service = join(root, "service");
mkdirSync(personal);
mkdirSync(service);
for (const dir of [personal, service]) writeFileSync(join(dir, "test-agent"), "#!/bin/sh\necho ok\n", { mode: 0o700 });
const shell = join(root, "shell");
writeFileSync(
  shell,
  `#!/bin/sh\nexport PERSONAL_PROXY=from-login\nexport PATH=${personal}:$PATH\nexec /bin/sh "$@"\n`,
  { mode: 0o700 },
);
process.env.SHELL = shell;
process.env.PATH = `${service}:${originalPath}`;
after(() => {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});
const { createWorker } = await import("../worker/worker.ts");
const { findProgram } = await import("../worker/agents.ts");

test("program discovery defaults to login PATH and switches to the service PATH without reusing cache", () => {
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1", worker: { name: "test", key: "x" } }),
  );
  assert.equal(findProgram("test-agent"), join(personal, "test-agent"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1", worker: { name: "test", key: "x", loginShell: false } }),
  );
  assert.equal(findProgram("test-agent"), join(service, "test-agent"));
});

test("worker launch defaults to login shell and false keeps only the inherited service environment", async () => {
  for (const [index, loginShell] of [undefined, false].entries()) {
    const results: any[] = [];
    let claimed = false;
    const job = {
      run: index + 1,
      token: "test",
      attempt: 1,
      session: null,
      askFirst: [],
      rule: { name: "test", cwd: root, prompt: "test" },
      agent: {
        id: "test",
        name: "test",
        use: "command",
        access: "read",
        command: [process.execPath, "-e", "console.log(process.env.PERSONAL_PROXY || 'service-only')"],
      },
      context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
    };
    const worker = createWorker({
      name: "test",
      wait: 0,
      loginShell,
      hub: {
        work: async () => {
          const next = claimed ? null : job;
          claimed = true;
          return { job: next, cancel: [] };
        },
        started: async () => ({}),
        result: async (_r: number, _t: string, body: unknown) => {
          results.push(body);
          return {};
        },
      } as any,
    });
    for (let i = 0; i < 100 && !results.length; i++) {
      await worker.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(results[0]?.outcome, "done");
    assert.equal(results[0]?.summary, loginShell === false ? "service-only" : "from-login");
  }
});
