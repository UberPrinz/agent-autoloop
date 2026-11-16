// Failure modes: discussion or other people's mentions authorize reviews; split messages lose targets; replay duplicates work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, collectMessages, handleRequest } from "../plugins/feishu/review.ts";
const url = "https://gitlab.example.com/team/repo/-/merge_requests/7";
const policy = { user: "ou_me", instanceUrl: "https://gitlab.example.com", projects: ["team/repo"] };
const message = (content: string, extra = {}) => ({
  message_id: "om_1",
  chat_id: "oc_1",
  chat_type: "p2p",
  sender: { id: "ou_peer", sender_type: "user" },
  content,
  ...extra,
});
test("a numbered MR link alone starts a review whatever the wording; no-link messages keep the keyword rules", () => {
  // Guards against wording filters (keywords, negations, extra mentions) silently dropping a plain MR link request.
  for (const text of [
    `${url}`,
    `帮我 review 一下 ${url}`,
    `这个 review 过了吗 ${url}`,
    `不用你 review ${url}`,
    `帮我 review ${url} https://gitlab.example.com/team/repo/-/merge_requests/8`,
  ]) {
    const request = classify(message(text), [], policy);
    assert.equal(request?.automatic, true, text);
    assert.ok(request!.urls.length >= 1);
  }
  assert.deepEqual(classify(message(`看看 ${url} 和 ${url}`), [], policy)?.urls, [url]);
  // The new-MR page and other projects are not numbered MRs of a configured project.
  assert.equal(classify(message("https://gitlab.example.com/team/repo/-/merge_requests/new"), [], policy), null);
  assert.equal(classify(message("https://gitlab.example.com/other/repo/-/merge_requests/7"), [], policy), null);
  // Messages without a link keep the old wording rules.
  assert.equal(classify(message("午饭吃什么"), [], policy), null);
  assert.equal(classify(message("帮我 review 一下"), [message(url)], policy)?.automatic, true);
  assert.equal(classify(message("不用你 review"), [message(url)], policy)?.automatic, false);
  assert.equal(classify(message("我帮你 review"), [message(url)], policy)?.automatic, false);
  assert.equal(classify(message("帮我 review"), [], policy)?.automatic, false);
  assert.equal(classify(message(`帮我 review ${url}`, { sender: { id: "ou_me" } }), [], policy), null);
  assert.equal(classify(message(`帮我 review ${url}`, { deleted: true }), [], policy), null);
});
test("group requests need an actual owner mention; other mentions no longer block an MR link", () => {
  assert.equal(classify(message(url, { chat_type: "group", mentions: [{ id: "ou_other" }] }), [], policy), null);
  assert.equal(classify(message(url, { chat_type: "group" }), [], policy), null);
  assert.equal(
    classify(message(url, { chat_type: "group", mentions: [{ id: "ou_me" }] }), [], policy)?.automatic,
    true,
  );
  assert.equal(
    classify(message(url, { chat_type: "group", mentions: [{ id: "ou_me" }, { id: "ou_other" }] }), [], policy)
      ?.automatic,
    true,
  );
  // Without a link, extra recipients still make a context-only request ambiguous.
  assert.equal(
    classify(
      message("帮忙 review", { chat_type: "group", mentions: [{ id: "ou_me" }, { id: "ou_other" }] }),
      [message(url)],
      policy,
    )?.automatic,
    false,
  );
});
test("same sender's preceding link supplies target but never supplies the request instruction", () => {
  assert.equal(classify(message("帮忙看一下"), [message(url)], policy)?.automatic, true);
  assert.equal(classify(message("好的"), [message(`帮忙 review ${url}`)], policy), null);
  assert.equal(
    classify(message("帮忙 review"), [message(url, { sender: { id: "ou_other" } })], policy)?.automatic,
    false,
  );
  assert.deepEqual(
    classify(message(`帮忙 review https://evil.test/team/repo/-/merge_requests/7`), [], policy)?.urls,
    [],
  );
});
test("pagination follows remaining tokens and rejects incomplete responses", async () => {
  const calls: string[][] = [];
  const rows = await collectMessages(
    async (args) => {
      calls.push(args);
      return { ok: true, data: { messages: [message(url)], has_more: calls.length === 1, page_token: "next" } };
    },
    ["im", "+messages-search"],
  );
  assert.equal(rows.length, 2);
  assert.ok(calls[1].includes("next"));
  await assert.rejects(collectMessages(async () => ({ ok: true, data: { messages: [], has_more: true } }), []));
  await assert.rejects(collectMessages(async () => ({ ok: false, error: {} }), []));
});
test("ambiguous requests end with a card and only its positive answer submits trusted targets", async () => {
  const request = { id: "a".repeat(64), message: message(url), urls: [url], automatic: false };
  const submitted: string[] = [];
  const submit = async (target: string) => {
    submitted.push(target);
  };
  const first = await handleRequest(request, [], submit);
  assert.equal(first.ask.length, 1);
  assert.equal(submitted.length, 0);
  const answer = { about: request.id, choice: 0, text: null };
  await handleRequest(request, [answer], submit);
  assert.deepEqual(submitted, [url]);
  submitted.length = 0;
  await handleRequest(request, [{ ...answer, choice: 1 }], submit);
  assert.equal(submitted.length, 0);
  await handleRequest(request, [{ ...answer, about: "forged" }], submit);
  assert.equal(submitted.length, 0);
});

test("many targets remain within card limits; an owner can supply a missing configured MR", async () => {
  const request = { id: "b".repeat(64), message: message("帮忙 review"), urls: [], automatic: false };
  const submitted: string[] = [];
  await handleRequest(
    request,
    [{ about: request.id, choice: null, text: url }],
    async (target) => {
      submitted.push(target);
    },
    policy,
  );
  assert.deepEqual(submitted, [url]);
  const many = await handleRequest(
    { ...request, urls: Array.from({ length: 8 }, (_, i) => url + i) },
    [],
    async () => {},
  );
  assert.ok(many.ask[0].options.length <= 5);
  assert.ok(many.ask[0].text.length <= 4000);
  const handled = await handleRequest(request, [{ about: request.id, choice: 0 }], async () =>
    assert.fail("no target"),
  );
  assert.equal(handled.ask.length, 0);
});

const mrUrl = (n: number) => `https://gitlab.example.com/team/repo/-/merge_requests/${n}`;
const linked = (...urls: string[]) => ({
  id: "c".repeat(64),
  message: message(urls.join(" ")),
  urls,
  automatic: true,
});
test("a link message with one MR starts it without a card, and an unsettled head becomes a keyed wait", async () => {
  // Guards against a card for an unambiguous link, or a dropped request when the head is still settling.
  const request = linked(url);
  const submitted: string[] = [];
  const done = await handleRequest(request, [], async (target) => {
    submitted.push(target);
  });
  assert.deepEqual(submitted, [url]);
  assert.deepEqual(done, { ask: [], later: [] });
  const wait = { key: "feishu-review:mr:42:7", readyAt: 1_000, url };
  const waiting = await handleRequest(request, [], async () => wait);
  assert.deepEqual(waiting, { ask: [], later: [wait] });
});
test("MRs already delivered drop out before deciding between auto start and one card", async () => {
  // Guards against asking about an MR whose version was already reviewed, or ignoring the one that still needs it.
  const state: Record<string, "delivered" | "closed" | "open"> = {
    [mrUrl(1)]: "delivered",
    [mrUrl(2)]: "open",
    [mrUrl(3)]: "closed",
  };
  const probe = async (target: string) => state[target];
  const submitted: string[] = [];
  const submit = async (target: string) => {
    submitted.push(target);
  };
  const one = await handleRequest(linked(mrUrl(1), mrUrl(2), mrUrl(3)), [], submit, policy, probe);
  assert.deepEqual(submitted, [mrUrl(2)]);
  assert.equal(one.ask.length, 0);
  submitted.length = 0;
  const none = await handleRequest(linked(mrUrl(1), mrUrl(3)), [], submit, policy, probe);
  assert.equal(submitted.length + none.ask.length, 0);
  state[mrUrl(3)] = "open";
  const several = await handleRequest(linked(mrUrl(1), mrUrl(2), mrUrl(3)), [], submit, policy, probe);
  assert.equal(submitted.length, 0);
  assert.equal(several.ask.length, 1);
  assert.deepEqual(several.ask[0].options, ["我来处理", "忽略", "审查 team/repo!2", "审查 team/repo!3"]);
});
test("an answer picks the MR its option names, even after another MR was delivered meanwhile", async () => {
  // Guards against index drift: option 2 meant MR 2 when the card was shown, and must not become MR 3 later.
  const request = linked(mrUrl(1), mrUrl(2), mrUrl(3));
  const submitted: string[] = [];
  await handleRequest(
    request,
    [{ about: request.id, choice: 2, options: ["我来处理", "忽略", "审查 team/repo!2", "审查 team/repo!3"] }],
    async (target) => {
      submitted.push(target);
    },
  );
  assert.deepEqual(submitted, [mrUrl(2)]);
});
