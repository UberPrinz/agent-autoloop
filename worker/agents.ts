// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { CONFIG_FILE, readConfig } from "../host/config.ts";
import path from "node:path";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  contextFile: string;
  folder: string;
};
export type Reading = { text?: string; session?: string; usage?: Usage; error?: string; finished?: boolean };
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in: what's wrong, in words a person can act on, or nothing. */
  check?(): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

// Updates can briefly remove a program; caching that miss would fail every later run until restart.
const found = new Map<string, string>();

/** The default preserves launchd's existing login-shell environment. */
export function usesLoginShell(): boolean {
  return !existsSync(CONFIG_FILE) || readConfig().worker?.loginShell !== false;
}

/** Resolve programs in the configured worker environment. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  const login = usesLoginShell();
  const cacheKey = login ? name : `service:${process.env.PATH}:${name}`;
  let program = found.get(cacheKey);
  if (!login) {
    program ??= (
      name.includes("/") ? [name] : (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(dir, name))
    ).find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!program) throw new Error(`找不到 ${name}：请在服务的 PATH 中安装并登录`);
    found.set(cacheKey, program);
    return program;
  }
  if (!program) {
    const shell = process.env.SHELL ?? "/bin/sh";
    let onPath: string | null = null;
    try {
      const printed = execFileSync(shell, ["-lc", `command -v ${name}`], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      onPath = printed.trim().split("\n").at(-1) || null;
    } catch {}
    program = onPath ?? elsewhere().find(existsSync);
    if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
    found.set(cacheKey, program);
  }
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
