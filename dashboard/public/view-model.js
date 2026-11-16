/** @typedef {import('../src/types.ts').State} State */
/** @typedef {import('../src/types.ts').Card} Card */

/** @param {unknown} value @returns {value is Record<string, any>} */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value */
const count = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
/** @param {unknown} value */
const date = (value) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
/** @param {unknown} value */
const nullableText = (value) => value === null || typeof value === "string";
/** @param {unknown} value @returns {value is Card} */
function validCard(value) {
  if (!object(value) || !count(value.id) || value.id === 0 || !Number.isSafeInteger(value.version)) return false;
  if (!["kind", "state", "title", "text"].every((key) => typeof value[key] === "string")) return false;
  if (!Array.isArray(value.options) || !value.options.every((option) => typeof option === "string")) return false;
  if (
    !["recommend", "choice"].every(
      (key) => value[key] === null || (count(value[key]) && value[key] < value.options.length),
    )
  )
    return false;
  if (!["answer", "by", "result", "rule", "ref", "link"].every((key) => nullableText(value[key]))) return false;
  return date(value.createdAt) && ["decidedAt", "closedAt"].every((key) => value[key] === null || date(value[key]));
}
/** @param {unknown} value @returns {State} */
export function validateState(value) {
  if (!object(value) || !date(value.now) || typeof value.timezone !== "string") throw new Error("中台状态格式不正确");
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value.timezone });
  } catch {
    throw new Error("中台时区不正确");
  }
  if (!object(value.totals) || !count(value.totals.running) || !count(value.totals.doneToday))
    throw new Error("中台计数不完整");
  if (
    !Array.isArray(value.cards) ||
    !value.cards.every(validCard) ||
    !Array.isArray(value.recentCards) ||
    !value.recentCards.every(validCard)
  )
    throw new Error("中台卡片格式不正确");
  if (
    !Array.isArray(value.lines) ||
    !value.lines.every(
      (line) =>
        object(line) &&
        typeof line.id === "string" &&
        typeof line.name === "string" &&
        nullableText(line.every) &&
        (line.next === null || date(line.next)) &&
        object(line.totals) &&
        ["running", "queued", "retrying", "unknown"].every((key) => count(line.totals[key])),
    )
  )
    throw new Error("中台定时任务格式不正确");
  if (
    !Array.isArray(value.elsewhere) ||
    !value.elsewhere.every(
      (line) =>
        object(line) &&
        ["id", "name", "every", "where"].every((key) => typeof line[key] === "string") &&
        date(line.next),
    )
  )
    throw new Error("外部任务格式不正确");
  return /** @type {State} */ (value);
}
/** @param {string | null} value @param {string} timezone */
export function time(value, timezone) {
  return value === null
    ? "未安排"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        dateStyle: "medium",
        timeStyle: "medium",
        hour12: false,
      }).format(new Date(value));
}
/** @param {string | null} value */
export function safeLink(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
const IDENTITY = /^仓库：([^\r\n]+)\r?\nMR：!([1-9]\d*)\r?\nMR 标题：([^\r\n]+)\r?\n([^\r\n]+)$/;
const MR_URL = /https?:\/\/[^\s<>"'`)\]]+?\/-\/merge_requests\/([1-9]\d*)(?!\d)/i;
/** @param {string} text */
function mergeRequestOf(text) {
  const found = MR_URL.exec(text);
  const href = found ? safeLink(found[0]) : null;
  if (!found || !href) return null;
  const url = new URL(href);
  const path = url.pathname.slice(0, url.pathname.indexOf("/-/")).replace(/^\//, "");
  return { key: `${url.origin}${url.pathname}`, href: `${url.origin}${url.pathname}`, number: found[1], path };
}
/** @param {State} state */
export function buildOverviewModel(state) {
  const cards = state.cards
    .filter((card) => card.state === "open")
    .map((card) => {
      const paragraphs = card.text.trim().split(/\r?\n\s*\r?\n/);
      // Display only: chat-message IDs are noise in a list row; the detail pane keeps the full text.
      const shown = paragraphs
        .map((part) =>
          part
            .split(/\r?\n/)
            .filter((line) => !/^(发起人|会话|消息)：/.test(line))
            .join("\n"),
        )
        .filter((part) => part.trim());
      const paragraph = shown[0] ?? paragraphs[0];
      const chars = [...paragraph];
      const identity = IDENTITY.exec(paragraph);
      const href = identity ? safeLink(identity[4]) : null;
      const reference =
        identity && href ? { label: identity[1] + " !" + identity[2] + "：" + identity[3], href } : null;
      const body = (identity ? shown.slice(1) : shown)[0] || "";
      const flat = body.replace(/\s+/g, " ").trim();
      const brief = [...flat].length > 120 ? [...flat].slice(0, 120).join("") + "…" : flat;
      return {
        ...card,
        reference,
        brief,
        mr: mergeRequestOf(card.text),
        identity,
        preview: chars.length > 300 ? chars.slice(0, 300).join("") + "…" : paragraph,
      };
    });
  /** @type {Map<string,{key:string,label:string,href:string|null,cards:typeof cards}>} */
  const byKey = new Map();
  for (const card of cards) {
    const key = card.mr?.key ?? "other";
    if (!byKey.has(key)) byKey.set(key, { key, label: "其他", href: card.mr?.href ?? null, cards: [] });
    /** @type {NonNullable<ReturnType<typeof byKey.get>>} */ (byKey.get(key)).cards.push(card);
  }
  const newest = /** @param {{createdAt:string,id:number}} card */ (card) => [Date.parse(card.createdAt), card.id];
  /** @param {{createdAt:string,id:number}} a @param {{createdAt:string,id:number}} b */
  const byNewest = (a, b) => newest(b)[0] - newest(a)[0] || b.id - a.id;
  const groups = [...byKey.values()];
  for (const group of groups) {
    group.cards.sort(byNewest);
    const first = group.cards[0];
    if (group.key === "other") continue;
    const named = group.cards.find((card) => card.identity && card.identity[2] === card.mr?.number);
    group.label = named?.reference ? named.reference.label : `${first.mr?.path || group.key} !${first.mr?.number}`;
  }
  groups.sort((a, b) => byNewest(a.cards[0], b.cards[0]));
  const ordered = groups.flatMap((group) => group.cards);
  return {
    cards: ordered,
    groups,
    waiting: ordered.length,
    running: state.totals.running,
    doneToday: state.totals.doneToday,
    timezone: state.timezone,
    scheduled: [
      ...state.lines
        .filter((line) => line.every !== null || line.next !== null)
        .map((line) => {
          const { running, queued, retrying, unknown } = line.totals;
          const status =
            [
              running ? `正在执行 ${running}` : "",
              queued ? `排队 ${queued}${retrying ? `（含重派 ${retrying}）` : ""}` : "",
              unknown ? `执行结果不确定 ${unknown}` : "",
            ]
              .filter(Boolean)
              .join(" · ") || "等待下次计划";
          return {
            key: `中台:${line.id}`,
            name: line.name,
            every: line.every || "未记录周期",
            next: time(line.next, state.timezone),
            status,
          };
        }),
      ...state.elsewhere.map((line) => ({
        key: `外部:${line.id}`,
        name: line.name,
        every: line.every,
        next: time(line.next, state.timezone),
        status: `状态未知 · 在${line.where}执行`,
      })),
    ],
  };
}
