// Failure modes: a refresh rebuilds the list and loses the open card, focus or the expanded report; a handled
// card leaves the pane empty; grouping text written by others is shown as markup or merges different merge requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { app, response, flush, walk, textOf } from "./dashboard-dom.ts";
import { state, card } from "./dashboard-fixture.ts";

const at = (minute: number) => `2026-11-13T02:${String(minute).padStart(2, "0")}:00.000Z`;
const cards = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...card(i + 1), title: `卡片${i + 1}`, createdAt: at(i + 1) }));
type Post = { url: string; headers: Record<string, string>; body: string };
function hub(
  initial: any[],
  reply: (post: Post, n: number) => Response | Promise<Response> = (post) =>
    response(post.url.endsWith("/answer") ? { changed: true, state: "decided" } : { changed: true }),
) {
  const posts: Post[] = [];
  const f = { cards: initial, posts, recent: [] as any[] };
  const fetchImpl = async (url: any, options?: any) => {
    if (options?.method === "POST") {
      const post = { url: String(url), headers: options.headers, body: options.body };
      posts.push(post);
      const out = await reply(post, posts.length);
      if (out.ok) {
        const id = Number(/cards\/(\d+)/.exec(post.url)![1]);
        f.cards = f.cards.filter((c) => c.id !== id);
      }
      return out;
    }
    return response({ ...state(), cards: f.cards, recentCards: f.recent });
  };
  return { f, fetchImpl: fetchImpl as typeof fetch };
}
const byId = (root: any, id: string) => walk(root).find((node) => node.id === id);

test("answering moves on to the next card, but the last card keeps its result on screen", async () => {
  const h = hub(cards(2));
  const t = app(h.fetchImpl);
  await t.app.ready;
  t.app.open(2);
  t.app.choose(0);
  await t.app.submit();
  assert.equal(t.app.getView().opened, 1);
  assert.match(t.app.getView().notice, /决定已提交/);
  assert.match(t.app.getView().notice, /卡片2/);
  t.app.choose(1);
  await t.app.submit();
  assert.equal(t.app.getView().opened, 1);
  assert.match(t.app.getView().message, /决定已提交/);
});

test("the dock holds options, submit and result, and no resolve or batch control exists", async () => {
  const h = hub(cards(2));
  const t = app(h.fetchImpl);
  await t.app.ready;
  t.app.open(1);
  const dock = walk(t.document.nodes.detail).find((n) => n.className === "dock");
  assert.ok(dock);
  assert.ok(walk(dock).some((n) => n.id === "submit-1"));
  const all = [...walk(t.document.nodes.waiting), ...walk(t.document.nodes.detail)];
  assert.ok(all.every((n) => n.type !== "checkbox" && n.type !== "textarea" && n.tagName !== "textarea"));
  assert.ok(!/结案|批量|全选/.test(textOf(t.document.nodes.waiting) + textOf(t.document.nodes.detail)));
});

test("grouping shows one header per merge request and never merges different numbers", async () => {
  const mr = (n: number) => `https://gitlab.example.com/team/app/-/merge_requests/${n}`;
  const list = cards(4).map((c, i) => ({
    ...c,
    text: i < 2 ? `${mr(7)}\n\n正文` : i === 2 ? mr(8) : "没有链接",
  }));
  const h = hub(list);
  const t = app(h.fetchImpl);
  await t.app.ready;
  const labels = textOf(t.document.nodes.waiting);
  assert.ok(labels.includes("其他"));
  assert.ok(labels.includes("team/app !7"));
  assert.ok(labels.includes("team/app !8"));
  assert.equal(t.app.getView().groups.length, 3);
  assert.deepEqual(
    t.app.getView().groups.map((g: any) => g.ids),
    [[4], [3], [2, 1]],
  );
});

test("refresh updates rows in place and keeps the open card, expanded report and focus", async () => {
  const h = hub(cards(2));
  const t = app(h.fetchImpl);
  await t.app.ready;
  const waiting = t.document.nodes.waiting;
  t.app.open(1);
  t.app.choose(1);
  const radio = byId(t.document.nodes.detail, "choice-1-1");
  radio.focus();
  const row1 = byId(waiting, "open-card-1"),
    row2 = byId(waiting, "open-card-2"),
    detailFirst = t.document.nodes.detail.children[0];
  h.f.cards = [
    ...cards(2).map((c) => ({ ...c, title: c.id === 2 ? "改过的标题" : c.title })),
    { ...card(3), title: "新来的", createdAt: at(9) },
  ];
  await t.app.refresh();
  assert.equal(byId(waiting, "open-card-1"), row1);
  assert.equal(byId(waiting, "open-card-2"), row2);
  assert.equal(row2.textContent, "改过的标题");
  assert.ok(byId(waiting, "open-card-3"));
  assert.equal(t.app.getView().opened, 1);
  assert.equal(t.app.getView().selection, 1);
  assert.equal(t.document.nodes.detail.children[0], detailFirst);
  assert.equal(t.document.activeElement, radio);
  // New cards sort first, and rows follow the new order without being recreated.
  const order = walk(waiting)
    .filter((n) => /^open-card-/.test(n.id || ""))
    .map((n) => n.id);
  assert.deepEqual(order, ["open-card-3", "open-card-2", "open-card-1"]);
  h.f.cards = h.f.cards.filter((c) => c.id !== 2);
  await t.app.refresh();
  assert.equal(byId(waiting, "open-card-2"), undefined);
  assert.equal(byId(waiting, "open-card-1"), row1);
});

test("narrow screens switch between list and detail; back returns to the list", async () => {
  const h = hub(cards(1));
  const t = app(h.fetchImpl);
  await t.app.ready;
  const layout = t.document.nodes.layout;
  assert.doesNotMatch(layout.className, /show-detail/);
  t.app.open(1);
  assert.match(layout.className, /show-detail/);
  assert.equal(t.document.nodes["detail-empty"].hidden, true);
  const back = walk(t.document.nodes.detail).find((n) => n.tagName === "button" && n.textContent === "返回");
  assert.ok(back);
  back.dispatch("click");
  assert.doesNotMatch(layout.className, /show-detail/);
  assert.equal(t.document.nodes.detail.hidden, true);
  assert.equal(t.document.nodes["detail-empty"].hidden, false);
});

test("card text stays text in rows, groups and detail", async () => {
  const h = hub([{ ...card(1), title: "<img src=x onerror=alert(1)>", text: "<script>x</script>" }]);
  const t = app(h.fetchImpl);
  await t.app.ready;
  t.app.open(1);
  const all = [...walk(t.document.nodes.waiting), ...walk(t.document.nodes.detail)];
  assert.ok(all.every((n) => !("innerHTML" in n) && !n.href));
  assert.ok(textOf(t.document.nodes.detail).includes("<img src=x onerror=alert(1)>"));
});
