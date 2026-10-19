const $ = (selector) => document.querySelector(selector),
  $$ = (selector) => [...document.querySelectorAll(selector)];
let csrf = "",
  config = null,
  monitorData = null,
  debugData = null,
  lastPlayground = null,
  logEvents = [],
  eventSource = null,
  paused = false,
  monitorTimer = null,
  logRenderPending = false,
  toastTimer = null;
const pages = {
  availability: ["13", "免费模型可用性", "每小时探测，手动控制的模型不受影响。"],
  rotation: ["12", "模型轮转", "共享当前模型、故障切换与尝试记录。"],
  proxies: ["14", "代理管理", "出站代理池的新增、删除与逐个连通性测试。"],
  "upstream-keys": ["15", "上游 Key 管理", "Zen / Go 上游凭证、备注与匿名通道开关。"],
  overview: ["01", "运行桌面", "最近一小时、进程累计与当前资源状态。"],
  guide: ["02", "首次运行", "用六个检查点完成从配置到首个请求。"],
  access: ["03", "接入手册", "Chat、Responses、Anthropic 与 SDK 示例。"],
  usage: ["04", "Token 用量", "覆盖率、每分钟趋势、模型排行与 Tier 分布。"],
  playground: ["05", "Playground", "三种入口协议共用真实 Gateway 路由与诊断。"],
  diagnostics: ["06", "路由诊断", "Metadata、模型资格与每一次上游尝试。"],
  config: ["07", "配置中心", "验证后原子保存，并热应用可变字段。"],
  logs: ["08", "事件日志", "来自进程内 Ring Buffer 的结构化 SSE。"],
  account: ["09", "账号安全", "更新后撤销全部管理 Session。"],
  "model-quotas": ["10", "模型与额度", "可用模型、共享套餐剩余额度与重置时间。"],
  "api-keys": ["11", "API Key 管理", "给每个调用方独立的访问密钥。"],
};
async function api(path, options = {}) {
  options.headers = { ...(options.headers || {}), Accept: "application/json" };
  if (options.body) options.headers["Content-Type"] = "application/json";
  if (csrf && !["GET", "HEAD"].includes(options.method || "GET"))
    options.headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, options);
  if (response.status === 401) {
    showLogin();
    throw new Error("登录已失效");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}
function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("bad-toast", bad);
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3600);
}
function showLogin() {
  csrf = "";
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  if (eventSource) eventSource.close();
  eventSource = null;
  clearInterval(monitorTimer);
  clearInterval(quotaTimer);
  clearCreatedKey();
  $("#api-key-value").value = "";
}
async function enterConsole(session) {
  csrf = session.csrf_token;
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await loadConfig();
  await Promise.all([refreshMonitor(), loadDebugModels(), loadProxies(true)]);
  clearInterval(monitorTimer);
  monitorTimer = setInterval(refreshMonitor, 3000);  connectLogs();
  openPage(pages[location.hash.slice(1)] ? location.hash.slice(1) : "overview");
}
async function boot() {
  try {
    await enterConsole(await api("/api/auth/session"));
  } catch (_) {
    showLogin();
  }
}
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
    });
    $("#login-pass").value = "";
    await enterConsole(session);
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});
$("#logout").onclick = async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    showLogin();
  }
};
function openPage(page) {
  if (!pages[page]) return;
  history.replaceState(null, "", `#${page}`);
  clearInterval(quotaTimer);
  if (page !== "api-keys") clearCreatedKey();
  $$(".nav button").forEach((button) =>
    button.classList.toggle("active", button.dataset.page === page),
  );
  $$(".page").forEach((node) => node.classList.toggle("hidden", node.id !== `page-${page}`));
  const meta = pages[page];
  $("#page-index").textContent = `Section ${meta[0]}`;
  $("#page-title").textContent = meta[1];
  $("#page-sub").textContent = meta[2];
  if (page === "access") renderAccessExamples();
  if (page === "usage") renderUsage();
  if (page === "model-quotas") {
    loadModelQuotas();
    quotaTimer = setInterval(() => {
      if (!document.hidden) loadModelQuotas();
    }, 60000);
  }
  if (page === "rotation") loadRotation();
  if (page === "proxies") loadProxies();
  if (page === "upstream-keys") loadUpstreamKeys();
  if (page === "availability") loadAvailability();
  if (page === "api-keys") loadAPIKeys();
  if (page === "playground" && !debugData) loadDebugModels();
  if (page === "diagnostics") {
    loadDebugModels();
    renderDiagnostics();
  }
}
$$(".nav button").forEach((button) => (button.onclick = () => openPage(button.dataset.page)));
async function loadConfig() {
  config = await api("/api/config");
  fillConfig(config);
  renderAccessExamples();
}
function fillConfig(value) {
  $("#c-listen").value = value.listen;
  $("#c-prefer").value = value.prefer;
  $("#c-web-listen").value = value.webui.listen;
  $("#c-session").value = value.webui.session_ttl_minutes;
  $("#c-web-enabled").checked = value.webui.enabled;
  $("#c-proxyfile").value = value.proxyfile;
  $("#c-up-zen").value = value.upstream.zen;
  $("#c-up-go").value = value.upstream.go;
  $("#c-attempts").value = value.retry.max_attempts;
  $("#c-timeout").value = value.retry.timeout_seconds;
  $("#c-refresh").value = value.models.refresh_seconds;
  $("#c-session-ttl").value = value.session?.ttl_seconds ?? 900;
  $("#c-protocols").value = JSON.stringify(value.models.protocols || {}, null, 2);
  $("#c-free-only").checked = !!value.models.free_only;
  $("#c-context-limit").value = value.models.context_limit ?? 160000;
  const reasoning = value.reasoning || {};
  $("#c-reasoning-effort").value = reasoning.effort || "";
  $("#c-reasoning-by-model").value = JSON.stringify(reasoning.effort_by_model || {}, null, 2);
  $("#c-idle").value = value.performance.max_idle_conns;
  $("#c-idle-host").value = value.performance.max_idle_conns_per_host;
  $("#c-max-host").value = value.performance.max_conns_per_host;
  $("#c-idle-timeout").value = value.performance.idle_conn_timeout_seconds;
  $("#c-connect").value = value.performance.connect_timeout_seconds;
  $("#c-cooldown").value = value.performance.failure_cooldown_seconds;
  $("#c-attempt-timeout").value = value.performance.attempt_timeout_seconds;
  $("#c-first-event-timeout").value = value.performance.first_event_timeout_seconds || 0;
  $("#c-level").value = value.logging.level;
  $("#c-ring").value = value.logging.ring_size;
  $("#c-dump-bodies").checked = !!value.logging.dump_request_bodies;
  const notice = $("#restart-notice");
  if (value.restart_required_fields?.length) {
    notice.textContent = `已保存但尚未生效：${value.restart_required_fields.join(", ")}。当前 API ${value.effective.listen}、WebUI ${value.effective.webui_listen}。请重启进程。`;
    notice.classList.remove("hidden");
  } else notice.classList.add("hidden");
}
const number = (id) => Number($(id).value);
$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    // server_keys / zen_keys / go_keys / anonymous / proxies are intentionally
    // omitted: the backend keeps the current values for absent list fields,
    // and those secrets are owned by the API Key / upstream key / proxy pages.
    const update = {
      listen: $("#c-listen").value,
      proxyfile: $("#c-proxyfile").value,
      prefer: $("#c-prefer").value,
      upstream: { zen: $("#c-up-zen").value, go: $("#c-up-go").value },
      retry: { max_attempts: number("#c-attempts"), timeout_seconds: number("#c-timeout") },
      models: {
        refresh_seconds: number("#c-refresh"),
        protocols: JSON.parse($("#c-protocols").value || "{}"),
        free_only: $("#c-free-only").checked,
        context_limit: number("#c-context-limit"),
      },
      session: { ttl_seconds: number("#c-session-ttl") },
      reasoning: {
        effort: $("#c-reasoning-effort").value,
        effort_by_model: JSON.parse($("#c-reasoning-by-model").value || "{}"),
      },
      performance: {
        max_idle_conns: number("#c-idle"),
        max_idle_conns_per_host: number("#c-idle-host"),
        max_conns_per_host: number("#c-max-host"),
        idle_conn_timeout_seconds: number("#c-idle-timeout"),
        connect_timeout_seconds: number("#c-connect"),
        failure_cooldown_seconds: number("#c-cooldown"),
        attempt_timeout_seconds: number("#c-attempt-timeout"),
        first_event_timeout_seconds: number("#c-first-event-timeout"),
      },
      logging: {
        level: $("#c-level").value,
        ring_size: number("#c-ring"),
        dump_request_bodies: $("#c-dump-bodies").checked,
      },
      webui: {
        enabled: $("#c-web-enabled").checked,
        listen: $("#c-web-listen").value,
        username: config.webui.username,
        session_ttl_minutes: number("#c-session"),
      },
    };
    const result = await api("/api/config", { method: "PUT", body: JSON.stringify(update) });
    config = result.config;
    fillConfig(config);
    await loadDebugModels();
    await loadProxies(true);
    toast(
      result.result.restart_required
        ? `已应用；${result.result.restart_fields.join(", ")} 需重启`
        : "配置已保存并立即应用",
    );
  } catch (error) {
    toast(error.message, true);
  }
});
$("#reload-config").onclick = async () => {
  try {
    const result = await api("/api/config/reload", { method: "POST", body: "{}" });
    await loadConfig();
    await loadDebugModels();
    await loadProxies(true);
    toast(result.restart_required ? "磁盘配置已重载，监听字段需重启" : "磁盘配置已重载");
  } catch (error) {
    toast(error.message, true);
  }
};
$("#reveal").onclick = async () => {
  const password = prompt("请再次输入管理密码");
  if (password === null) return;
  try {
    const values = await api("/api/config/reveal", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    $("#modal-content").textContent = JSON.stringify(values, null, 2);
    $("#modal").classList.remove("hidden");
  } catch (error) {
    toast(error.message, true);
  }
};
$("#modal-close").onclick = () => {
  $("#modal").classList.add("hidden");
  $("#modal-content").textContent = "";
};
$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/account", {
      method: "PUT",
      body: JSON.stringify({
        current_password: $("#a-current").value,
        username: $("#a-user").value,
        new_password: $("#a-new").value,
      }),
    });
    toast("账号已更新，请重新登录");
    setTimeout(showLogin, 800);
  } catch (error) {
    toast(error.message, true);
  }
});
function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(value);
  if (className) cell.className = className;
  row.appendChild(cell);
}
function emptyRow(host, columns, message = "暂无数据") {
  const row = document.createElement("tr"),
    cell = document.createElement("td");
  cell.colSpan = columns;
  cell.className = "empty";
  cell.textContent = message;
  row.appendChild(cell);
  host.appendChild(row);
}
/* ===== 代理管理（独立页）：列表 / 添加 / 批量 / 逐个连通性测试 ===== */
let proxyData = [],
  proxyTestResults = {},
  proxyTestRunning = {},
  proxyMeta = {},
  proxyBatchRunning = false;
const proxySourceLabel = { config: "配置", proxyfile: "文件", default: "默认" };
async function loadProxies(silent = false) {
  try {
    const data = await api("/api/proxies");
    proxyData = data.proxies || [];
    proxyMeta = data;
    renderProxies(data);
    if (!silent) $("#proxy-error").textContent = "";
  } catch (error) {
    if (!silent) {
      $("#proxy-error").textContent = error.message;
      toast(error.message, true);
    }
  }
}

function renderProxies(data = {}) {
  const cards = $("#proxy-cards");
  cards.replaceChildren();
  const healthy = proxyData.filter((proxy) => proxy.healthy).length;
  [
    ["代理总数", proxyData.length, ""],
    ["健康", healthy, "green"],
    ["不可用", proxyData.length - healthy, proxyData.length - healthy ? "red" : "green"],
    ["匿名通道", data.anonymous ? "开" : "关", data.anonymous ? "green" : ""],
  ].forEach(([label, value, tone]) => {
    const stat = document.createElement("div");
    stat.className = "conn-stat";
    const num = document.createElement("div");
    num.className = `num ${tone}`;
    num.textContent = value;
    const name = document.createElement("div");
    name.className = "label";
    name.textContent = label;
    stat.append(num, name);
    cards.appendChild(stat);
  });
  const hint = document.createElement("div");
  hint.className = "section-caption";
  hint.textContent = data.proxyfile
    ? `另有 proxyfile（${data.proxyfile}）条目参与路由，不可在此页删除。`
    : "全部代理均来自本页配置，可直接管理。";
  cards.appendChild(hint);
  const rows = $("#proxy-rows");
  rows.replaceChildren();
  proxyData.forEach((proxy) => {
    const row = document.createElement("tr");
    const checkCell = document.createElement("td");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "proxy-check";
    check.dataset.pid = proxy.id;
    check.checked = !!proxyTestResults[proxy.id]?.selected;
    check.onchange = () => {
      proxyTestResults[proxy.id] = { ...(proxyTestResults[proxy.id] || {}), selected: check.checked };
      updateProxyBulkCount();
    };
    checkCell.appendChild(check);
    row.appendChild(checkCell);
    appendCell(row, proxy.address);
    appendCell(row, proxySourceLabel[proxy.source] || proxy.source);
    if (proxy.enabled === false) {
      appendCell(row, "已停用", "status warn");
    } else {
      appendCell(row, proxy.healthy ? "正常" : "不可用", `status ${proxy.healthy ? "ok" : "bad"}`);
    }
    appendCell(row, proxy.enabled === false ? "—" : `Z ${proxy.zen_keys} · G ${proxy.go_keys}`);
    appendCell(row, proxy.enabled === false ? "—" : proxy.anonymous ? "轮询" : "—");
    const testCell = document.createElement("td");
    const last = proxyTestResults[proxy.id]?.last;
    if (proxyTestRunning[proxy.id]) {
      testCell.innerHTML = '<span class="loading"></span> 测试中…';
    } else if (last) {
      testCell.className = last.ok ? "proxy-test-ok" : "proxy-test-fail";
      testCell.textContent = last.ok
        ? `✅ HTTP ${last.status} · ${last.latency_ms}ms`
        : `❌ ${last.error || "失败"} · ${last.latency_ms}ms`;
    } else {
      testCell.textContent = "未测试";
    }
    row.appendChild(testCell);
    const actions = document.createElement("td");
    actions.className = "key-actions";
    const testButton = document.createElement("button");
    testButton.className = "ghost";
    testButton.textContent = "⚡ 测试";
    testButton.disabled = !!proxyTestRunning[proxy.id] || proxyBatchRunning || proxy.enabled === false;
    testButton.title = proxy.enabled === false ? "已停用的代理不参与路由，无需测试" : "";
    testButton.onclick = () => testProxy(proxy.id);
    actions.appendChild(testButton);
    if (proxy.managed) {
      const toggleButton = document.createElement("button");
      toggleButton.className = "ghost";
      toggleButton.textContent = proxy.enabled === false ? "启用" : "停用";
      toggleButton.disabled = proxyBatchRunning;
      toggleButton.onclick = () => setProxiesEnabled([proxy.id], proxy.enabled === false);
      actions.appendChild(toggleButton);
      const delButton = document.createElement("button");
      delButton.className = "ghost";
      delButton.textContent = "删除";
      delButton.onclick = () => deleteProxy(proxy);
      actions.appendChild(delButton);
    }
    row.appendChild(actions);
    rows.appendChild(row);
  });
  if (!proxyData.length) emptyRow(rows, 8, "暂无代理");
  updateProxyBulkCount();
}
function proxySelectedIds() {
  return proxyData.filter((proxy) => proxyTestResults[proxy.id]?.selected).map((proxy) => proxy.id);
}
function setAllProxySelected(selected) {
  proxyData.forEach((proxy) => {
    proxyTestResults[proxy.id] = { ...(proxyTestResults[proxy.id] || {}), selected };
  });
  renderProxies(proxyMeta);
}
function updateProxyBulkCount() {
  const count = proxySelectedIds().length;
  const bar = $("#proxy-bulk-bar");
  if (bar) bar.textContent = count ? `已选 ${count} / 共 ${proxyData.length} 个` : "";
  const all = $("#proxy-select-all");
  if (all) {
    all.checked = proxyData.length > 0 && count === proxyData.length;
    all.indeterminate = count > 0 && count < proxyData.length;
  }
  const testBtn = $("#proxy-test-selected");
  if (testBtn) testBtn.disabled = proxyBatchRunning || count === 0;
  const delBtn = $("#proxy-delete-selected");
  if (delBtn) delBtn.disabled = proxyBatchRunning || count === 0;
  const enableBtn = $("#proxy-enable-selected");
  if (enableBtn) enableBtn.disabled = proxyBatchRunning || count === 0;
  const disableBtn = $("#proxy-disable-selected");
  if (disableBtn) disableBtn.disabled = proxyBatchRunning || count === 0;
}
async function setProxiesEnabled(ids, enabled, silent = false) {
  if (!ids.length) {
    if (!silent) toast("请先勾选代理", true);
    return 0;
  }
  if (proxyBatchRunning) return 0;
  proxyBatchRunning = true;
  updateProxyBulkCount();
  try {
    const data = await api("/api/proxies/enabled", {
      method: "POST",
      body: JSON.stringify({ ids, enabled }),
    });
    proxyData = data.proxies || [];
    proxyMeta = data;
    renderProxies(data);
    const skipped = (data.skipped || []).length ? `，跳过 ${data.skipped.length} 个非配置来源` : "";
    if (!silent) toast(`已${enabled ? "启用" : "停用"} ${(data.changed || []).length} 个代理${skipped}`);
    // Refresh the overview counters in the background without blocking the
    // buttons: awaiting it here kept proxyBatchRunning true if /api/monitor
    // was slow, which froze every row button until a page refresh.
    refreshMonitor().catch(() => {});
    return (data.changed || []).length;
  } catch (error) {
    if (!silent) toast(error.message, true);
    return 0;
  } finally {
    proxyBatchRunning = false;
    // Rows were rendered while the flag was still true, so every row button
    // came out disabled; re-render now that the flag is cleared. Without this
    // the table stayed frozen until a full page refresh.
    renderProxies(proxyMeta);
  }
}
async function testProxy(id, quiet = false) {
  proxyTestRunning[id] = true;
  renderProxies(proxyMeta);
  try {
    const result = await api(`/api/proxies/${id}/test`, { method: "POST", body: "{}" });
    proxyTestResults[id] = {
      ...(proxyTestResults[id] || {}),
      last: {
        ok: !!result.ok,
        status: result.status,
        latency_ms: result.latency_ms,
        error: result.error,
      },
    };
    if (!quiet) {
      toast(
        result.ok
          ? `代理连通正常 · HTTP ${result.status} · ${result.latency_ms}ms`
          : `代理测试失败：${result.error || "未知错误"}`,
        !result.ok,
      );
    }
    return !!result.ok;
  } catch (error) {
    proxyTestResults[id] = { ...(proxyTestResults[id] || {}), last: { ok: false, error: error.message } };
    if (!quiet) toast(error.message, true);
    return false;
  } finally {
    delete proxyTestRunning[id];
    renderProxies(proxyMeta);
  }
}
async function testSelectedProxies() {
  const ids = proxySelectedIds();
  if (!ids.length) {
    toast("请先勾选要测试的代理", true);
    return;
  }
  if (proxyBatchRunning) return;
  proxyBatchRunning = true;
  updateProxyBulkCount();
  const progress = $("#proxy-test-progress");
  let okCount = 0,
    limited = false;
  for (let i = 0; i < ids.length; i++) {
    if (progress) progress.textContent = `测试中 ${i + 1}/${ids.length}…`;
    try {
      const result = await api(`/api/proxies/${ids[i]}/test`, { method: "POST", body: "{}" });
      proxyTestResults[ids[i]] = {
        ...(proxyTestResults[ids[i]] || {}),
        last: {
          ok: !!result.ok,
          status: result.status,
          latency_ms: result.latency_ms,
          error: result.error,
        },
      };
      if (result.ok) okCount++;
    } catch (error) {
      proxyTestResults[ids[i]] = {
        ...(proxyTestResults[ids[i]] || {}),
        last: { ok: false, error: error.message },
      };
      if (/429|too many|限流|rate_limited/i.test(error.message)) {
        limited = true;
        break;
      }
    } finally {
      renderProxies(proxyMeta);
    }
  }
  proxyBatchRunning = false;
  if (progress) progress.textContent = "";
  // Re-render after clearing the flag: rows drawn inside the loop had their
  // buttons disabled while the batch was running.
  renderProxies(proxyMeta);
  if (limited) {
    toast(`触发测试限流（每分钟 12 次），已测 ${okCount} 个连通，稍后可继续测剩余代理`, true);
  } else {
    toast(`选中代理测试完成：${okCount}/${ids.length} 个连通`, okCount !== ids.length);
  }
}
$("#proxy-test-selected").onclick = testSelectedProxies;
$("#proxy-enable-selected").onclick = () => setProxiesEnabled(proxySelectedIds(), true);
$("#proxy-disable-selected").onclick = () => setProxiesEnabled(proxySelectedIds(), false);
async function deleteSelectedProxies() {
  const ids = proxySelectedIds();
  if (!ids.length) {
    toast("请先勾选要删除的代理", true);
    return;
  }
  if (proxyBatchRunning) return;
  const managed = proxyData.filter((proxy) => ids.includes(proxy.id) && proxy.managed);
  const unmanaged = ids.length - managed.length;
  const preview = managed
    .slice(0, 5)
    .map((proxy) => proxy.address)
    .join("\n");
  const extra = managed.length > 5 ? `\n…等共 ${managed.length} 个` : "";
  const note = unmanaged ? `\n（另有 ${unmanaged} 个非配置来源代理不可删除，将自动跳过）` : "";
  if (!managed.length) {
    toast("选中的代理都不是配置来源，不可删除", true);
    return;
  }
  if (!confirm(`删除选中的 ${managed.length} 个代理？\n${preview}${extra}${note}\nKey 绑定会自动热迁移到其它健康节点。`))
    return;
  proxyBatchRunning = true;
  updateProxyBulkCount();
  try {
    const data = await api("/api/proxies/delete", { method: "POST", body: JSON.stringify({ ids }) });
    proxyData = data.proxies || [];
    proxyMeta = data;
    managed.forEach((proxy) => {
      delete proxyTestResults[proxy.id];
    });
    const skipped = (data.skipped || []).length ? `，跳过 ${data.skipped.length} 个非配置来源` : "";
    toast(`已删除 ${(data.removed || []).length} 个代理${skipped}，路由已热迁移`);
    refreshMonitor().catch(() => {});
  } catch (error) {
    toast(error.message, true);
  } finally {
    proxyBatchRunning = false;
    // Same as setProxiesEnabled: re-render so row buttons re-enable.
    renderProxies(proxyMeta);
  }
}
$("#proxy-delete-selected").onclick = deleteSelectedProxies;
$("#proxy-select-all-btn").onclick = () => setAllProxySelected(true);
$("#proxy-deselect-btn").onclick = () => setAllProxySelected(false);
$("#proxy-select-all").onchange = (event) => setAllProxySelected(event.target.checked);
async function deleteProxy(proxy) {
  if (!confirm(`删除代理 ${proxy.address}？Key 绑定会自动热迁移到其它健康节点。`)) return;
  try {
    const data = await api(`/api/proxies/${proxy.id}`, { method: "DELETE" });
    proxyData = data.proxies || [];
    proxyMeta = data;
    delete proxyTestResults[proxy.id];
    renderProxies(data);
    await refreshMonitor();
    toast("代理已删除，路由已热迁移");
  } catch (error) {
    toast(error.message, true);
  }
}
$("#proxy-add").onclick = async () => {
  const value = $("#proxy-new-value").value.trim();
  if (!value) {
    toast("请填写代理地址", true);
    return;
  }
  try {
    const data = await api("/api/proxies", { method: "POST", body: JSON.stringify({ value }) });
    proxyData = data.proxies || [];
    proxyMeta = data;
    $("#proxy-new-value").value = "";
    renderProxies(data);
    await refreshMonitor();
    toast("代理已添加并生效");
  } catch (error) {
    toast(error.message, true);
  }
};
$("#proxy-bulk-run").onclick = async () => {
  const text = $("#proxy-bulk-text").value;
  if (!text.trim()) {
    toast("请先粘贴代理列表", true);
    return;
  }
  $("#proxy-bulk-status").textContent = "导入中…";
  try {
    const data = await api("/api/proxies/bulk", { method: "POST", body: JSON.stringify({ text }) });
    proxyData = data.proxies || [];
    proxyMeta = data;
    $("#proxy-bulk-text").value = "";
    const skipped = (data.skipped || []).length
      ? `，跳过已存在 ${data.skipped.length} 个`
      : "";
    $("#proxy-bulk-status").textContent = `成功导入 ${data.added} 个${skipped}。`;
    renderProxies(data);
    await refreshMonitor();
    toast(`批量导入完成：新增 ${data.added} 个${skipped}`);
  } catch (error) {
    $("#proxy-bulk-status").textContent = error.message;
    toast(error.message, true);
  }
};
$("#proxy-refresh").onclick = () => loadProxies();

/* ===== 上游 Key 管理（独立页）：Zen / Go Key 列表、备注、增删、匿名开关 ===== */
let upstreamKeyData = [],
  upstreamProxyOptions = [],
  upstreamKeySelected = {},
  upstreamKeyBusy = false;
async function loadUpstreamKeys(silent = false) {
  try {
    const data = await api("/api/upstream-keys");
    upstreamKeyData = data.keys || [];
    upstreamProxyOptions = data.proxies || [];
    // 已删除的 Key 不能残留在勾选集里，否则批量操作会带上不存在的 id。
    const alive = {};
    upstreamKeyData.forEach((key) => (alive[key.id] = true));
    Object.keys(upstreamKeySelected).forEach((id) => {
      if (!alive[id]) delete upstreamKeySelected[id];
    });
    renderUpstreamKeys(data);
    if (!silent) $("#upk-error").textContent = "";
  } catch (error) {
    if (!silent) {
      $("#upk-error").textContent = error.message;
      toast(error.message, true);
    }
  }
}
function upstreamSelectedIds() {
  return upstreamKeyData.filter((key) => upstreamKeySelected[key.id]).map((key) => key.id);
}
function setAllUpstreamKeysSelected(selected) {
  upstreamKeySelected = {};
  if (selected) upstreamKeyData.forEach((key) => (upstreamKeySelected[key.id] = true));
  renderUpstreamKeys({ anonymous: $("#upk-anonymous")?.checked });
}
function updateUpstreamKeyBulkCount() {
  const count = upstreamSelectedIds().length;
  const bar = $("#upk-bulk-bar");
  if (bar) bar.textContent = count ? `已选 ${count} / 共 ${upstreamKeyData.length} 个` : "";
  const all = $("#upk-select-all");
  if (all) {
    all.checked = upstreamKeyData.length > 0 && count === upstreamKeyData.length;
    all.indeterminate = count > 0 && count < upstreamKeyData.length;
  }
  ["#upk-enable-selected", "#upk-disable-selected"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = upstreamKeyBusy || count === 0;
  });
}
async function setUpstreamKeysEnabled(ids, enabled, quiet = false) {
  if (!ids.length) {
    if (!quiet) toast("请先勾选上游 Key", true);
    return 0;
  }
  if (upstreamKeyBusy) return 0;
  upstreamKeyBusy = true;
  updateUpstreamKeyBulkCount();
  try {
    const data = await api("/api/upstream-keys/enabled", {
      method: "POST",
      body: JSON.stringify({ ids, enabled }),
    });
    upstreamKeyData = data.keys || [];
    if (data.proxies) upstreamProxyOptions = data.proxies;
    const skipped = (data.skipped || []).length ? `，跳过 ${data.skipped.length} 个未知 Key` : "";
    if (!quiet) toast(`已${enabled ? "启用" : "停用"} ${(data.changed || []).length} 个上游 Key${skipped}`);
    // 停用会重建上游池，模型可用性随之变化；刷新但不阻塞按钮恢复。
    loadDebugModels().catch(() => {});
    refreshMonitor().catch(() => {});
    return (data.changed || []).length;
  } catch (error) {
    // 关闭匿名且这是最后一个启用的 Key 时，配置校验会拒绝保存。
    if (!quiet) toast(error.message, true);
    return 0;
  } finally {
    upstreamKeyBusy = false;
    // 行内按钮是在 busy 期间渲染的，必须重绘才能恢复可点。
    renderUpstreamKeys({ anonymous: $("#upk-anonymous")?.checked });
  }
}
$("#upk-select-all-btn").onclick = () => setAllUpstreamKeysSelected(true);
$("#upk-deselect-btn").onclick = () => setAllUpstreamKeysSelected(false);
$("#upk-select-all").onchange = (event) => setAllUpstreamKeysSelected(event.target.checked);
$("#upk-enable-selected").onclick = () => setUpstreamKeysEnabled(upstreamSelectedIds(), true);
$("#upk-disable-selected").onclick = () => setUpstreamKeysEnabled(upstreamSelectedIds(), false);
/* 收集 <select> 的候选值；浏览器里 options 总是存在，回退分支让无头测试
   也能跑（假 DOM 只有 children/optgroup 树）。 */
function selectOptionValues(select) {
  if (!select) return [];
  if (select.options) return [...select.options].map((option) => option.value);
  const out = [];
  const walk = (nodes) => {
    (nodes || []).forEach((node) => {
      if (node.value !== undefined) out.push(node.value);
      if (node.children) walk(node.children);
    });
  };
  walk(select.children);
  return out;
}

function renderUpstreamKeys(data = {}) {
  const anon = $("#upk-anonymous");
  if (anon) {
    const checked = !!data.anonymous;
    // 用户正在切换时不覆盖控件状态，避免闪烁。
    if (!anon.dataset.busy) anon.checked = checked;
  }
  // 添加表单里的绑定下拉也同步最新代理池（保留当前选择）。
  const newProxy = $("#upk-new-proxy");
  if (newProxy) {
    const selected = newProxy.value;
    newProxy.replaceChildren();
    const addOption = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      newProxy.appendChild(option);
    };
    addOption("auto", "自动绑定");
    addOption("rotate", "轮询");
    const group = document.createElement("optgroup");
    group.label = "指定代理";
    upstreamProxyOptions.forEach((proxy) => {
      const option = document.createElement("option");
      option.value = `bind:${proxy.id}`;
      option.textContent = proxy.address;
      group.appendChild(option);
    });
    newProxy.appendChild(group);
    if (selectOptionValues(newProxy).includes(selected)) newProxy.value = selected;
  }
  const rows = $("#upk-rows");
  rows.replaceChildren();
  upstreamKeyData.forEach((key) => {
    const row = document.createElement("tr");
    if (key.enabled === false) row.className = "row-disabled";
    const checkCell = document.createElement("td");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "proxy-check";
    check.dataset.kid = key.id;
    check.checked = !!upstreamKeySelected[key.id];
    check.onchange = () => {
      if (check.checked) upstreamKeySelected[key.id] = true;
      else delete upstreamKeySelected[key.id];
      updateUpstreamKeyBulkCount();
    };
    checkCell.appendChild(check);
    row.appendChild(checkCell);
    const tierCell = document.createElement("td");
    const tierBadge = document.createElement("span");
    tierBadge.className = `pill ${key.tier === "go" ? "ok" : ""}`;
    tierBadge.textContent = key.tier.toUpperCase();
    tierCell.appendChild(tierBadge);
    row.appendChild(tierCell);
    appendCell(row, key.display, "mono");
    const noteCell = document.createElement("td");
    if (key.editing) {
      const input = document.createElement("input");
      input.value = key.note || "";
      input.maxLength = 80;
      input.placeholder = "备注";
      const save = document.createElement("button");
      save.className = "ghost";
      save.textContent = "保存";
      save.onclick = async () => {
        try {
          const data2 = await api(`/api/upstream-keys/${key.id}`, {
            method: "PATCH",
            body: JSON.stringify({ note: input.value }),
          });
          upstreamKeyData = data2.keys || [];
          renderUpstreamKeys(data2);
          toast("备注已保存");
        } catch (error) {
          toast(error.message, true);
        }
      };
      const cancel = document.createElement("button");
      cancel.className = "ghost";
      cancel.textContent = "取消";
      cancel.onclick = () => {
        delete key.editing;
        renderUpstreamKeys({ anonymous: data.anonymous });
      };
      const wrap = document.createElement("div");
      wrap.className = "key-actions";
      wrap.append(input, save, cancel);
      noteCell.appendChild(wrap);
    } else {
      noteCell.textContent = key.note || "—";
    }
    row.appendChild(noteCell);
    // 启用状态：停用的 Key 不参与路由，失败/冷却列对它没有意义。
    const stateCell = document.createElement("td");
    if (key.enabled === false) {
      const badge = document.createElement("span");
      badge.className = "status warn";
      badge.textContent = "已停用";
      stateCell.appendChild(badge);
    } else {
      const badge = document.createElement("span");
      badge.className = "status ok";
      badge.textContent = key.in_pool ? "启用中" : "启用（待生效）";
      stateCell.appendChild(badge);
    }
    row.appendChild(stateCell);
    // 绑定代理：模式下拉（自动 / 轮询 / 指定某个代理），改选即热生效。
    const proxyCell = document.createElement("td");
    const modeSelect = document.createElement("select");
    modeSelect.className = "upk-proxy-select";
    modeSelect.title = "自动=按顺序绑定并可故障迁移；轮询=每次请求从池中取一个可用代理；指定=钉死某个代理";
    const addOption = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      modeSelect.appendChild(option);
    };
    addOption("auto", "自动绑定");
    addOption("rotate", "轮询");
    const group = document.createElement("optgroup");
    group.label = "指定代理";
    upstreamProxyOptions.forEach((proxy) => {
      const option = document.createElement("option");
      option.value = `bind:${proxy.id}`;
      option.textContent = proxy.address;
      group.appendChild(option);
    });
    modeSelect.appendChild(group);
    const currentMode = key.proxy_mode || "auto";
    modeSelect.value =
      currentMode === "bind" && key.proxy_id ? `bind:${key.proxy_id}` : currentMode === "rotate" ? "rotate" : "auto";
    if (modeSelect.value === "" && currentMode === "bind") {
      // 钉住的代理已被删除/停用：显示实际回退情况
      addOption("bind:missing", `指定（已失效，实际走 ${key.proxy || "自动"}）`);
      modeSelect.value = "bind:missing";
    }
    modeSelect.onchange = () => setUpstreamKeyProxy(key, modeSelect);
    proxyCell.appendChild(modeSelect);
    if (key.proxy && currentMode !== "rotate") {
      const shown = document.createElement("div");
      shown.className = "upk-proxy-now mono";
      shown.textContent = `当前：${key.proxy}`;
      proxyCell.appendChild(shown);
    } else if (currentMode === "rotate") {
      const shown = document.createElement("div");
      shown.className = "upk-proxy-now";
      shown.textContent = "每次请求取一个可用代理";
      proxyCell.appendChild(shown);
    }
    row.appendChild(proxyCell);
    const cooldown =
      key.enabled === false
        ? "—"
        : key.cooldown_until
          ? `冷却至 ${new Date(key.cooldown_until).toLocaleTimeString()}`
          : key.failures
            ? `失败 ${key.failures} 次`
            : "正常";
    appendCell(
      row,
      cooldown,
      key.enabled === false ? "" : key.cooldown_until ? "warn" : key.failures ? "warn" : "ok",
    );
    appendCell(
      row,
      key.created_at ? new Date(key.created_at).toLocaleString() : "—",
    );
    const actions = document.createElement("td");
    actions.className = "key-actions";
    const editButton = document.createElement("button");
    editButton.className = "ghost";
    editButton.textContent = key.editing ? "编辑中" : "✏️ 备注";
    editButton.disabled = !!key.editing;
    editButton.onclick = () => {
      key.editing = true;
      renderUpstreamKeys({ anonymous: data.anonymous });
    };
    actions.appendChild(editButton);
    const toggleButton = document.createElement("button");
    toggleButton.className = "ghost";
    toggleButton.textContent = key.enabled === false ? "启用" : "停用";
    toggleButton.disabled = !!upstreamKeyBusy;
    toggleButton.onclick = () => setUpstreamKeysEnabled([key.id], key.enabled === false);
    actions.appendChild(toggleButton);
    const delButton = document.createElement("button");
    delButton.className = "ghost";
    delButton.textContent = "删除";
    delButton.onclick = () => deleteUpstreamKey(key);
    actions.appendChild(delButton);
    row.appendChild(actions);
    rows.appendChild(row);
  });
  if (!upstreamKeyData.length)
    emptyRow(
      rows,
      9,
      "暂无上游 Key：匿名通道开启时免费模型仍可用，添加 Key 可获得独立配额兜底。",
    );
  updateUpstreamKeyBulkCount();
}
async function setUpstreamKeyProxy(key, select) {
  const value = select.value;
  if (value === "bind:missing") {
    toast("该 Key 钉住的代理已不存在，请重新选择", true);
    renderUpstreamKeys({ anonymous: $("#upk-anonymous")?.checked });
    return;
  }
  let mode = "auto",
    proxyId = "";
  if (value === "rotate") mode = "rotate";
  else if (value.startsWith("bind:")) {
    mode = "bind";
    proxyId = value.slice(5);
  }
  select.disabled = true;
  try {
    const data = await api(`/api/upstream-keys/${key.id}/proxy`, {
      method: "POST",
      body: JSON.stringify({ mode, proxy_id: proxyId }),
    });
    upstreamKeyData = data.keys || [];
    if (data.proxies) upstreamProxyOptions = data.proxies;
    renderUpstreamKeys(data);
    refreshMonitor().catch(() => {});
    toast(
      mode === "rotate"
        ? "已切换为轮询：每次请求从代理池取一个可用代理"
        : mode === "bind"
          ? "已钉住指定代理"
          : "已恢复自动绑定",
    );
  } catch (error) {
    toast(error.message, true);
    select.disabled = false;
    loadUpstreamKeys(true);
  }
}
async function deleteUpstreamKey(key) {
  const label = key.note ? `${key.tier.toUpperCase()} · ${key.display}（${key.note}）` : `${key.tier.toUpperCase()} · ${key.display}`;
  if (!confirm(`删除上游 Key ${label}？\n关闭匿名通道且这是最后一个 Key 时，网关会拒绝保存以保护路由。`)) return;
  try {
    const data = await api(`/api/upstream-keys/${key.id}`, { method: "DELETE" });
    upstreamKeyData = data.keys || [];
    renderUpstreamKeys(data);
    await loadDebugModels();
    refreshMonitor().catch(() => {});
    toast("上游 Key 已删除并热生效");
  } catch (error) {
    toast(error.message, true);
  }
}
$("#upk-add").onclick = async () => {
  const value = $("#upk-new-value").value.trim();
  if (!value) {
    toast("请填写 Key", true);
    return;
  }
  // 解析代理绑定下拉：auto / rotate / bind:<proxyId>
  const proxyChoice = $("#upk-new-proxy")?.value || "auto";
  let mode = "auto",
    proxyId = "";
  if (proxyChoice === "rotate") mode = "rotate";
  else if (proxyChoice.startsWith("bind:")) {
    mode = "bind";
    proxyId = proxyChoice.slice(5);
  }
  try {
    const data = await api("/api/upstream-keys", {
      method: "POST",
      body: JSON.stringify({
        tier: $("#upk-new-tier").value,
        value,
        note: $("#upk-new-note").value.trim(),
        mode,
        proxy_id: proxyId,
      }),
    });
    upstreamKeyData = data.keys || [];
    if (data.proxies) upstreamProxyOptions = data.proxies;
    $("#upk-new-value").value = "";
    $("#upk-new-note").value = "";
    renderUpstreamKeys(data);
    await loadDebugModels();
    refreshMonitor().catch(() => {});
    toast("上游 Key 已添加并热生效");
  } catch (error) {
    toast(error.message, true);
  }
};
$("#upk-anonymous").onchange = async (event) => {
  const checkbox = event.target;
  checkbox.dataset.busy = "1";
  try {
    const data = await api("/api/upstream-keys/anonymous", {
      method: "POST",
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    upstreamKeyData = data.keys || [];
    delete checkbox.dataset.busy;
    renderUpstreamKeys(data);
    await loadDebugModels();
    refreshMonitor().catch(() => {});
    toast(data.anonymous ? "匿名通道已启用" : "匿名通道已关闭");
  } catch (error) {
    delete checkbox.dataset.busy;
    // 回滚控件到服务端真实状态
    loadUpstreamKeys(true);
    toast(error.message, true);
  }
};
$("#upk-refresh").onclick = () => loadUpstreamKeys();

function renderResources(resources) {
  const proxies = $("#proxy-table");
  proxies.replaceChildren();
  (resources.proxies || []).forEach((proxy) => {
    const row = document.createElement("tr");
    appendCell(row, proxy.address);
    appendCell(row, proxy.healthy ? "正常" : "不可用", `status ${proxy.healthy ? "ok" : "bad"}`);
    appendCell(
      row,
      `Z ${proxy.zen_keys} · G ${proxy.go_keys} · A ${proxy.anonymous ? "开" : "关"}`,
    );
    proxies.appendChild(row);
  });
  if (!proxies.children.length) emptyRow(proxies, 3);
  const keys = $("#key-table");
  keys.replaceChildren();
  if (resources.anonymous) {
    const row = document.createElement("tr");
    appendCell(row, "anonymous");
    appendCell(row, "zen");
    appendCell(row, "已启用", "status ok");
    keys.appendChild(row);
  }
  (resources.keys || []).forEach((key) => {
    const row = document.createElement("tr");
    appendCell(row, key.id);
    appendCell(row, key.tier);
    appendCell(
      row,
      key.cooldown_until ? "冷却中" : "可用",
      `status ${key.cooldown_until ? "warn" : "ok"}`,
    );
    keys.appendChild(row);
  });
  if (!keys.children.length) emptyRow(keys, 3);
}
function renderBreakdowns(metrics) {
  const host = $("#breakdowns");
  host.replaceChildren();
  [
    ["端点", metrics.endpoints],
    ["状态码", metrics.statuses],
    ["模型", metrics.models],
    ["Tier", metrics.tiers],
  ].forEach(([title, data]) => {
    const block = document.createElement("div"),
      heading = document.createElement("h3"),
      table = document.createElement("table"),
      body = document.createElement("tbody");
    heading.textContent = title;
    table.className = "table";
    Object.entries(data || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([key, value]) => {
        const row = document.createElement("tr");
        appendCell(row, key);
        appendCell(row, value);
        body.appendChild(row);
      });
    if (!body.children.length) emptyRow(body, 2, "暂无请求");
    table.appendChild(body);
    block.append(heading, table);
    host.appendChild(block);
  });
}
function renderGuide() {
  if (!config || !monitorData) return;
  const resources = monitorData.resources,
    models = resources.models || {},
    modelDescription = models.stale
      ? "目录来自" + (models.cache_source || "磁盘") + "快取，等待背景刷新。"
      : "上游目录已完成首次刷新且有可暴露模型。";
  const checks = [
    ["登录管理端", "当前 Session 已通过服务端验证。", true],
    ["配置本地 Key", "客户端使用 Server Key 访问 Gateway。", (config.server_keys || []).length > 0],
    [
      "选择上游通道",
      "至少有 Zen / Go Key，或启用匿名通道。",
      (config.zen_keys || []).length + (config.go_keys || []).length > 0 || config.anonymous,
    ],
    [
      "检查 Proxy",
      "至少一个代理节点健康。",
      (resources.proxies || []).some((proxy) => proxy.healthy),
    ],
    ["等待模型目录", modelDescription, models.exposed > 0 && !!models.updated_at],
    ["复制接入示例", "进入接入手册，替换模型与 YOUR_API_KEY。", true],
  ];
  const host = $("#guide-steps");
  host.replaceChildren();
  checks.forEach(([title, description, done]) => {
    const node = document.createElement("article"),
      heading = document.createElement("h3"),
      copy = document.createElement("p"),
      state = document.createElement("div");
    node.className = "guide-step";
    heading.textContent = title;
    copy.textContent = description;
    state.className = `step-state ${done ? "ok" : "warn"}`;
    state.textContent = done ? "✓ 已就绪" : "○ 待处理";
    node.append(heading, copy, state);
    host.appendChild(node);
  });
}
const formatTokens = (value) => Number(value || 0).toLocaleString();
function renderUsage() {
  if (!monitorData) return;
  const usage = monitorData.usage?.last_hour || {},
    tokens = usage.tokens || {};
  $("#u-coverage").textContent = `${((usage.coverage || 0) * 100).toFixed(1)}%`;
  $("#u-total").textContent = formatTokens(tokens.total_tokens);
  $("#u-cached").textContent = formatTokens(tokens.cached_tokens);
  $("#u-reasoning").textContent = formatTokens(tokens.reasoning_tokens);
  const trend = $("#usage-trend"),
    series = monitorData.metrics?.series || [],
    maximum = Math.max(1, ...series.map((point) => point.total_tokens || 0));
  trend.replaceChildren();
  series.forEach((point) => {
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = `${Math.max(2, Math.round(((point.total_tokens || 0) / maximum) * 100))}%`;
    bar.title = `${new Date(point.minute).toLocaleTimeString()} · input ${formatTokens(point.input_tokens)} · output ${formatTokens(point.output_tokens)} · total ${formatTokens(point.total_tokens)}`;
    trend.appendChild(bar);
  });
  const models = $("#usage-models");
  models.replaceChildren();
  Object.entries(usage.models || {})
    .sort((a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0))
    .slice(0, 15)
    .forEach(([model, value]) => {
      const row = document.createElement("tr");
      appendCell(row, model);
      appendCell(row, formatTokens(value.input_tokens));
      appendCell(row, formatTokens(value.output_tokens));
      appendCell(row, formatTokens(value.total_tokens));
      models.appendChild(row);
    });
  if (!models.children.length) emptyRow(models, 4, "尚无 Token 用量");
  const tiers = $("#usage-tiers"),
    tierEntries = Object.entries(usage.tiers || {}).sort(
      (a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0),
    ),
    tierTotal = Math.max(1, ...tierEntries.map(([, value]) => value.total_tokens || 0));
  tiers.replaceChildren();
  tierEntries.forEach(([tier, value]) => {
    const row = document.createElement("div"),
      name = document.createElement("strong"),
      track = document.createElement("div"),
      fill = document.createElement("div"),
      amount = document.createElement("span");
    row.className = "tier-row";
    name.textContent = tier;
    track.className = "tier-track";
    fill.className = "tier-fill";
    fill.style.width = `${Math.round(((value.total_tokens || 0) / tierTotal) * 100)}%`;
    amount.className = "mono";
    amount.textContent = formatTokens(value.total_tokens);
    track.appendChild(fill);
    row.append(name, track, amount);
    tiers.appendChild(row);
  });
  if (!tierEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "尚无 Tier 用量";
    tiers.appendChild(empty);
  }
}
function renderFacts(selector, entries) {
  const host = $(selector);
  host.replaceChildren();
  entries.forEach(([label, value, tone]) => {
    const fact = document.createElement("dl"),
      term = document.createElement("dt"),
      detail = document.createElement("dd");
    fact.className = "fact";
    term.textContent = label;
    detail.textContent = value ?? "—";
    if (tone) detail.className = tone;
    fact.append(term, detail);
    host.appendChild(fact);
  });
}
function renderPlayKeys() {
  const select = $("#play-key");
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "自动路由（匿名 / Tier 回退 / Key 轮询）";
  select.appendChild(auto);
  const keys = debugData?.keys || {};
  [
    ["zen", "Zen Keys"],
    ["go", "Go Keys"],
  ].forEach(([tier, label]) => {
    const items = keys[tier] || [];
    if (!items.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = `${tier}:${item.id}`;
      const cooling = item.cooldown_until
        ? ` · 冷却至 ${new Date(item.cooldown_until).toLocaleTimeString()}`
        : "";
      const note = item.note ? `「${item.note}」` : "";
      option.textContent = `${tier.toUpperCase()} · ${item.display}${note} · ${item.id}${cooling}`;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
  if (selected && [...select.options].some((option) => option.value === selected))
    select.value = selected;
  else select.value = "auto";
}
async function loadDebugModels() {
  try {
    debugData = await api("/api/debug/models");
    if (debugData.last_inference) lastPlayground = debugData.last_inference;
    const select = $("#play-model"),
      selected = select.value;
    select.replaceChildren();
    (debugData.models || []).forEach((item) => {
      const option = document.createElement("option");
      option.value = item.model;
      option.textContent = item.model;
      select.appendChild(option);
    });
    if (selected && [...select.options].some((option) => option.value === selected))
      select.value = selected;
    renderPlayKeys();
    syncConnModels();
    if (!$("#play-request").value.trim()) resetPlayTemplate();
    renderDiagnostics();
  } catch (error) {
    toast(error.message, true);
  }
}
/* ===== API 连通性测试（一键真实路由：自动路由 + chat 协议 + 非流式） ===== */
function syncConnModels() {
  const select = $("#conn-model");
  if (!select || !debugData) return;
  const selected = select.value;
  select.replaceChildren();
  (debugData.models || []).forEach((item) => {
    const option = document.createElement("option");
    option.value = item.model;
    option.textContent = item.model;
    select.appendChild(option);
  });
  if (selected && [...select.options].some((option) => option.value === selected))
    select.value = selected;
}
function extractConnText(response) {
  if (!response || typeof response !== "object") return "";
  const choices = response.choices;
  if (Array.isArray(choices) && choices[0]?.message?.content) {
    const content = choices[0].message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join("");
  }
  if (typeof response.output_text === "string") return response.output_text;
  if (Array.isArray(response.output)) {
    const texts = [];
    for (const item of response.output)
      for (const part of item?.content || [])
        if (typeof part?.text === "string") texts.push(part.text);
    if (texts.length) return texts.join("");
  }
  if (Array.isArray(response.content))
    return response.content.map((part) => part?.text || "").join("");
  return "";
}
$("#conn-run").onclick = async () => {
  const model = $("#conn-model").value;
  const message = $("#conn-msg").value.trim();
  if (!model) {
    toast("暂无可用模型", true);
    return;
  }
  if (!message) {
    toast("请填写测试消息", true);
    return;
  }
  const button = $("#conn-run"),
    out = $("#conn-result");
  const started = Date.now();
  button.disabled = true;
  button.innerHTML = '<span class="loading"></span>测试中…';
  out.innerHTML = "";
  const hint = document.createElement("div");
  hint.className = "conn-hint";
  hint.innerHTML = '⏳ 发送中… <span id="conn-timer">0</span>s';
  out.appendChild(hint);
  const timer = setInterval(() => {
    const el = $("#conn-timer");
    if (el) el.textContent = Math.floor((Date.now() - started) / 1000);
  }, 500);
  const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  try {
    const result = await api("/api/debug/inference", {
      method: "POST",
      body: JSON.stringify({
        protocol: "chat",
        key: { mode: "auto" },
        request: { model, messages: [{ role: "user", content: message }] },
      }),
    });
    clearInterval(timer);
    const route = result.route || {};
    const routeLabel = route.tier
      ? `${route.tier} / ${route.anonymous ? "anonymous" : route.key_id || "key"}`
      : "未路由";
    const text = extractConnText(result.response);
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text || "(空响应)";
    const box = document.createElement("div");
    box.className = `conn-box ${result.ok ? "conn-ok" : "conn-fail"}`;
    const latency = fmtMs(Math.max(result.duration_ms ?? Date.now() - started, 0));
    const head = document.createElement("div");
    head.innerHTML = result.ok ? "✅ <b>链路正常</b>" : "❌ <b>链路异常</b>";
    const cost = document.createElement("b");
    cost.style.color = result.ok ? "var(--accent2)" : "var(--danger)";
    cost.textContent = ` · 耗时 ${latency}`;
    head.append(" ", cost);
    if (!result.ok) {
      const status = document.createElement("span");
      status.textContent = ` · HTTP ${result.http_status}`;
      head.appendChild(status);
    }
    const meta = document.createElement("div");
    meta.className = "conn-meta";
    const line1 = document.createElement("div");
    line1.textContent = `🛣️ 路由: ${routeLabel} · 模型: ${model}`;
    const reply = document.createElement("div");
    reply.className = "conn-reply";
    reply.textContent = `📝 回复: ${preview}`;
    meta.append(line1, reply);
    box.append(head, meta);
    out.replaceChildren(box);
    toast(result.ok ? "API 链路正常" : `测试失败：HTTP ${result.http_status}`, !result.ok);
  } catch (error) {
    clearInterval(timer);
    out.innerHTML = "";
    const box = document.createElement("div");
    box.className = "conn-box conn-fail";
    box.textContent = `❌ 测试失败：${error.message}`;
    out.appendChild(box);
    toast(`测试失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "🚀 发送测试请求";
  }
};

function playgroundTemplate() {  const protocol = $("#play-protocol").value,
    model = $("#play-model").value || "YOUR_MODEL";
  if (protocol === "responses") return { model, input: "用一句话说明这个模型的能力。" };
  if (protocol === "anthropic")
    return {
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: "用一句话说明这个模型的能力。" }],
    };
  return { model, messages: [{ role: "user", content: "用一句话说明这个模型的能力。" }] };
}
function resetPlayTemplate() {
  $("#play-request").value = JSON.stringify(playgroundTemplate(), null, 2);
}
$("#play-protocol").addEventListener("change", resetPlayTemplate);
$("#play-model").addEventListener("change", () => {
  try {
    const request = JSON.parse($("#play-request").value);
    request.model = $("#play-model").value;
    $("#play-request").value = JSON.stringify(request, null, 2);
  } catch (_) {
    resetPlayTemplate();
  }
});
$("#play-reset").onclick = resetPlayTemplate;
function displayPlayground(result) {
  lastPlayground = result;
  const keyTest = result.key_test
    ? {
        usable: "Key 可用",
        rejected: "Key 被拒绝",
        rate_limited: "Key 已被接受但受到限流",
        upstream_error: "上游异常，无法判定 Key",
        transport_error: "网络或代理异常，无法判定 Key",
        unavailable: "Key 或运行时不可用",
        request_error: "请求未成功",
      }[result.key_test] || result.key_test
    : "";
  $("#play-state").textContent = result.ok
    ? `请求成功 · HTTP ${result.http_status}`
    : `请求失败 · HTTP ${result.http_status}`;
  $("#play-state").className = `section-caption ${result.ok ? "ok" : "bad"}`;
  const route = result.route || {},
    eligibility = route.anonymous_eligibility || {},
    selected = result.selected_key,
    routeLabel = route.tier
      ? `${route.tier} / ${route.anonymous ? "anonymous" : route.key_id || "key"}`
      : "未路由";
  renderFacts("#play-facts", [
    ["HTTP 状态", result.http_status, result.ok ? "ok" : "bad"],
    ["耗时", `${result.duration_ms} ms`],
    ["Request ID", result.request_id || "—"],
    ["测试模式", selected ? `指定 ${selected.tier.toUpperCase()} Key` : "自动路由"],
    ["测试 Key", selected ? `${selected.display} · ${selected.id}` : "—"],
    [
      "Key 判断",
      keyTest || "自动路由未单独判定",
      result.key_test === "usable" ? "ok" : result.key_test ? "bad" : "",
    ],
    ["实际路由", routeLabel],
    ["原生协议", route.native_protocol || "—"],
    [
      "匿名判断",
      `${eligibility.allowed ? "允许" : "拒绝"} · ${eligibility.source || "—"}`,
      eligibility.allowed ? "ok" : "warn",
    ],
  ]);
  $("#play-output").textContent = JSON.stringify(result.response, null, 2);
  renderDiagnostics();
}
$("#play-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let request;
  try {
    request = JSON.parse($("#play-request").value);
  } catch (error) {
    toast(`请求 JSON 无效：${error.message}`, true);
    return;
  }
  const keyValue = $("#play-key").value,
    key =
      keyValue === "auto"
        ? { mode: "auto" }
        : {
            mode: "selected",
            tier: keyValue.split(":")[0],
            id: keyValue.split(":").slice(1).join(":"),
          };
  $("#play-run").disabled = true;
  $("#play-state").textContent =
    key.mode === "selected" ? "指定 Key 测试进行中…" : "Gateway 请求进行中…";
  try {
    const result = await api("/api/debug/inference", {
      method: "POST",
      body: JSON.stringify({ protocol: $("#play-protocol").value, key, request }),
    });
    displayPlayground(result);
  } catch (error) {
    toast(error.message, true);
    $("#play-state").textContent = "诊断入口请求失败";
  } finally {
    $("#play-run").disabled = false;
  }
});
$("#play-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#play-output").textContent);
    toast("原始响应已复制");
  } catch (_) {
    toast("浏览器不允许剪贴板访问", true);
  }
};
function renderDiagnostics() {
  if (!monitorData && !debugData) return;
  const metadata = debugData?.metadata || monitorData?.resources?.metadata || {},
    last = lastPlayground || debugData?.last_inference;
  renderFacts("#metadata-facts", [
    ["就绪", metadata.ready ? "是" : "否", metadata.ready ? "ok" : "warn"],
    ["模型数", formatTokens(metadata.models)],
    ["更新时间", metadata.updated_at ? new Date(metadata.updated_at).toLocaleString() : "尚未更新"],
    ["是否过期", metadata.stale ? "是" : "否", metadata.stale ? "warn" : "ok"],
    ["下次刷新", metadata.next_refresh ? new Date(metadata.next_refresh).toLocaleString() : "—"],
    ["最近错误", metadata.last_error || "无", metadata.last_error ? "bad" : "ok"],
  ]);
  renderFacts(
    "#last-playground",
    last
      ? [
          ["结果", last.ok ? "成功" : "失败", last.ok ? "ok" : "bad"],
          ["HTTP", last.http_status],
          ["耗时", `${last.duration_ms} ms`],
          ["Request ID", last.request_id || "—"],
          ["模型", last.route?.model || "—"],
          [
            "路由",
            last.route?.tier
              ? `${last.route.tier} / ${last.route.anonymous ? "anonymous" : last.route.key_id || "key"}`
              : "未路由",
          ],
        ]
      : [["状态", "尚无 Playground 追踪"]],
  );
  renderDiagnosticModels();
  const requests = $("#upstream-requests");
  requests.replaceChildren();
  (monitorData?.upstream?.requests || [])
    .slice(-100)
    .reverse()
    .forEach((request) => {
      const row = document.createElement("tr");
      appendCell(row, new Date(request.time).toLocaleTimeString());
      appendCell(row, request.request_id);
      appendCell(row, request.model);
      appendCell(row, request.tier || "—");
      appendCell(row, request.channel);
      appendCell(row, request.key_id || "—");
      appendCell(row, request.attempts);
      const terminalResults = {
        stream_error: "流式响应失败",
        client_canceled: "客户端已取消",
      };
      const result = terminalResults[request.outcome]
        ? `HTTP ${request.status} · ${terminalResults[request.outcome]}`
        : request.status || request.outcome;
      appendCell(row, result, request.success ? "ok" : "bad");
      appendCell(row, `${request.duration_ms} ms`);
      requests.appendChild(row);
    });
  if (!requests.children.length) emptyRow(requests, 9, "尚无请求路由");
  const attempts = $("#upstream-attempts");
  attempts.replaceChildren();
  (monitorData?.upstream?.recent || [])
    .slice(-100)
    .reverse()
    .forEach((attempt) => {
      const row = document.createElement("tr");
      appendCell(row, new Date(attempt.time).toLocaleTimeString());
      appendCell(row, attempt.request_id);
      appendCell(row, attempt.model);
      appendCell(row, `${attempt.tier} / ${attempt.channel}`);
      appendCell(row, attempt.key_id);
      appendCell(row, attempt.proxy_node);
      appendCell(row, attempt.status || attempt.outcome, attempt.success ? "ok" : "bad");
      appendCell(row, `${attempt.duration_ms} ms`);
      attempts.appendChild(row);
    });
  if (!attempts.children.length) emptyRow(attempts, 8, "尚无上游尝试");
}
function renderDiagnosticModels() {
  const host = $("#diagnostic-models");
  if (!host || !debugData) return;
  const query = $("#diagnostic-model-search").value.trim().toLowerCase();
  host.replaceChildren();
  (debugData.models || [])
    .filter((item) => !query || item.model.toLowerCase().includes(query))
    .forEach((item) => {
      const eligibility = item.anonymous_eligibility || {},
        row = document.createElement("tr"),
        input = eligibility.input_cost,
        output = eligibility.output_cost,
        plan = [...(item.anonymous ? ["anonymous"] : []), ...(item.key_tiers || [])];
      appendCell(row, item.model);
      appendCell(row, `${item.native_protocol} · ${item.protocol_source}`);
      appendCell(
        row,
        item.route_error || (plan.length ? plan.join(" → ") : "—"),
        item.route_error ? "bad" : "",
      );
      appendCell(row, eligibility.allowed ? "允许" : "拒绝", eligibility.allowed ? "ok" : "warn");
      appendCell(row, eligibility.source || "—");
      appendCell(row, `${input == null ? "?" : input} / ${output == null ? "?" : output}`, "cost");
      host.appendChild(row);
    });
  if (!host.children.length) emptyRow(host, 6, "没有匹配模型");
}
$("#diagnostic-model-search").addEventListener("input", renderDiagnosticModels);
async function refreshMonitor() {
  try {
    monitorData = await api("/api/monitor");
    const metrics = monitorData.metrics;
    $("#version").textContent = `version ${monitorData.version}`;
    $("#m-total").textContent = Number(metrics.last_hour.total || 0).toLocaleString();
    $("#m-rate").textContent = `${((metrics.last_hour.success_rate || 0) * 100).toFixed(1)}%`;
    $("#m-p95").textContent = `${metrics.last_hour.p95_ms || 0} ms`;
    $("#m-active").textContent = `${metrics.active_requests || 0} / ${metrics.active_streams || 0}`;
    renderResources(monitorData.resources);
    renderSessionStats(monitorData.sessions);
    renderBreakdowns(metrics);
    renderGuide();
    renderUsage();
    renderDiagnostics();
  } catch (_) {}
}
$("#refresh-now").onclick = async () => {
  await Promise.all([refreshMonitor(), loadConfig(), loadDebugModels()]);
  if (location.hash === "#model-quotas") await loadModelQuotas();
  if (location.hash === "#api-keys") await loadAPIKeys();
  if (location.hash === "#proxies") await loadProxies();
  if (location.hash === "#upstream-keys") await loadUpstreamKeys(true);
  toast("状态已刷新");
};
function renderSessionStats(sessions) {
  const host = $("#session-stats");
  if (!host) return;
  if (!sessions) {
    host.textContent = "—";
    return;
  }
  host.textContent =
    `活跃映射 ${sessions.active} 个 · TTL ${sessions.ttl_seconds}s · ` +
    `铸造 ${sessions.minted} · 命中 ${sessions.hits} · 过期 ${sessions.expired}` +
    (sessions.evictions ? ` · 容量淘汰 ${sessions.evictions}` : "");
}
function derivedAPIBase() {
  if (!config) return `${location.protocol}//${location.hostname}:8080`;
  const listen = config.effective?.listen || config.listen || ":8080";
  const bracket = listen.match(/^\[.*\]:(\d+)$/),
    plain = listen.match(/:(\d+)$/),
    port = (bracket || plain)?.[1] || "8080";
  return `${location.protocol}//${location.hostname}:${port}`;
}
function codeCard(label, text) {
  const card = document.createElement("div"),
    head = document.createElement("div"),
    title = document.createElement("span"),
    copy = document.createElement("button"),
    pre = document.createElement("pre"),
    code = document.createElement("code");
  card.className = "code-card";
  head.className = "code-head";
  title.textContent = label;
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "复制";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("示例已复制");
    } catch (_) {
      toast("浏览器不允许剪贴板访问", true);
    }
  };
  head.append(title, copy);
  code.textContent = text;
  pre.appendChild(code);
  card.append(head, pre);
  return card;
}
function renderAccessExamples() {
  if (!config) return;
  const base = derivedAPIBase(),
    model = $("#access-model")?.value.trim() || "YOUR_MODEL";
  $("#access-base-value").value = base;
  const protocols = $("#access-protocol-examples"),
    sdks = $("#access-sdk-examples");
  protocols.replaceChildren();
  sdks.replaceChildren();
  const chat = `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
  const responses = `curl ${base}/v1/responses \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","input":"Hello"}'`;
  const anthropic = `curl ${base}/v1/messages \\\n  -H "x-api-key: YOUR_API_KEY" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'`;
  protocols.append(
    codeCard("Chat Completions", chat),
    codeCard("Responses", responses),
    codeCard("Anthropic Messages", anthropic),
  );
  const python = `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="YOUR_API_KEY")\nresponse = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`;
  const javascript = `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${base}/v1",\n  apiKey: "YOUR_API_KEY",\n});\nconst response = await client.responses.create({\n  model: "${model}",\n  input: "Hello",\n});\nconsole.log(response.output_text);`;
  sdks.append(
    codeCard("Python · OpenAI SDK", python),
    codeCard("JavaScript · OpenAI SDK", javascript),
  );
}
$("#access-model").addEventListener("input", renderAccessExamples);
$$("[data-scroll]").forEach(
  (button) =>
    (button.onclick = () =>
      document.getElementById(button.dataset.scroll).scrollIntoView({ behavior: "smooth" })),
);
function connectLogs() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/logs/stream");
  eventSource.addEventListener("log", (event) => {
    const item = JSON.parse(event.data);
    logEvents.push(item);
    if (logEvents.length > 2000) logEvents.shift();
    if (!paused && !logRenderPending) {
      logRenderPending = true;
      requestAnimationFrame(() => {
        logRenderPending = false;
        renderLogs();
      });
    }
  });
  eventSource.addEventListener("gap", () => toast("较早日志已从内存清除", true));
}
function renderLogs() {
  const level = $("#log-level").value,
    component = $("#log-component").value.toLowerCase(),
    query = $("#log-search").value.toLowerCase(),
    rows = logEvents
      .filter(
        (item) =>
          (!level || item.level === level) &&
          (!component || (item.component || "").toLowerCase().includes(component)) &&
          (!query || JSON.stringify(item).toLowerCase().includes(query)),
      )
      .slice(-500),
    host = $("#log-list");
  host.replaceChildren();
  rows.forEach((item) => {
    const row = document.createElement("div");
    row.className = "log";
    const timeNode = document.createElement("span"),
      levelNode = document.createElement("span"),
      componentNode = document.createElement("span"),
      messageNode = document.createElement("span"),
      fieldsNode = document.createElement("span");
    timeNode.className = "log-time";
    timeNode.textContent = new Date(item.time).toLocaleTimeString();
    levelNode.className =
      item.level === "error"
        ? "bad"
        : item.level === "warn"
          ? "warn"
          : item.level === "info"
            ? "ok"
            : "";
    levelNode.textContent = item.level;
    componentNode.className = "log-component";
    componentNode.textContent = item.component || "core";
    messageNode.textContent = item.message;
    fieldsNode.className = "log-fields";
    fieldsNode.textContent = JSON.stringify(item.fields || {});
    row.append(timeNode, levelNode, componentNode, messageNode, fieldsNode);
    host.appendChild(row);
  });
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "等待日志事件…";
    host.appendChild(empty);
  }
  host.scrollTop = host.scrollHeight;
}
["#log-level", "#log-component", "#log-search"].forEach((id) =>
  $(id).addEventListener("input", renderLogs),
);
$("#log-pause").onclick = () => {
  paused = !paused;
  $("#log-pause").textContent = paused ? "继续" : "暂停";
  if (!paused) renderLogs();
};
let quotaData = null,
  quotaTimer = null,
  quotaLoading = false,
  createdKey = "",
  apiKeysLoading = false;
const localTime = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

function clearCreatedKey() {
  createdKey = "";
  $("#api-key-env").textContent = "";
  $("#api-key-created").classList.add("hidden");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    toast("浏览器未允许复制，请手动选中复制", true);
  }
}

async function loadModelQuotas() {
  if (quotaLoading) return;
  quotaLoading = true;
  $("#quota-refresh").disabled = true;
  $("#quota-refresh").textContent = "读取中…";
  try {
    const value = await api("/api/model-quotas");
    if (!csrf) return;
    quotaData = value;
    const select = $("#quota-account"),
      selected = select.value;
    select.replaceChildren();
    for (const account of value.accounts || []) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `Go Key ${account.display}`;
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    if (!select.options.length) select.appendChild(new Option("尚未配置 Go Key", ""));
    renderModelQuotas();
  } catch (error) {
    $("#quota-status").textContent = `查询失败：${error.message}。已有显示仅为上次查询结果。`;
  } finally {
    quotaLoading = false;
    $("#quota-refresh").disabled = false;
    $("#quota-refresh").textContent = "刷新额度";
  }
}

function renderModelQuotas() {
  if (!quotaData) return;
  const account = quotaData.accounts.find((item) => item.id === $("#quota-account").value);
  const stale = account?.status === "stale";
  const cards = $("#quota-cards");
  cards.replaceChildren();
  $("#quota-status").textContent = !account
    ? "请先在配置中心添加 OpenCode Go Key。"
    : account.error
      ? `${account.error}${stale ? "；下方显示上次成功数据，当前额度未知。" : "；当前额度未知。"}`
      : "已连接 OpenCode · 共享套餐额度。多个 Key 的额度不相加。";
  $("#quota-updated").textContent = account?.fetched_at
    ? `${stale ? "上次成功查询" : "额度更新时间"}：${localTime(account.fetched_at)} · 缓存 60 秒 · 来源：OpenCode Go /v1/usage`
    : "";
  const windows = [
    ["rolling", "5 小时窗口"],
    ["weekly", "每周窗口"],
    ["monthly", "每月窗口"],
  ];
  for (const [id, label] of windows) {
    const item = account?.windows?.[id];
    const card = document.createElement("div"),
      heading = document.createElement("h3"),
      value = document.createElement("div"),
      progress = document.createElement("progress"),
      reset = document.createElement("div");
    card.className = `quota-card${item?.remaining_percent < 20 ? " quota-low" : ""}`;
    heading.textContent = label;
    value.className = "quota-value";
    value.textContent = item ? `≈ ${item.remaining_percent}%` : "未知";
    progress.max = 100;
    if (item) progress.value = item.remaining_percent;
    else progress.value = 0;
    progress.setAttribute("aria-label", `${label}剩余额度`);
    reset.className = "quota-reset";
    reset.textContent = item
      ? `${stale ? "历史剩余" : "剩余"} · ${item.status === "rate-limited" ? "已限额 · " : ""}重置于 ${localTime(item.resets_at)}`
      : "等待上游额度数据";
    card.append(heading, value, progress, reset);
    cards.appendChild(card);
  }
  const query = $("#quota-model-search").value.trim().toLowerCase();
  const models = quotaData.models.filter((model) => model.id.toLowerCase().includes(query));
  $("#quota-model-count").textContent = `${models.length} / ${quotaData.models.length}`;
  const catalog = quotaData.catalog;
  $("#quota-catalog-status").textContent =
    `${catalog?.stale ? "模型目录暂未更新，显示缓存 · " : ""}目录更新时间：${localTime(catalog?.updated_at)}`;
  const host = $("#quota-models");
  host.replaceChildren();
  for (const model of models) {
    const row = document.createElement("tr");
    appendCell(row, model.id, "mono");
    appendCell(
      row,
      { chat: "Chat Completions", responses: "Responses", anthropic: "Messages" }[model.protocol] ||
        model.protocol,
    );
    for (const [id] of windows) {
      const item = account?.windows?.[id];
      appendCell(row, item ? `≈ ${item.remaining_percent}%${stale ? "（历史）" : ""}` : "未知");
    }
    const cell = document.createElement("td"),
      button = document.createElement("button");
    button.className = "ghost";
    button.textContent = "复制名称";
    button.onclick = () => copyText(model.id);
    cell.appendChild(button);
    row.appendChild(cell);
    host.appendChild(row);
  }
  if (!models.length)
    emptyRow(host, 6, quotaData.models.length ? "没有匹配的模型" : "模型目录尚未就绪，请稍后刷新");
}
$("#quota-refresh").onclick = loadModelQuotas;
$("#quota-account").onchange = renderModelQuotas;
$("#quota-model-search").oninput = renderModelQuotas;

async function loadAPIKeys() {
  if (apiKeysLoading) return;
  apiKeysLoading = true;
  $("#api-key-refresh").disabled = true;
  try {
    const data = await api("/api/api-keys");
    if (csrf) renderAPIKeys(data.keys);
  } catch (error) {
    $("#api-key-status").textContent = `读取失败：${error.message}`;
  } finally {
    apiKeysLoading = false;
    $("#api-key-refresh").disabled = false;
  }
}

async function mutateAPIKey(id, method, body, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/api-keys/${encodeURIComponent(id)}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!csrf) return;
    renderAPIKeys(data.keys);
    await loadConfig();
    toast("已保存并立即生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderAPIKeys(keys) {
  $("#api-key-count").textContent = `${keys.length} 个`;
  $("#api-key-status").textContent = `${keys.filter((key) => key.enabled).length} 个已启用`;
  const host = $("#api-key-list");
  host.replaceChildren();
  for (const key of keys) {
    const row = document.createElement("tr");
    appendCell(row, key.name);
    appendCell(row, key.display, "mono");
    appendCell(row, key.enabled ? "已启用" : "已停用", key.enabled ? "status ok" : "status warn");
    const usage = key.usage || {},
      summary = (value = {}) => `${formatTokens(value.requests)} 次 · ${formatTokens(value.total_tokens)} tokens`;
    appendCell(row, `${summary(usage.last_hour)} / ${summary(usage.lifetime)}`);
    appendCell(row, key.created_at ? localTime(key.created_at) : "已有配置");
    const cell = document.createElement("td"),
      actions = document.createElement("div");
    actions.className = "key-actions";
    for (const [label, action] of [
      [
        "重命名",
        (button) => {
          const name = prompt("密钥名称", key.name);
          if (name !== null) mutateAPIKey(key.id, "PATCH", { name }, button);
        },
      ],
      [
        key.enabled ? "停用" : "启用",
        (button) => mutateAPIKey(key.id, "PATCH", { enabled: !key.enabled }, button),
      ],
      [
        "删除",
        (button) => {
          if (confirm(`删除“${key.name}”后，使用它的应用将无法继续访问。确定删除？`))
            mutateAPIKey(key.id, "DELETE", null, button);
        },
      ],
    ]) {
      const button = document.createElement("button");
      button.className = "ghost";
      button.textContent = label;
      button.onclick = () => action(button);
      actions.appendChild(button);
    }
    cell.appendChild(actions);
    row.appendChild(cell);
    host.appendChild(row);
  }
  if (!keys.length) emptyRow(host, 6, "暂无 API Key");
}
$("#api-key-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#api-key-create");
  button.disabled = true;
  try {
    const data = await api("/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: $("#api-key-name").value, value: $("#api-key-value").value }),
    });
    if (!csrf) return;
    createdKey = data.key;
    const goModels = debugData?.models?.filter((item) => item.available_go) || [];
    const model =
      goModels.find((item) => item.model === "glm-5.3-flash")?.model ||
      goModels[0]?.model ||
      "YOUR_MODEL";
    $("#api-key-env").textContent =
      `OPENAI_API_KEY=${data.key}\nOPENAI_BASE_URL=${derivedAPIBase()}/v1\nOPENAI_MODEL=${model}`;
    $("#api-key-created").classList.remove("hidden");
    $("#api-key-form").reset();
    renderAPIKeys(data.keys);
    await loadConfig();
    toast("API Key 已创建");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
};
$("#api-key-refresh").onclick = loadAPIKeys;
$("#api-key-dismiss").onclick = clearCreatedKey;
$("#api-key-copy").onclick = () => copyText(createdKey);
$("#api-key-copy-env").onclick = () => copyText($("#api-key-env").textContent);
let rotationData = null,
  rotationDirty = false;
const rotationReasons = {
  success: "成功",
  client_canceled: "调用方取消",
  quota_or_rate_limit: "额度不足 / 限流",
  transport_error: "连接错误",
  first_output_timeout: "首个输出超时",
  stream_error: "输出中断",
  response_read_error: "读取响应失败",
  response_conversion_error: "响应解析或转换失败",
  request_conversion_error: "请求转换失败",
  upstream_error: "上游错误",
};
// Go 把空切片序列化成 JSON null（sweet 组 order 为空时就是 null），
// 统一归一化成数组，否则 renderRotation 里 forEach 直接抛
// "Cannot read properties of null"。
function normalizeRotation(value) {
  for (const group of value?.groups || []) {
    group.order = group.order || [];
    group.switches = group.switches || [];
    group.paused = group.paused || {};
    group.available = group.available || {};
  }
  if (value) value.attempts = value.attempts || [];
  return value;
}
async function loadRotation() {
  try {
    const value = await api("/api/rotation");
    if (!csrf) return;
    rotationData = normalizeRotation(value);
    rotationDirty = false;
    renderRotation();
  } catch (error) {
    toast(error.message, true);
  }
}
function renderRotation() {
  const state = rotationData;
  $("#rotation-status").textContent =
    state.persistence_error || "状态已更新 · 两组独立轮转，所有调用方共享当前位置。";
  $("#rotation-timeout").value = state.first_output_seconds;
  const host = $("#rotation-groups");
  host.replaceChildren();
  for (const group of state.groups) {
    const section = document.createElement("div");
    section.className = "section";
    const title = document.createElement("h2");
    title.textContent = group.id === "sota" ? "SOTA" : "甜点";
    const label = document.createElement("label");
    label.textContent = "调用别名";
    label.htmlFor = `rotation-alias-${group.id}`;
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.value = group.alias;
    input.required = true;
    input.maxLength = 64;
    input.oninput = () => {
      group.alias = input.value;
      rotationDirty = true;
    };
    const field = document.createElement("div");
    field.className = "field";
    field.append(label, input);
    const current = document.createElement("p");
    current.className = "mono";
    current.textContent = `当前模型：${group.current || "等待可用模型"}`;
    const table = document.createElement("table");
    table.className = "table";
    const header = document.createElement("tr");
    for (const text of ["顺序", "模型", "状态 / 恢复时间", "操作"]) {
      const th = document.createElement("th");
      th.textContent = text;
      header.append(th);
    }
    const thead = document.createElement("thead");
    thead.append(header);
    table.append(thead);
    const tbody = document.createElement("tbody");
    table.append(tbody);
    group.order.forEach((model, index) => {
      const row = document.createElement("tr");
      appendCell(row, String(index + 1));
      appendCell(row, model, "mono");
      const until = group.paused[model],
        paused = until && new Date(until) > new Date();
      appendCell(
        row,
        !group.available[model]
          ? "已下架 / 暂不可用"
          : paused
            ? `暂停至 ${localTime(until)}`
            : model === group.current
              ? "当前使用"
              : "可用",
      );
      const actions = document.createElement("td");
      actions.className = "rotation-actions";
      for (const [text, delta] of [
        ["上移", -1],
        ["下移", 1],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost";
        button.textContent = text;
        button.setAttribute("aria-label", `${model} ${text}`);
        button.disabled = index + delta < 0 || index + delta >= group.order.length;
        button.onclick = () => {
          [group.order[index], group.order[index + delta]] = [
            group.order[index + delta],
            group.order[index],
          ];
          state.first_output_seconds = Number($("#rotation-timeout").value);
          rotationDirty = true;
          renderRotation();
        };
        actions.append(button);
      }
      const select = document.createElement("button");
      select.type = "button";
      select.className = "ghost";
      select.textContent = "设为当前";
      select.disabled = !group.available[model];
      select.setAttribute("aria-label", `使用 ${model}`);
      select.onclick = async () => {
        select.disabled = true;
        try {
          const result = await api("/api/rotation/current", {
            method: "POST",
            body: JSON.stringify({ group: group.id, model }),
          });
          // Keep unsaved alias/order edits while refreshing operational state.
          for (const item of state.groups) {
            const live = result.groups.find((x) => x.id === item.id);
            Object.assign(item, {
              current: live.current,
              paused: live.paused || {},
              switches: live.switches || [],
            });
          }
          state.persistence_error = result.persistence_error;
          renderRotation();
          toast("当前模型已切换");
        } catch (error) {
          select.disabled = false;
          toast(error.message, true);
        }
      };
      actions.append(select);
      row.append(actions);
      tbody.append(row);
    });
    if (!group.order.length) emptyRow(tbody, 4, "等待 Go 模型目录");
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.append(table);
    const recent = document.createElement("div");
    recent.className = "rotation-switches";
    const caption = document.createElement("h3");
    caption.textContent = "最近切换";
    recent.append(caption);
    for (const item of (group.switches || []).slice(-5).reverse()) {
      const line = document.createElement("p");
      line.textContent = `${localTime(item.time)} · ${item.from} → ${item.to} · ${rotationReasons[item.reason] || item.reason}`;
      recent.append(line);
    }
    if (!group.switches?.length) {
      const line = document.createElement("p");
      line.textContent = "尚无切换记录";
      recent.append(line);
    }
    section.append(title, field, current, wrap, recent);
    host.append(section);
  }
  const attempts = $("#rotation-attempts");
  attempts.replaceChildren();
  for (const item of (state.attempts || []).slice().reverse()) {
    const row = document.createElement("tr");
    for (const value of [
      localTime(item.time),
      item.request,
      item.alias,
      item.model,
      String(item.number),
      rotationReasons[item.outcome] || item.outcome,
    ])
      appendCell(row, value);
    attempts.append(row);
  }
  if (!state.attempts?.length) emptyRow(attempts, 6, "调用分组别名后显示最近 100 次尝试");
}
$("#rotation-refresh").onclick = () => {
  if (rotationDirty) {
    toast("有未保存的修改，请先保存后刷新", true);
    return;
  }
  loadRotation();
};
$("#rotation-timeout").oninput = () => {
  rotationDirty = true;
};
$("#rotation-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!rotationData) return;
  const button = $("#rotation-save");
  button.disabled = true;
  try {
    const body = { first_output_seconds: Number($("#rotation-timeout").value) };
    for (const group of rotationData.groups)
      body[group.id] = { alias: group.alias.trim(), order: group.order };
    rotationData = normalizeRotation(await api("/api/rotation", { method: "PUT", body: JSON.stringify(body) }));
    rotationDirty = false;
    renderRotation();
    toast("模型轮转配置已保存并生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
};
boot();

// 主题切换：默认深色（与 Cline-proxy 一致），偏好记入 localStorage。
try {
  if (localStorage.getItem("o2a-theme") === "light")
    document.documentElement.setAttribute("data-theme", "light");
} catch (_) {}
function syncThemeIcon() {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  const icon = $("#theme-icon");
  if (icon) icon.textContent = light ? "☀️" : "🌙";
}
syncThemeIcon();
$("#theme-toggle").onclick = () => {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  if (light) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", "light");
  try {
    localStorage.setItem("o2a-theme", light ? "dark" : "light");
  } catch (_) {}
  syncThemeIcon();
};

async function loadAvailability() {
  try {
    const data = await api("/api/models/availability");
    $("#availability-error").textContent = "";
    $("#availability-models").replaceChildren();
    for (const item of data.models) {
      const row = document.createElement("tr");
      const date = (value) =>
        value && !value.startsWith("0001-") ? new Date(value).toLocaleString() : "待探测";
      for (const value of [
        item.model,
        item.disabled ? "已禁用" : "已启用",
        [item.channel, item.reason].filter(Boolean).join(" / ") || "待探测",
        item.manual ? "手动" : "自动",
        item.auto_effort?.effort
          ? `${item.auto_effort.effort}（${date(item.effort_checked_at)}）`
          : "未验证",
        date(item.checked_at),
        item.manual ? "手动控制，不自动探测" : date(item.next_check),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      const cell = document.createElement("td");
      const button = document.createElement("button");
      button.textContent = "恢复启用";
      button.disabled = !item.disabled;
      button.onclick = async () => {
        button.disabled = true;
        toggle.disabled = true;
        try {
          await api("/api/models/restore", {
            method: "POST",
            body: JSON.stringify({ model: item.model }),
          });
          await loadAvailability();
          await loadDebugModels();
        } catch (error) {
          $("#availability-error").textContent = error.message;
          button.disabled = !item.disabled;
          toggle.disabled = false;
        }
      };
      cell.append(button);
      const toggle = document.createElement("button");
      toggle.className = "ghost";
      toggle.textContent = item.manual ? "切回自动" : "切为手动";
      toggle.onclick = async () => {
        button.disabled = true;
        toggle.disabled = true;
        try {
          await api("/api/models/manual", {
            method: "POST",
            body: JSON.stringify({ model: item.model, manual: !item.manual }),
          });
          await loadAvailability();
          await loadDebugModels();
        } catch (error) {
          $("#availability-error").textContent = error.message;
          button.disabled = !item.disabled;
          toggle.disabled = false;
        }
      };
      cell.append(toggle);
      row.append(cell);
      $("#availability-models").append(row);
    }
    if (!data.models.length)
      $("#availability-error").textContent = "当前模型目录中没有符合免费资格的模型。";
  } catch (error) {
    $("#availability-error").textContent = error.message;
  }
}
$("#availability-refresh").onclick = loadAvailability;
