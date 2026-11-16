// Failure modes: unknown executions look idle, retries are double-counted, or history crowds the pending list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverviewModel, safeLink, validateState } from "../dashboard/public/view-model.js";
import { state, card } from "./dashboard-fixture.ts";
test("only open cards and scheduled rules; timezone and upstream round counts survive mapping", () => {
  const s = state();
  s.cards.push({ ...card(2), state: "decided" });
  const fixture = {
    ...s,
    lines: [
      {
        id: "scheduled",
        name: "定时",
        every: "每天",
        next: "2026-11-14T01:00:00.000Z",
        totals: { running: 0, queued: 0, retrying: 0, unknown: 1 },
      },
      {
        id: "event",
        name: "事件",
        every: null,
        next: null,
        totals: { running: 2, queued: 0, retrying: 0, unknown: 0 },
      },
    ],
    elsewhere: [{ id: "scheduled", name: "外部", every: "每天", next: "2026-11-14T01:00:00.000Z", where: "别处" }],
  };
  const m = buildOverviewModel(validateState(fixture));
  assert.equal(m.waiting, 1);
  assert.equal(m.doneToday, 3);
  assert.equal(m.scheduled.length, 2);
  assert.match(m.scheduled[0].status, /执行结果不确定/);
  assert.doesNotMatch(m.scheduled[0].status, /等待下次/);
  assert.match(m.scheduled[0].next, /2026.*11.*14.*09:00:00/);
  assert.match(m.scheduled[1].status, /状态未知/);
  fixture.lines[0].totals = { running: 0, queued: 2, retrying: 1, unknown: 0 };
  assert.match(buildOverviewModel(fixture).scheduled[0].status, /排队 2（含重派 1）/);
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("https://example.test"), "https://example.test/");
});

// Failure mode: the list hides the task identity that its source already put in the card body.
test("pending cards preview the first paragraph as bounded plain text, without dropping MR identity", () => {
  const header =
    "仓库：team/app\nMR：!7\nMR 标题：修复登录状态\nhttps://gitlab.example.com/team/app/-/merge_requests/7";
  const value = { ...state(), cards: [{ ...card(), text: header + "\n\n完整报告：\n<script>报告</script>" }] };
  assert.equal(buildOverviewModel(value).cards[0].preview, header);
  assert.equal(
    [...buildOverviewModel({ ...value, cards: [{ ...card(), text: "字".repeat(500) }] }).cards[0].preview].length,
    301,
  );
});

// Failure mode: MR identity takes four lines, or untrusted text becomes an unsafe hyperlink.
test("MR header maps to one named HTTP link; incomplete and unsafe headers stay plain text", () => {
  const header =
    "仓库：team/app\nMR：!7\nMR 标题：修复 <登录> 状态\nhttps://gitlab.example.com/team/app/-/merge_requests/7";
  const model = (text: string) => buildOverviewModel({ ...state(), cards: [{ ...card(), text }] }).cards[0];
  assert.deepEqual(model(header).reference, {
    label: "team/app !7：修复 <登录> 状态",
    href: "https://gitlab.example.com/team/app/-/merge_requests/7",
  });
  assert.equal(
    model(header.replace("https://gitlab.example.com/team/app/-/merge_requests/7", "javascript:alert(1)")).reference,
    null,
  );
  assert.equal(model(header.split("\n").slice(0, 3).join("\n")).reference, null);
});

// Failure modes: cards of different merge requests are merged into one group (so a batch looks safer than it
// is), cards without a merge request vanish from the list, or grouping order hides the newest card.
const mr = (n: number, host = "https://gitlab.example.com", path = "team/app") =>
  `${host}/${path}/-/merge_requests/${n}`;
const at = (minute: number) => `2026-11-13T02:${String(minute).padStart(2, "0")}:00.000Z`;
const grouped = (cards: ReturnType<typeof card>[]) => buildOverviewModel({ ...state(), cards }).groups;
test("same merge request URL groups together; different numbers, projects and hosts stay apart", () => {
  const groups = grouped([
    { ...card(1), text: `看 ${mr(7)} 的报告`, createdAt: at(1) },
    { ...card(2), text: `看 ${mr(7)}\n\n正文`, createdAt: at(2) },
    { ...card(3), text: mr(8), createdAt: at(3) },
    { ...card(4), text: mr(7, "https://gitlab.example.com", "team/other"), createdAt: at(4) },
    { ...card(5), text: mr(7, "https://other.example.com"), createdAt: at(5) },
  ]);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups.map((g) => g.cards.map((c) => c.id)),
    [[5], [4], [3], [2, 1]],
  );
});

test("cards without a merge request go to the other group; groups sort by newest card, cards newest first", () => {
  const groups = grouped([
    { ...card(1), text: mr(1), createdAt: at(10) },
    { ...card(2), text: "没有链接", createdAt: at(30) },
    { ...card(3), text: mr(1), createdAt: at(5) },
    { ...card(4), text: "https://example.test/not-a-merge-request", createdAt: at(20) },
    { ...card(5), text: mr(2), createdAt: at(25) },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.cards.map((c) => c.id)]),
    [
      ["other", [2, 4]],
      [mr(2), [5]],
      [mr(1), [1, 3]],
    ],
  );
  assert.equal(groups[0].label, "其他");
  assert.equal(groups[0].href, null);
});

test("group label prefers repository, number and title; falls back to the URL path; flat order follows groups", () => {
  const header = (n: number, title: string) => `仓库：team/app\nMR：!${n}\nMR 标题：${title}\n${mr(n)}`;
  const model = buildOverviewModel({
    ...state(),
    cards: [
      { ...card(1), text: header(7, "修复登录") + "\n\n报告", createdAt: at(1) },
      { ...card(2), text: mr(9) + " 无标题", createdAt: at(2) },
      { ...card(3), text: header(7, "修复登录") + "\n\n另一份", createdAt: at(3) },
    ],
  });
  assert.deepEqual(
    model.groups.map((g) => [g.label, g.href]),
    [
      ["team/app !7：修复登录", mr(7)],
      ["team/app !9", mr(9)],
    ],
  );
  assert.deepEqual(
    model.cards.map((c) => c.id),
    [3, 1, 2],
  );
  assert.equal(model.waiting, 3);
});

test("untrusted text only drives display: unsafe URLs never become links and previews skip the identity block", () => {
  const model = buildOverviewModel({
    ...state(),
    cards: [
      {
        ...card(1),
        text: `仓库：team/app\nMR：!7\nMR 标题：t\n${mr(7)}\n\n第一段 说明\n  很长`,
      },
    ],
  });
  assert.equal(model.groups[0].cards[0].brief, "第一段 说明 很长");
  assert.equal(grouped([{ ...card(1), text: "javascript:alert(1)//-/merge_requests/1" }])[0].key, "other");
});

// Failure mode: the list brief of chat-message cards starts with raw sender, chat and message IDs instead of the message.
test("brief skips sender, chat and message ID lines but the full text is untouched", () => {
  const text = "这条消息需要我审查吗？\n发起人：ou_abc\n会话：oc_def\n消息：om_ghi\n\n请看看 MR";
  const item = buildOverviewModel({ ...state(), cards: [{ ...card(1), text }] }).cards[0];
  assert.equal(item.brief, "这条消息需要我审查吗？");
  assert.equal(item.text, text);
  const only = "发起人：ou_abc\n会话：oc_def\n消息：om_ghi\n\n真正的内容";
  assert.equal(buildOverviewModel({ ...state(), cards: [{ ...card(1), text: only }] }).cards[0].brief, "真正的内容");
});
