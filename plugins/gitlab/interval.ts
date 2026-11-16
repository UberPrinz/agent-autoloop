import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicFile } from "./storage.ts";

// Request records are immutable, so the last dispatch time of an MR lives in its own small file.
export type Dispatched = { lastDispatchedAt: number };
export type IntervalStore = { read(iid: number): Dispatched | undefined; write(iid: number, state: Dispatched): void };

export function fileIntervalStore(gitlabRoot: string, projectId: number): IntervalStore {
  const file = (iid: number) => join(gitlabRoot, "interval", `${projectId}`, `${iid}.json`);
  return {
    read(iid) {
      try {
        const value = JSON.parse(readFileSync(file(iid), "utf8"));
        // An unreadable time counts as no recent dispatch; a delivered head is still protected by its request record.
        return Number.isSafeInteger(value?.lastDispatchedAt) ? { lastDispatchedAt: value.lastDispatchedAt } : undefined;
      } catch {
        return undefined;
      }
    },
    write: (iid, state) => atomicFile(file(iid), JSON.stringify(state)),
  };
}

/** Earliest time the next dispatch of this MR may go out; 0 when nothing limits it. */
export function readyAt(store: IntervalStore, iid: number, minutes: number): number {
  const last = store.read(iid)?.lastDispatchedAt;
  return minutes === 0 || last === undefined ? 0 : last + minutes * 60_000;
}
