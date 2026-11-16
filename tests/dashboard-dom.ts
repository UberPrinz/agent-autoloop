import { startDashboardApp } from "../dashboard/public/app-controller.js";
// Minimal DOM double: just enough tree, ordering and focus behaviour for the dashboard controller.
export function documentFixture() {
  const listeners: Record<string, Function> = {};
  let activeElement: any = null;
  const contains = (parent: any, target: any): boolean =>
    parent === target || parent.children.some((child: any) => contains(child, target));
  const node = (tag = "div"): any => ({
    tagName: tag,
    listeners: {} as Record<string, Function>,
    children: [] as any[],
    parent: null as any,
    textContent: "",
    className: "",
    hidden: false,
    append(...items: any[]) {
      for (const item of items) {
        item.remove?.();
        item.parent = this;
        this.children.push(item);
      }
    },
    replaceChildren(...items: any[]) {
      if (contains(this, activeElement)) activeElement = null;
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...items);
    },
    insertBefore(item: any, ref: any) {
      item.remove();
      item.parent = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(item);
      else this.children.splice(at, 0, item);
    },
    remove() {
      if (!this.parent) return;
      if (contains(this, activeElement)) activeElement = null;
      this.parent.children = this.parent.children.filter((child: any) => child !== this);
      this.parent = null;
    },
    setAttribute() {},
    addEventListener(name: string, fn: Function) {
      this.listeners[name] = fn;
    },
    dispatch(name: string) {
      this.listeners[name]?.();
    },
    focus() {
      activeElement = this;
    },
  });
  const nodes = Object.fromEntries(
    ["summary", "waiting", "scheduled", "detail", "detail-empty", "status", "notice", "layout", "refresh"].map((id) => [
      id,
      node(),
    ]),
  );
  return {
    hidden: false,
    createElement: node,
    get activeElement() {
      return activeElement;
    },
    getElementById: (id: string) => {
      const find = (parent: any): any => (parent.id === id ? parent : parent.children.map(find).find(Boolean));
      return nodes[id] || Object.values(nodes).map(find).find(Boolean);
    },
    addEventListener: (name: string, fn: Function) => (listeners[name] = fn),
    removeEventListener() {},
    dispatch: (name: string) => listeners[name]?.(),
    nodes,
  };
}
export function response(value: unknown, status = 200, instance = "instance") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "x-dashboard-instance": instance, "content-type": "application/json" },
  });
}
export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
export function app(fetchImpl: typeof fetch) {
  const document = documentFixture();
  const app = startDashboardApp({ document: document as any, fetchImpl, setTimer: () => 0, clearTimer: () => {} });
  return { app, document };
}
export const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
export const textOf = (node: any): string => node.textContent + node.children.map(textOf).join("");
