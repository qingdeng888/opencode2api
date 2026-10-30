// Headless regression suite for the WebUI features this fork adds on top of
// upstream: the upstream key page (notes, per-row enable/disable, bulk
// actions), the proxy management page, and the config center's context-limit
// and WARP fields.
//
// Run with: node webui_suite.js webui/app.js
const fs = require("fs");

const elements = {};
function mkEl(id) {
  return {
    id, textContent: "", className: "", dataset: {}, children: [], style: {},
    disabled: false, value: "", checked: false, maxLength: 0, placeholder: "",
    type: "", title: "", options: [], tagName: "", indeterminate: false, colSpan: 0,
    listeners: {},
    appendChild(c) { this.children.push(c); if (c.value !== undefined) this.options.push(c); },
    replaceChildren(...c) { this.children = c; this.options = [...c].filter((x) => x.value !== undefined); },
    append(...c) { this.children.push(...c); },
    remove() {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    onclick: null, onchange: null, onsubmit: null,
  };
}
const q = (s) => { const id = s.replace("#", ""); return elements[id] || (elements[id] = mkEl(id)); };

global.document = {
  querySelector: q,
  querySelectorAll: () => [],
  createElement: (t) => { const e = mkEl("c-" + t); e.tagName = t; return e; },
  documentElement: { setAttribute() {}, getAttribute() { return null; }, removeAttribute() {} },
  hidden: false,
};
global.window = { location: { hash: "", protocol: "http:", hostname: "127.0.0.1" } };
global.location = global.window.location;
global.history = { replaceState() {} };
global.localStorage = { getItem: () => null, setItem() {} };
global.navigator = { clipboard: { writeText: async () => {} } };
global.EventSource = class { close() {} };
global.confirm = () => true;

const CONFIG = {
  listen: "0.0.0.0:37001", proxyfile: "", prefer: "go",
  upstream: { zen: "https://opencode.ai/zen", go: "https://opencode.ai/zen/go", anonymous: "https://opencode.ai/inference" },
  retry: { max_attempts: 3, timeout_seconds: 300 },
  models: { refresh_seconds: 300, protocols: {}, free_only: false, context_limit: 160000 },
  session: { ttl_seconds: 900 },
  performance: {
    max_idle_conns: 2048, max_idle_conns_per_host: 256, max_conns_per_host: 0,
    idle_conn_timeout_seconds: 120, connect_timeout_seconds: 5, failure_cooldown_seconds: 15,
    attempt_timeout_seconds: 0, first_event_timeout_seconds: 0,
    max_anonymous_exits: 8, free_tier_block_seconds: 900,
  },
  logging: { level: "info", ring_size: 2000, dump_request_bodies: false },
  reasoning: { effort: "", effort_by_model: {} },
  warp: { enabled: false, pool_size: 2, stack: "ipv6" },
  webui: { enabled: true, listen: "0.0.0.0:37000", session_ttl_minutes: 720 },
  effective: { listen: "0.0.0.0:37001", webui_listen: "0.0.0.0:37000" },
  server_keys: [], zen_keys: [], go_keys: [], proxies: [], anonymous: true,
  restart_required_fields: [],
};
const PROXIES = [
  { id: "p1", address: "direct", healthy: true, enabled: true, managed: true, source: "default" },
  { id: "p2", address: "http://a:1", healthy: true, enabled: true, managed: true, source: "config" },
];
let keys = [
  { id: "k1", tier: "zen", display: "••••001", note: "主号", index: 0, enabled: true, in_pool: true, proxy: "direct", proxy_mode: "auto", failures: 0 },
  { id: "k2", tier: "zen", display: "••••002", note: "备用", index: 1, enabled: true, in_pool: true, proxy: "direct", proxy_mode: "auto", failures: 0 },
  { id: "k3", tier: "go", display: "••••003", note: "", index: 0, enabled: false, in_pool: false, proxy: "", proxy_mode: "auto", failures: 0 },
];
const state = { enabledPost: null, configPut: null };

const mk = (o) => ({ status: 200, ok: true, json: async () => o });
global.fetch = async (path, opts) => {
  const method = (opts && opts.method) || "GET";
  if (path === "/api/upstream-keys" && method === "GET")
    return mk({ keys: JSON.parse(JSON.stringify(keys)), anonymous: true, proxies: PROXIES });
  if (path === "/api/upstream-keys/enabled") {
    const b = JSON.parse(opts.body); state.enabledPost = b;
    keys = keys.map((k) => b.ids.includes(k.id) ? { ...k, enabled: b.enabled, in_pool: b.enabled, proxy: b.enabled ? "direct" : "" } : k);
    return mk({ keys: JSON.parse(JSON.stringify(keys)), anonymous: true, proxies: PROXIES, changed: b.ids, skipped: [] });
  }
  if (path === "/api/upstream-keys/anonymous") { const b = JSON.parse(opts.body); return mk({ keys, anonymous: b.enabled, proxies: PROXIES }); }
  if (path === "/api/proxies" && method === "GET") return mk({ proxies: JSON.parse(JSON.stringify(PROXIES)) });
  if (path === "/api/proxies/enabled") return mk({ proxies: PROXIES });
  if (path === "/api/config" && method === "GET") return mk(CONFIG);
  if (path === "/api/config" && method === "PUT") { state.configPut = JSON.parse(opts.body); return mk({ result: {}, config: CONFIG }); }
  if (path === "/api/monitor") return mk({ version: "dev", metrics: { last_hour: {}, active_requests: 0, active_streams: 0, series: [], usage: { last_hour: {} } }, upstream: {}, resources: { proxies: PROXIES, keys: [], models: {} }, sessions: { active: 0, ttl_seconds: 900, minted: 0, hits: 0, misses: 0, expired: 0, evictions: 0 } });
  if (path === "/api/debug/models") return mk({ models: [], keys: { zen: [], go: [] }, metadata: {}, catalog: {} });
  return mk({});
};

const src = fs.readFileSync(process.argv[2], "utf8");
const body = src
  .replace(/^boot\(\);$/m, "")
  .replace(/^\$\("#theme-toggle"\)\.onclick[\s\S]*$/m, "")
  + "\nglobalThis.__W={loadProxies,renderProxies,loadUpstreamKeys,loadConfig,"
  + "upkData:()=>upstreamKeyData,upkRows:()=>document.querySelector('#upk-rows').children,"
  + "upkSel:()=>upstreamKeySelected,setUpkEnabled:setUpstreamKeysEnabled,"
  + "selectAllUpk:setAllUpstreamKeysSelected,proxyRows:()=>document.querySelector('#proxy-rows').children};\n";
new Function(body)();
const W = globalThis.__W;

let fail = 0;
const ck = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fail++; };
const rows = () => W.upkRows();
const cellText = (row, i) => {
  const cell = row.children[i];
  const badge = (cell.children || [])[0];
  return badge ? badge.textContent : cell.textContent;
};
const toggleOf = (i) => {
  const actionCell = rows()[i].children[rows()[i].children.length - 1];
  return (actionCell.children || []).find((b) => b.textContent === "启用" || b.textContent === "停用");
};
const allButtons = () => rows().flatMap((r) => r.children[r.children.length - 1].children || []);

(async () => {
  await W.loadUpstreamKeys();
  ck("key page renders three keys", rows().length === 3);
  ck("enabled key shows 启用中", cellText(rows()[0], 4) === "启用中");
  ck("disabled key shows 已停用", cellText(rows()[2], 4) === "已停用");
  ck("disabled row is dimmed", rows()[2].className === "row-disabled");
  ck("note column keeps the operator note", rows()[0].children[3].textContent === "主号");
  ck("per-row toggle matches state", toggleOf(0).textContent === "停用" && toggleOf(2).textContent === "启用");

  await toggleOf(0).onclick();
  ck("row toggle posts a disable", state.enabledPost.enabled === false && state.enabledPost.ids.includes("k1"));
  ck("key state updated without reload", W.upkData()[0].enabled === false);
  ck("row buttons stay clickable after toggle", !allButtons().some((b) => b.disabled));

  await toggleOf(0).onclick();
  ck("row toggle posts an enable", state.enabledPost.enabled === true);
  ck("key enabled again", W.upkData()[0].enabled === true);

  const checkbox = rows()[0].children[0].children[0];
  checkbox.checked = true; checkbox.onchange();
  ck("checkbox selection recorded", W.upkSel()["k1"] === true);
  ck("bulk counter shown", q("#upk-bulk-bar").textContent.includes("已选 1"));
  W.selectAllUpk(true);
  ck("select all picks every key", Object.keys(W.upkSel()).length === 3);
  ck("header checkbox reflects select-all", q("#upk-select-all").checked === true);
  W.selectAllUpk(false);
  ck("deselect all clears", Object.keys(W.upkSel()).length === 0);
  ck("batch buttons disabled with no selection", q("#upk-disable-selected").disabled === true);

  W.selectAllUpk(true);
  await q("#upk-disable-selected").onclick();
  ck("batch disable posts all ids", state.enabledPost.enabled === false && state.enabledPost.ids.length === 3);
  ck("every key disabled", W.upkData().every((k) => k.enabled === false));
  await q("#upk-enable-selected").onclick();
  ck("batch enable posts", state.enabledPost.enabled === true);
  ck("every key enabled again", W.upkData().every((k) => k.enabled === true));

  await W.loadProxies();
  ck("proxy page renders both proxies", W.proxyRows().length === 2);

  await W.loadConfig();
  ck("context limit loaded", q("#c-context-limit").value === 160000);
  ck("warp enabled loaded", q("#c-warp-enabled").checked === false);
  ck("warp pool size loaded", Number(q("#c-warp-pool-size").value) === 2);
  ck("warp stack loaded", q("#c-warp-stack").value === "ipv6");

  q("#c-context-limit").value = "150000";
  q("#c-warp-enabled").checked = true;
  q("#c-warp-pool-size").value = "4";
  const submit = q("#config-form").listeners["submit"] || [];
  ck("config form registers a submit handler", submit.length === 1);
  for (const handler of submit) await handler({ preventDefault() {} });
  ck("submits models.context_limit", state.configPut.models.context_limit === 150000);
  ck("submits warp.enabled", state.configPut.warp.enabled === true);
  ck("submits warp.pool_size", state.configPut.warp.pool_size === 4);
  ck("omits secrets so the backend keeps them", state.configPut.server_keys === undefined && state.configPut.zen_keys === undefined);

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
  process.exit(fail ? 1 : 0);
})();
