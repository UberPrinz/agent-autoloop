import { createApi, ApiError } from "./api.js";
import { buildOverviewModel, safeLink, time } from "./view-model.js";
/** @typedef {import('../src/types.ts').Card} Card */
/** @typedef {{choice:number|null,pending:boolean,message:string,uncertain:boolean,reconciled:boolean }} Action */
/** @param {{document:Document,fetchImpl?:typeof fetch,setTimer?:(fn:()=>void,ms:number)=>any,clearTimer?:(handle:any)=>void,interval?:number}} options */
export function startDashboardApp({
  document,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  interval = 10000,
}) {
  const api = createApi({ fetchImpl });
  /** @type {import('../src/types.ts').State|null} */ let snapshot = null;
  /** @type {string|null} */ let instance = null;
  /** @type {number|null} */ let opened = null;
  /** @type {Map<number,Action>} */ const actions = new Map();
  const handled = new Set();
  /** @type {Map<number,boolean>} */ const expanded = new Map();
  let generation = 0,
    reloadRequired = false,
    disposed = false,
    noticeText = "";
  /** @type {Promise<void>|null} */ let pendingRead = null;
  /** @type {any} */ let timer = null;
  let lastSuccess = "",
    error = "";
  /** @param {string} id */ const root = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少页面区域 ${id}`);
    return node;
  };
  /** @param {number} id */ function action(id) {
    if (!actions.has(id))
      actions.set(id, {
        choice: null,
        pending: false,
        message: "",
        uncertain: false,
        reconciled: false,
      });
    return /** @type {Action} */ (actions.get(id));
  }
  /** @param {string} tag @param {string} [text] @param {string} [className] */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  /** @param {string} text @param {()=>void} click @param {string} [id] */
  function button(text, click, id) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    if (id) node.id = id;
    node.addEventListener("click", click);
    return node;
  }
  /** @param {any} node @param {string} text */
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }
  /** Reorders without recreating nodes, so focus and scroll survive a refresh. @param {any} parent @param {any[]} wanted */
  function sync(parent, wanted) {
    wanted.forEach((node, index) => {
      if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
    });
    while (parent.children.length > wanted.length) parent.children[parent.children.length - 1].remove();
  }
  function model() {
    return snapshot
      ? buildOverviewModel({ ...snapshot, cards: snapshot.cards.filter((card) => !handled.has(card.id)) })
      : null;
  }
  function currentCard() {
    return (
      snapshot?.cards.find((card) => card.id === opened) ||
      snapshot?.recentCards.find((card) => card.id === opened) ||
      null
    );
  }
  /** @type {Card|null} */ let detailCard = null;
  /** @param {Card|null} card @param {Action|null} item */
  function canAct(card, item) {
    return !!(
      card &&
      item &&
      card.state === "open" &&
      !handled.has(card.id) &&
      !reloadRequired &&
      !item.pending &&
      (!item.uncertain || item.reconciled)
    );
  }
  function getView() {
    const item = opened === null ? null : action(opened),
      card = currentCard(),
      m = model();
    return {
      model: m,
      opened,
      selection: item?.choice ?? null,
      message: item?.message || "",
      notice: noticeText,
      reloadRequired,
      groups: m
        ? m.groups.map((group) => ({ key: group.key, label: group.label, ids: group.cards.map((c) => c.id) }))
        : [],
      canSubmit: !!(
        canAct(card, item) &&
        card &&
        ["ask", "notice"].includes(card.kind) &&
        card.options.length &&
        (card.kind === "notice" || item?.choice !== null)
      ),
    };
  }
  function pane() {
    return opened !== null ? "card" : "none";
  }
  /** @type {string|null} */ let detailSignature = null;
  function signature() {
    const card = currentCard() || detailCard,
      item = opened === null ? null : action(opened);
    return JSON.stringify([
      pane(),
      opened,
      card && [
        card.id,
        card.version,
        card.state,
        card.title,
        card.text,
        card.options,
        card.recommend,
        card.kind,
        card.link,
        card.rule,
      ],
      item && [item.choice, item.pending, item.message, item.uncertain, item.reconciled],
      handled.has(opened ?? -1),
      reloadRequired,
      snapshot?.timezone,
    ]);
  }
  function renderDetail() {
    const mode = pane();
    const layout = root("layout");
    const className = mode === "none" ? "layout" : "layout show-detail";
    if (layout.className !== className) layout.className = className;
    const detail = root("detail");
    root("detail-empty").hidden = mode !== "none";
    detail.hidden = mode === "none";
    const sig = signature();
    if (sig === detailSignature) return;
    detailSignature = sig;
    const focus = document.activeElement?.id;
    detail.replaceChildren();
    if (mode === "none") return;
    renderCardPane(detail);
    if (focus) {
      const again = document.getElementById(focus);
      again?.focus({ preventScroll: true });
    }
  }
  /** @param {any} detail */
  function renderCardPane(detail) {
    if (opened === null) return;
    const card = currentCard() || detailCard,
      item = action(opened);
    if (!card) return;
    const close = button("返回", back, `close-card-${card.id}`);
    close.className = "back";
    detail.append(
      close,
      el("h2", card.title),
      el(
        "p",
        `${card.rule || (card.kind === "notice" ? "系统通知" : "未关联规则")} · ${time(card.createdAt, snapshot?.timezone || "UTC")}`,
        "meta",
      ),
    );
    const report = document.createElement("details");
    report.open = expanded.get(card.id) ?? card.text.length < 800;
    report.addEventListener("toggle", () => expanded.set(card.id, report.open));
    const disclosure = el("summary", "完整内容");
    disclosure.id = `report-${card.id}`;
    report.append(disclosure, el("pre", card.text, "report"));
    detail.append(report);
    const link = safeLink(card.link);
    if (link) {
      const anchor = document.createElement("a");
      anchor.id = `link-${card.id}`;
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = "查看相关链接";
      detail.append(anchor);
    }
    const dock = el("div", undefined, "dock");
    const controls = document.createElement("fieldset");
    const view = getView();
    controls.disabled =
      item.pending ||
      reloadRequired ||
      handled.has(card.id) ||
      card.state !== "open" ||
      (item.uncertain && !item.reconciled);
    if (card.kind === "ask" && card.options.length) {
      controls.append(el("legend", "选择处理方式"));
      card.options.forEach((option, index) => {
        const label = el("label", undefined, "option"),
          input = document.createElement("input");
        input.type = "radio";
        input.id = `choice-${card.id}-${index}`;
        input.name = `card-${card.id}`;
        input.value = String(index);
        input.checked = item.choice === index;
        input.addEventListener("change", () => choose(index));
        label.append(input, el("span", `${option}${card.recommend === index ? "（建议）" : ""}`));
        controls.append(label);
      });
    } else if (card.kind === "ask") detail.append(el("p", "此问题需要文字回答，请使用原通道或命令行"));
    else if (card.kind !== "notice") detail.append(el("p", "此卡片类型暂不支持，请使用原通道或命令行"));
    if (["ask", "notice"].includes(card.kind) && card.options.length) {
      const submitButton = button(
        item.pending
          ? "正在提交…"
          : card.kind === "notice"
            ? "已处理"
            : item.choice === null
              ? "请先选择处理方式"
              : `确认：${card.options[item.choice]}`,
        () => {
          void submit();
        },
        `submit-${card.id}`,
      );
      submitButton.disabled = !view.canSubmit;
      submitButton.className = "primary";
      controls.append(submitButton);
    }
    dock.append(controls);
    const message = el("p", reloadRequired ? "看板已重启，请重新加载页面后操作" : item.message, "decision");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    dock.append(message);
    detail.append(dock);
  }
  /** @type {Map<number,{node:any,open:any,meta:any,text:any}>} */ const rows = new Map();
  /** @type {Map<string,{node:any,title:any,label:any,count:any,list:any,href:string|null,text:string}>} */ const groups =
    new Map();
  /** @type {{heading:any,empty:any,box:any}|null} */ let shell = null;
  function ensureShell() {
    if (shell) return shell;
    const waiting = root("waiting");
    const heading = el("h2", undefined, "panel-head");
    const count = el("span", "", "count");
    heading.append(el("span", "待我处理", "tag"), count);
    const empty = el("p", "暂时没有需要你处理的事项", "empty");
    const box = el("div", undefined, "groups");
    waiting.replaceChildren(heading, el("div", undefined, "ruler"), empty, box);
    shell = { heading: count, empty, box };
    return shell;
  }
  /** @param {any} card @param {string} timezone */
  function rowFor(card, timezone) {
    let row = rows.get(card.id);
    if (!row) {
      const node = el("article", undefined, "entry");
      const id = card.id;
      const open = button("", () => openCard(id), `open-card-${id}`);
      const meta = el("span", "", "meta");
      const text = el("p", "", "card-preview");
      const dot = el("span", undefined, `dot ${card.kind === "notice" ? "notice" : "ask"}`);
      node.append(dot, open, meta, text);
      row = { node, open, meta, text };
      rows.set(card.id, row);
    }
    setText(row.open, card.title);
    setText(
      row.meta,
      `${card.rule || (card.kind === "notice" ? "系统通知" : "未关联规则")} · ${time(card.createdAt, timezone)}`,
    );
    setText(row.text, (card.mr ? card.brief : card.preview) || "");
    row.text.hidden = !row.text.textContent;
    const className = opened === card.id && pane() === "card" ? "entry current" : "entry";
    if (row.node.className !== className) row.node.className = className;
    return row;
  }
  /** @param {ReturnType<typeof buildOverviewModel>["groups"][number]} group */
  function groupFor(group) {
    let ui = groups.get(group.key);
    if (!ui) {
      const node = el("section", undefined, "group");
      const title = el("h3", undefined, "group-title");
      const count = el("span", "", "meta");
      const list = el("div", undefined, "group-list");
      node.append(title, count, list);
      ui = { node, title, label: null, count, list, href: null, text: "" };
      groups.set(group.key, ui);
    }
    if (!ui.label || ui.href !== group.href || ui.text !== group.label) {
      if (ui.label && ui.href === group.href) setText(ui.label, group.label);
      else {
        let label;
        if (group.href) {
          label = document.createElement("a");
          label.id = `reference-group-${group.key}`;
          label.href = group.href;
          label.target = "_blank";
          label.rel = "noopener noreferrer";
          label.textContent = group.label;
        } else label = el("span", group.label);
        ui.title.replaceChildren(label);
        ui.label = label;
      }
      ui.href = group.href;
      ui.text = group.label;
    }
    setText(ui.count, `${group.cards.length} 张`);
    return ui;
  }
  /** @param {ReturnType<typeof buildOverviewModel>} m */
  function renderList(m) {
    const ui = ensureShell();
    setText(ui.heading, `${m.waiting} 张`);
    ui.empty.hidden = m.waiting > 0;
    const liveIds = new Set(m.cards.map((card) => card.id));
    for (const id of [...rows.keys()]) if (!liveIds.has(id)) rows.delete(id);
    const liveKeys = new Set(m.groups.map((group) => group.key));
    for (const key of [...groups.keys()]) if (!liveKeys.has(key)) groups.delete(key);
    const wanted = [];
    for (const group of m.groups) {
      const g = groupFor(group);
      sync(
        g.list,
        group.cards.map((card) => rowFor(card, m.timezone).node),
      );
      wanted.push(g.node);
    }
    sync(ui.box, wanted);
  }
  let scheduledSignature = "";
  /** @param {ReturnType<typeof buildOverviewModel>} m */
  function renderScheduled(m) {
    const sig = JSON.stringify([m.timezone, m.scheduled]);
    if (sig === scheduledSignature) return;
    scheduledSignature = sig;
    const scheduled = root("scheduled");
    scheduled.replaceChildren(
      el("summary", `定时任务 · ${m.scheduled.length}`),
      el("p", `计划时间 · ${m.timezone}；实际执行可能排队`, "meta"),
    );
    if (!m.scheduled.length) scheduled.append(el("p", "暂无定时任务", "empty"));
    for (const task of m.scheduled) {
      const row = el("article", undefined, "task");
      row.append(
        el("h3", task.name),
        el("p", `${task.key} · ${task.every}`, "meta"),
        el("p", `下次计划：${task.next}`),
        el("p", task.status, "meta"),
      );
      scheduled.append(row);
    }
  }
  function render() {
    const focus = document.activeElement?.id;
    const view = getView(),
      m = view.model;
    root("status").textContent = reloadRequired
      ? "看板已重启，请重新加载页面"
      : error
        ? `读取失败：${error}${lastSuccess ? ` · 最后更新 ${lastSuccess}（数据已过期）` : ""}`
        : lastSuccess
          ? `最后更新 ${lastSuccess}`
          : "正在读取…";
    root("status").className = error || reloadRequired ? "status-error" : "status-ok";
    setText(root("notice"), noticeText);
    if (m) {
      setText(root("summary"), `待处理 ${m.waiting} · 在跑 ${m.running} · 今日完成 ${m.doneToday}`);
      renderList(m);
      renderScheduled(m);
    }
    renderDetail();
    if (focus && document.activeElement?.id !== focus) document.getElementById(focus)?.focus({ preventScroll: true });
  }
  function reconcile() {
    if (!snapshot) return;
    for (const [id, item] of actions) {
      if (!item.uncertain || item.pending) continue;
      const card = snapshot.cards.find((c) => c.id === id && c.state === "open"),
        record = snapshot.recentCards.find((c) => c.id === id);
      item.reconciled = true;
      if (card) {
        item.message = "上次结果未确认，卡片仍开放；如需再次提交，请明确点击确认。";
      } else if (record) {
        item.message = `中台已记录：${record.choice === null ? record.answer || record.state : record.options[record.choice] || record.state} · ${record.by || "未记录回答者"} · ${time(record.decidedAt || record.closedAt, snapshot.timezone)}${record.result ? ` · ${record.result}` : ""}。此记录不证明由本次请求提交。`;
        handled.add(id);
      } else {
        item.message = "已不在待处理列表，提交结果未能核实";
        handled.add(id);
      }
    }
  }
  function refresh() {
    if (disposed) return Promise.resolve();
    if (pendingRead) return pendingRead;
    const readGeneration = generation;
    const promise = (async () => {
      try {
        const result = await api.state();
        if (disposed || readGeneration !== generation) return;
        if (instance && instance !== result.instance) {
          reloadRequired = true;
          render();
          return;
        }
        instance ||= result.instance;
        snapshot = result.state;
        lastSuccess = time(snapshot.now, snapshot.timezone);
        error = "";
        reconcile();
        render();
      } catch (err) {
        if (disposed || readGeneration !== generation) return;
        error = err instanceof Error ? err.message : "连接失败";
        render();
      }
    })().finally(() => {
      if (pendingRead === promise) pendingRead = null;
    });
    pendingRead = promise;
    return promise;
  }
  /** @param {number} id */ function open(id) {
    const card = snapshot?.cards.find((c) => c.id === id);
    if (!card) return;
    opened = id;
    detailCard = card;
    render();
  }
  const openCard = open;
  function back() {
    opened = null;
    render();
  }
  /** @param {number} choice */ function choose(choice) {
    if (opened === null) return;
    const item = action(opened),
      card = currentCard();
    if (
      item.pending ||
      reloadRequired ||
      !card ||
      !Number.isSafeInteger(choice) ||
      choice < 0 ||
      choice >= card.options.length
    )
      return;
    item.choice = choice;
    renderDetail();
  }
  /** @param {number} id Card shown after id is handled: the one below it, else the one above. */
  function nextAfter(id) {
    const order = (model()?.cards || []).map((card) => card.id);
    const at = order.indexOf(id);
    return order[at + 1] ?? order[at - 1] ?? null;
  }
  /** @param {number} id @param {()=>Promise<{changed:boolean}>} call @param {(changed:boolean)=>string} done */
  async function send(id, call, done) {
    const item = action(id),
      card = currentCard();
    if (!card) return;
    item.pending = true;
    item.message = "正在提交…";
    noticeText = "";
    generation++;
    pendingRead = null;
    render();
    try {
      const result = await call();
      const next = opened === id ? nextAfter(id) : null;
      handled.add(id);
      item.uncertain = false;
      item.message = done(result.changed);
      noticeText = `${item.message}：${card.title}`;
      if (next !== null) {
        opened = next;
        detailCard = snapshot?.cards.find((c) => c.id === next) || null;
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "OUTCOME_UNKNOWN";
      if (code === "PAGE_RELOAD_REQUIRED") reloadRequired = true;
      item.uncertain = code === "OUTCOME_UNKNOWN" || code === "CARD_UNAVAILABLE";
      item.reconciled = false;
      item.message = err instanceof Error ? err.message : "结果待核实";
    } finally {
      item.pending = false;
      generation++;
      pendingRead = null;
      render();
      await refresh();
    }
  }
  async function submit() {
    if (opened === null || !instance || !getView().canSubmit) return;
    const id = opened,
      item = action(id),
      card = currentCard(),
      key = instance;
    if (!card) return;
    await send(
      id,
      () => api.answer(id, card.kind === "notice" ? 0 : /** @type {number} */ (item.choice), key),
      (changed) => (changed ? (card.kind === "notice" ? "通知已处理" : "决定已提交") : "此卡片已被处理，本次未更改"),
    );
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (disposed || document.hidden) return;
    timer = setTimer(() => {
      timer = null;
      void refresh();
      schedule();
    }, interval);
  }
  const visibility = () => {
    if (!document.hidden) void refresh();
    schedule();
  };
  document.addEventListener("visibilitychange", visibility);
  root("refresh").addEventListener("click", () => {
    void refresh();
  });
  const ready = refresh();
  schedule();
  return {
    ready,
    refresh,
    open,
    back,
    choose,
    submit,
    getView,
    dispose() {
      disposed = true;
      generation++;
      if (timer !== null) clearTimer(timer);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
