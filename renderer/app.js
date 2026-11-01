"use strict";

const $ = (id) => document.getElementById(id);
const invoke = (channel, payload = {}) => window.pluginBridge.invoke(channel, payload);
const errorMessage = (error) => String(error?.message ?? error).replace(/^Error:\s*/, "");

const CHANNELS = [
  {
    kind: "feishu", name: "飞书", icon: "feishu", transport: "长连接",
    description: "使用飞书扫码创建企业自建应用，然后在机器人对话中发送绑定命令。",
    hint: "扫码后按手机提示创建应用；应用凭据会自动写入本机。",
    needs: ["feishuAppId", "feishuAppSecret"],
  },
  {
    kind: "weixin", name: "微信", icon: "weixin", transport: "iLink 长轮询",
    description: "使用微信扫码登录 iLink Bot，然后在机器人对话中发送绑定命令。",
    hint: "扫码授权后，在微信机器人私聊发送下方绑定命令完成激活和授权。",
    needs: ["weixinBotToken"],
  },
  {
    kind: "telegram", name: "Telegram", icon: "telegram", transport: "长轮询",
    description: "在 BotFather 创建机器人并填入 Bot Token，然后在机器人对话中发送绑定命令。",
    hint: "在 BotFather 发送 /newbot 获取 Token；本机需能访问 Telegram。",
    needs: ["telegramBotToken"],
    fields: [{ key: "telegramBotToken", label: "Bot Token", placeholder: "123456789:AA…", secret: true }],
  },
  {
    kind: "dingtalk", name: "钉钉", icon: "dingding", transport: "Stream 长连接",
    description: "钉钉通道还在适配中，暂时无法接入。",
    hint: "钉钉暂不支持，敬请期待。",
    needs: ["dingtalkClientId", "dingtalkClientSecret"], comingSoon: true,
  },
];
const BY_KIND = Object.fromEntries(CHANNELS.map((channel) => [channel.kind, channel]));
const QR_RPC = {
  feishu: {
    begin: "remote-control.beginAppRegistration", poll: "remote-control.pollAppRegistration",
    cancel: "remote-control.cancelAppRegistration", action: "扫码创建", hint: "用飞书扫码，并在手机上确认创建应用",
  },
  weixin: {
    begin: "remote-control.beginWeixinRegistration", poll: "remote-control.pollWeixinRegistration",
    cancel: "remote-control.cancelWeixinRegistration", action: "扫码登录", hint: "用微信扫码，并在手机上确认登录",
  },
};
const STATUS_TEXT = { connected: "已连接", connecting: "连接中", starting: "启动中", stopped: "已停止", unconfigured: "待接入", expired: "登录已失效" };
const BIND_TTL = 10 * 60 * 1000;
const state = { selected: "feishu", snapshot: null, editing: false, formKind: "", dirty: false, qr: null, qrSequence: 0, bind: null, entries: [] };
const channelNodes = new Map();

function show(element, visible) {
  $(element).classList.toggle("hidden", !visible);
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 2800);
}

function isConfigured(kind = state.selected) {
  const credentials = state.snapshot?.credentials;
  return Boolean(credentials && BY_KIND[kind].needs.every((key) => credentials[key]));
}

function isBound(kind = state.selected) {
  return (state.snapshot?.pairings ?? []).some((pairing) => pairing.channel === kind);
}

function channelState(kind = state.selected) {
  return state.snapshot?.channels?.[kind] ?? (state.snapshot?.channel === kind ? state.snapshot : { channelStatus: "stopped", channelError: "", deliveryError: "" });
}

function isRunning(kind = state.selected) {
  return Boolean(state.snapshot && !["stopped", "unconfigured"].includes(channelState(kind).channelStatus));
}

function isOnline(kind = state.selected) {
  return channelState(kind).channelStatus === "connected";
}

function canBind(kind = state.selected) {
  return isConfigured(kind) && isRunning(kind) && !channelState(kind).channelError;
}

function createChannelList() {
  for (const channel of CHANNELS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel";
    button.setAttribute("aria-label", `配置${channel.name}`);
    const image = document.createElement("img");
    image.src = `./icons/${channel.icon}.png`;
    image.alt = "";
    const copy = document.createElement("span");
    copy.className = "channel-copy";
    const name = document.createElement("strong");
    name.textContent = channel.name;
    const status = document.createElement("small");
    const dot = document.createElement("span");
    dot.className = "channel-state";
    copy.append(name, status);
    button.append(image, copy, dot);
    button.addEventListener("click", () => selectChannel(channel.kind));
    $("channelList").appendChild(button);
    channelNodes.set(channel.kind, { button, status, dot });
  }
}

function selectChannel(kind) {
  if (kind === state.selected || state.qr?.busy) return;
  collectDraft();
  stopQr();
  state.selected = kind;
  state.editing = false;
  state.dirty = false;
  state.bind = null;
  state.scopeDraft = null;
  state.scopeError = "";
  $("formStatus").textContent = "";
  window.scrollTo({ top: 0, behavior: "instant" });
  render();
  showBindCommand().catch((error) => toast(errorMessage(error)));
}

function renderChannels() {
  const connected = CHANNELS.filter(channel => isOnline(channel.kind));
  $("overview").textContent = connected.length ? `${connected.map(channel => channel.name).join("、")}运行中` : "当前未连接";
  $("overview").classList.toggle("online", connected.length > 0);
  for (const channel of CHANNELS) {
    const nodes = channelNodes.get(channel.kind);
    const active = channel.kind === state.selected;
    nodes.button.classList.toggle("active", active);
    nodes.button.setAttribute("aria-pressed", String(active));
    nodes.status.textContent = channel.comingSoon ? "即将支持" : isBound(channel.kind) ? isOnline(channel.kind) ? "已连通" : "已绑定" : isConfigured(channel.kind) ? "待绑定" : "未关联";
    nodes.dot.className = `channel-state${isBound(channel.kind) && isOnline(channel.kind) ? " online" : isConfigured(channel.kind) && !channel.comingSoon ? " saved" : ""}`;
  }
}

function renderHead() {
  const channel = BY_KIND[state.selected];
  const snapshot = channelState();
  const active = Boolean(state.snapshot);
  const configured = isConfigured(state.selected);
  let text = channel.comingSoon ? "即将支持" : isBound() && isOnline() ? "已连通" : configured ? "待绑定" : "未关联";
  let className = isBound() && isOnline() ? "online" : configured ? "pending" : "";
  if (configured && !isOnline()) {
    text = active ? STATUS_TEXT[snapshot.channelStatus] ?? snapshot.channelStatus : "未启用";
    className = active && ["starting", "connecting"].includes(snapshot.channelStatus) ? "pending" : active && snapshot.channelError ? "error" : "";
  }
  $("headLogo").src = `./icons/${channel.icon}.png`;
  $("headName").textContent = channel.name;
  $("headTransport").textContent = `${channel.transport} · 无需公网地址`;
  $("headStatus").className = `status ${className}`;
  $("headStatus").innerHTML = '<span class="status-dot"></span>';
  $("headStatus").appendChild(document.createTextNode(text));
  show("toggleBtn", !channel.comingSoon);
  $("toggleBtn").disabled = channel.comingSoon || !configured;
  $("toggleBtn").setAttribute("aria-checked", String(isRunning()));
  $("toggleBtn").setAttribute("aria-label", isRunning() ? `停止${channel.name}` : `启用${channel.name}`);
}

function renderError() {
  const snapshot = channelState();
  const active = Boolean(state.snapshot);
  const connection = active && snapshot.channelStatus !== "unconfigured" && isConfigured() ? snapshot.channelError : "";
  const delivery = active && isConfigured() ? snapshot.deliveryError : "";
  show("errorPanel", Boolean(connection || delivery));
  $("errorTitle").textContent = delivery && !connection ? "消息投递失败" : "渠道连接失败";
  $("errorText").textContent = [connection, delivery].filter(Boolean).join("；");
  const retries = (state.snapshot?.deliveryRetries ?? []).filter(item => item.key.startsWith(`${state.selected}:`));
  show("deliveryRetryPanel", retries.length > 0 && isOnline());
  $("deliveryRetryActions").replaceChildren();
  for (const retry of retries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary small";
    button.textContent = "重试发送";
    button.addEventListener("click", () => withBusy(button, async () => {
      state.snapshot = await invoke("remote-control.retryDelivery", { key: retry.key });
      toast("结果已重新发送");
    }));
    $("deliveryRetryActions").appendChild(button);
  }
}

function buildCredentialForm(channel) {
  $("formFields").replaceChildren();
  for (const field of channel.fields ?? []) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.htmlFor = field.key;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = field.key;
    input.type = field.secret ? "password" : "text";
    input.placeholder = field.secret && state.snapshot?.credentials?.[field.key] ? "已保存，留空则不变" : field.placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.required = !isConfigured(channel.kind);
    input.addEventListener("input", () => { state.dirty = true; $("formStatus").textContent = ""; });
    wrap.append(label, input);
    $("formFields").appendChild(wrap);
  }
  state.formKind = channel.kind;
  state.dirty = false;
}

function collectDraft() {
  if (!state.dirty || !state.formKind) return;
  const draft = {};
  for (const field of BY_KIND[state.formKind].fields ?? []) draft[field.key] = $(field.key)?.value ?? "";
  state.drafts = { ...state.drafts, [state.formKind]: draft };
}

function renderCredential() {
  const channel = BY_KIND[state.selected];
  const configured = isConfigured(channel.kind);
  const bound = isBound();
  const qr = Boolean(QR_RPC[channel.kind]);
  const scanning = Boolean(state.qr);
  const accessVisible = channel.comingSoon ? false : !bound && (!configured || scanning || state.editing);
  const canRebind = configured && !bound && !channel.comingSoon;

  $("connectDescription").textContent = bound ? "" : canRebind
    ? "在机器人对话中发送下方命令，完成绑定。"
    : channel.description;
  $("connectedHint").textContent = isOnline() ? "在机器人对话中发送指令即可远程控制" : "绑定已保留，启用渠道后即可继续使用";
  $("connectedTitle").textContent = isOnline() ? "已连通" : "已绑定";
  show("savedLabel", bound);
  show("connectedPanel", bound);
  show("credentialSetup", accessVisible);
  show("qrAction", accessVisible && qr && !scanning);
  show("qrPanel", accessVisible && qr && scanning);
  show("credentialForm", accessVisible && !qr);
  show("botfatherBtn", accessVisible && channel.kind === "telegram");
  show("botfatherPanel", accessVisible && channel.kind === "telegram");
  if (accessVisible && channel.kind === "telegram" && !state.botfatherLoading && !state.botfatherQr) loadBotFatherQr();
  show("cancelEditBtn", configured && state.editing && !scanning);
  show("clearCredBtn", configured && !channel.comingSoon && !accessVisible);
  show("settingsPanel", !channel.comingSoon);
  show("advanced", !channel.comingSoon);
  show("connectDescription", !bound && !channel.comingSoon);
  show("comingNote", Boolean(channel.comingSoon));
  $("scanBtnText").textContent = scanning ? "正在等待扫码" : QR_RPC[channel.kind]?.action ?? "扫码连接";
  $("scanBtn").disabled = scanning;
  $("formHint").textContent = channel.hint;
  $("saveBtn").textContent = "保存并连接";
  if (accessVisible && !qr && state.formKind !== channel.kind) buildCredentialForm(channel);
  if (!accessVisible) state.formKind = "";
}

function setQrStatus(text, busy = false) {
  $("qrStatus").replaceChildren();
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    $("qrStatus").appendChild(spinner);
  }
  $("qrStatus").appendChild(document.createTextNode(text));
}

async function loadBotFatherQr() {
  state.botfatherLoading = true;
  try {
    const result = await invoke("remote-control.getBotFatherQr");
    state.botfatherQr = result.qrDataUrl;
    $("botfatherImage").src = result.qrDataUrl;
    $("botfatherStatus").textContent = "";
  } catch (error) {
    $("botfatherStatus").textContent = `二维码生成失败：${errorMessage(error)}`;
  } finally { state.botfatherLoading = false; }
}

function stopQr(cancel = true) {
  const qr = state.qr;
  state.qr = null;
  state.qrSequence += 1;
  if (qr?.timer) clearTimeout(qr.timer);
  if (cancel && qr) invoke(QR_RPC[qr.kind].cancel).catch((error) => toast(`取消扫码失败：${errorMessage(error)}`));
}

async function startQr() {
  const kind = state.selected;
  const rpc = QR_RPC[kind];
  if (!rpc || state.qr) return;
  stopQr(false);
  const id = state.qrSequence;
  state.qr = { kind, id, busy: true, started: false, timer: null };
  $("qrImage").hidden = true;
  $("qrLoading").hidden = false;
  $("qrLoading").textContent = "正在生成";
  show("qrUserCode", false);
  show("qrOpenBtn", false);
  $("qrHint").textContent = rpc.hint;
  setQrStatus("正在生成二维码…", true);
  renderCredential();
  try {
    const session = await invoke(rpc.begin);
    if (state.qr?.id !== id) return;
    state.qr.busy = false;
    state.qr.started = true;
    const image = $("qrImage");
    image.onerror = () => {
      image.hidden = true;
      $("qrLoading").hidden = false;
      $("qrLoading").textContent = "二维码加载失败";
      show("qrOpenBtn", true);
    };
    image.onload = () => { $("qrLoading").hidden = true; };
    if (!session.qrDataUrl) throw new Error("后台未返回二维码图片，请重新加载插件");
    image.src = session.qrDataUrl;
    image.hidden = false;
    if (session.userCode) {
      $("qrUserCode").textContent = session.userCode;
      show("qrUserCode", true);
    }
    if (/^https?:\/\//i.test(session.qrUrl)) {
      show("qrOpenBtn", true);
      $("qrOpenBtn").onclick = () => invoke("shell.openExternal", { url: session.qrUrl }).catch((error) => toast(errorMessage(error)));
    }
    setQrStatus("等待手机扫码…", true);
    const poll = async () => {
      if (state.qr?.id !== id) return;
      try {
        const result = await invoke(rpc.poll);
        if (state.qr?.id !== id) return;
        const wait = Math.max(2000, (result.interval ?? session.interval ?? 3) * 1000);
        if (result.status === "pending" || result.status === "scanned") {
          if (result.status === "scanned") setQrStatus("已扫描，请在手机上确认…", true);
          state.qr.timer = setTimeout(poll, wait);
          return;
        }
        if (result.status === "success") {
          stopQr(false);
          state.editing = false;
          state.snapshot = result.state;
          state.bind = null;
          render();
          if (state.selected !== kind) return;
          await startChannel(kind).catch((error) => toast(`连接失败：${errorMessage(error)}`));
          return;
        }
        stopQr();
        renderCredential();
        toast(result.message ?? "扫码未完成，请重试");
      } catch (error) {
        if (state.qr?.id !== id) return;
        stopQr();
        renderCredential();
        toast(`扫码状态更新失败：${errorMessage(error)}`);
      }
    };
    state.qr.timer = setTimeout(poll, Math.max(2000, (session.interval ?? 3) * 1000));
  } catch (error) {
    if (state.qr?.id !== id) return;
    stopQr();
    renderCredential();
    toast(`生成二维码失败：${errorMessage(error)}`);
  }
}

async function withBusy(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try { await action(); }
  catch (error) { toast(errorMessage(error)); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); render(); }
}

async function startChannel(kind = state.selected) {
  state.snapshot = await invoke("remote-control.startChannel", { channel: kind });
  render();
  const current = channelState(kind);
  if (["stopped", "unconfigured"].includes(current.channelStatus) && current.channelError) {
    toast(`连接失败：${current.channelError}`);
    return;
  }
  toast(isOnline(kind) ? `${BY_KIND[kind].name}已连接` : `${BY_KIND[kind].name}正在连接，请发送绑定命令`);
  await showBindCommand();
}

async function saveCredentials(event) {
  event.preventDefault();
  if (!$("credentialForm").reportValidity()) return;
  const kind = state.selected;
  const payload = { channel: kind };
  for (const field of BY_KIND[kind].fields ?? []) payload[field.key] = $(field.key).value;
  $("formStatus").textContent = "";
  await withBusy($("saveBtn"), async () => {
    try {
      state.snapshot = await invoke("remote-control.saveCredentials", payload);
      state.editing = false;
      state.formKind = "";
      await startChannel(kind);
    } catch (error) {
      if ($("credentialForm").classList.contains("hidden")) toast(errorMessage(error));
      else $("formStatus").textContent = errorMessage(error);
    }
  });
}

async function showBindCommand(force = false) {
  const kind = state.selected;
  if (BY_KIND[kind].comingSoon || !canBind(kind) || isBound(kind) || state.qr || state.bindPending) return;
  if (!force && state.bind?.channel === kind) return;
  if (!force && state.snapshot.pairingCode) {
    state.bind = { code: state.snapshot.pairingCode, expiresAt: state.snapshot.pairingExpiresAt, channel: kind };
    renderBindCode();
    return;
  }
  const sequence = state.qrSequence;
  state.bindPending = true;
  renderBindCode();
  try {
    const created = await invoke("remote-control.generatePairingCode");
    if (state.selected !== kind || state.qrSequence !== sequence || isBound(kind) || !canBind(kind)) return;
    state.bind = { code: created.code, expiresAt: created.expiresAt, channel: kind };
  } finally {
    state.bindPending = false;
    renderBindCode();
  }
}

async function generateBindCode() {
  await withBusy($("genCodeBtn"), async () => {
    if (!isRunning()) await startChannel();
    else await showBindCommand(true);
  });
}

function renderBindCode() {
  if (isBound() || !isConfigured()) state.bind = null;
  const ready = !BY_KIND[state.selected].comingSoon && isConfigured() && !isBound() && !state.qr;
  const bind = ready && canBind() && state.bind?.channel === state.selected ? state.bind : null;
  show("bindPanel", Boolean(bind));
  show("genCodeBtn", ready && (!bind || bind.expiresAt <= Date.now()));
  $("genCodeBtn").disabled = Boolean(state.bindPending);
  $("genCodeBtn").textContent = state.bindPending ? "正在生成…" : !isRunning() ? "连接并生成绑定命令" : bind ? "重新生成绑定命令" : "生成绑定命令";
  if (!bind) return;
  const remaining = Math.max(0, bind.expiresAt - Date.now());
  const expired = remaining <= 0;
  $("bindCmdText").textContent = `/bind ${bind.code}`;
  $("bindCountdown").textContent = expired ? "已过期，请重新生成" : `${Math.ceil(remaining / 1000)} 秒后过期`;
  $("bindCopyBtn").disabled = expired;
  $("bindBar").style.transform = `scaleX(${Math.min(1, remaining / BIND_TTL)})`;
  $("bindBar").classList.toggle("expired", expired);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}


function confirmAction(title, text, action) {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmAction").textContent = action;
  const dialog = $("confirmDialog");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}
function renderProjectAccess() {
  const policy = state.scopeDraft ?? state.snapshot?.projectAccess?.[state.selected] ?? { mode: "all", paths: [] };
  $("scopeMode").value = policy.mode;
  $("scopeMode").disabled = Boolean(state.scopeBusy);
  $("scopeDescription").textContent = policy.mode === "all" ? "可使用所有项目，仍受桌面会话权限约束" : `仅允许所选 ${policy.paths.length} 个项目`;
  $("scopeStatus").textContent = state.scopeError || (state.scopeLoading ? "正在读取项目…" : "");
  show("scopeChoices", policy.mode === "selected");
  show("scopeSaveBtn", Boolean(state.scopeDraft));
  $("scopeSaveBtn").disabled = Boolean(state.scopeBusy) || (policy.mode === "selected" && !policy.paths.length);
  const signature = JSON.stringify([state.selected, policy, state.projects, state.scopeBusy]);
  if (state.scopeSignature === signature) return;
  state.scopeSignature = signature;
  $("scopeList").replaceChildren();
  for (const project of state.projects ?? []) {
    const label = document.createElement("label");
    label.className = "project-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = policy.paths.includes(project.path);
    checkbox.disabled = Boolean(state.scopeBusy);
    checkbox.addEventListener("change", () => {
      const paths = new Set((state.scopeDraft ?? policy).paths);
      if (checkbox.checked) paths.add(project.path); else paths.delete(project.path);
      state.scopeDraft = { mode: "selected", paths: [...paths] };
      renderProjectAccess();
    });
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = project.name;
    const location = document.createElement("small");
    location.textContent = project.path;
    text.append(name, location);
    label.append(checkbox, text);
    $("scopeList").appendChild(label);
  }
  if (!state.projects?.length) $("scopeList").textContent = "暂无可选项目，请在桌面添加项目后刷新";
}

async function loadProjects() {
  if (state.scopeLoading) return;
  state.scopeLoading = true;
  state.scopeError = "";
  renderProjectAccess();
  try {
    const result = await invoke("remote-control.getProjectAccess", { channel: state.selected });
    state.projects = result.projects;
  } catch (error) { state.scopeError = `读取项目失败：${errorMessage(error)}`; }
  finally { state.scopeLoading = false; renderProjectAccess(); }
}



function renderReply() {
  const isFeishu = state.selected === "feishu";
  const mode = state.snapshot?.replyModes?.[state.selected] ?? "standard";
  const descriptions = {
    standard: "回复助手正文和文件变更，隐藏工具调用过程",
    full: "回复助手正文、工具调用进度和文件变更",
    summary: "仅回复最终结果和文件变更摘要，适合低打扰通知",
  };
  for (const [id, value] of [["cardModeBtn", "streaming_card"], ["textModeBtn", "standard"], ["fullModeBtn", "full"], ["summaryModeBtn", "summary"]]) {
    const button = $(id);
    show(id, isFeishu ? value === "streaming_card" : value !== "streaming_card");
    button.disabled = isFeishu;
    const active = isFeishu || mode === value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  $("replyDescription").textContent = isFeishu
    ? "基于 Card JSON 2.0 流式卡片，工具调用只显示折叠摘要" : descriptions[mode];
}

function renderAdvanced() {
  const snapshot = channelState().snapshot;
  const sum = (object) => Object.values(object ?? {}).reduce((total, value) => total + value, 0);
  const metrics = [
    ["执行中", snapshot?.busySessions?.length ?? 0], ["排队", sum(snapshot?.queued)],
    ["待审批", snapshot?.pendingApprovals?.length ?? 0], ["待补发", sum(snapshot?.outboxes)],
  ];
  $("snapshot").replaceChildren();
  for (const [label, value] of metrics) {
    const span = document.createElement("span");
    span.textContent = `${label} `;
    const bold = document.createElement("b");
    bold.textContent = value;
    span.appendChild(bold);
    $("snapshot").appendChild(span);
  }
  const entries = state.entries.filter((entry) => !entry.channel || entry.channel === state.selected);
  $("log").textContent = entries.map((entry) => `${formatTime(entry.time) || entry.time}  ${entry.event}${entry.message ? `  ${entry.message}` : ""}`).join("\n") || "暂无运行记录";
  $("activitySummary").textContent = entries.length ? `${entries.length} 条` : "";
  $("sessionList").replaceChildren();
  for (const binding of (state.snapshot?.bindings ?? []).filter((item) => item.key.startsWith(`${state.selected}:`))) {
    const row = document.createElement("div");
    row.className = "session-row";
    const chat = document.createElement("span");
    chat.textContent = binding.key.slice(state.selected.length + 1);
    const session = document.createElement("span");
    session.className = "session-id";
    session.textContent = binding.sessionId;
    session.title = binding.sessionId;
    row.append(chat, session);
    $("sessionList").appendChild(row);
  }
}

function render() {
  renderChannels();
  renderHead();
  renderError();
  renderCredential();
  renderProjectAccess();
  renderReply();
  const configToggle = $("remoteConfigToggle");
  configToggle.setAttribute("aria-checked", String(state.snapshot?.settings?.allowDangerousRemote !== false));
  configToggle.disabled = !state.snapshot || configToggle.getAttribute("aria-busy") === "true";
  renderBindCode();
  renderAdvanced();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await invoke("remote-control.getState");
    state.snapshot = next;
    if (!state.seeded) {
      state.selected = next.channel ?? "feishu";
      state.seeded = true;
      loadProjects();
    }
    if ($("advanced").open) {
      const audit = await invoke("remote-control.getAudit", { limit: 40 });
      state.entries = audit.entries ?? [];
    }
    render();
    await showBindCommand();
  } catch (error) {
    $("overview").textContent = "读取失败";
    toast(`面板加载失败：${errorMessage(error)}`);
  } finally {
    refreshing = false;
  }
}

$("toggleBtn").addEventListener("click", () => withBusy($("toggleBtn"), async () => {
  if (isRunning()) {
    state.snapshot = await invoke("remote-control.stopChannel", { channel: state.selected });
    toast(`${BY_KIND[state.selected].name}已停止`);
  } else {
    await startChannel();
  }
}));
$("credentialForm").addEventListener("submit", saveCredentials);
$("cancelEditBtn").addEventListener("click", () => {
  stopQr();
  state.editing = false;
  state.formKind = "";
  state.dirty = false;
  render();
});
$("scanBtn").addEventListener("click", startQr);
$("qrCancelBtn").addEventListener("click", () => { stopQr(); renderCredential(); });
$("genCodeBtn").addEventListener("click", generateBindCode);
$("bindCopyBtn").addEventListener("click", () => withBusy($("bindCopyBtn"), async () => {
  await invoke("clipboard.writeText", { text: $("bindCmdText").textContent });
  toast("绑定命令已复制，请打开机器人私聊，粘贴并发送");
}));
$("botfatherBtn").addEventListener("click", () => invoke("shell.openExternal", { url: "https://t.me/BotFather" }).catch((error) => toast(errorMessage(error))));
$("clearCredBtn").addEventListener("click", async () => {
  const kind = state.selected;
  if (!await confirmAction(`清除${BY_KIND[kind].name}凭据？`, "将停止此渠道并移除本机保存的登录信息。其他渠道不受影响。", "清除凭据")) return;
  await withBusy($("clearCredBtn"), async () => {
    stopQr();
    state.snapshot = await invoke("remote-control.clearCredentials", { channel: kind });
    state.editing = false;
    state.formKind = "";
    state.bind = null;
    toast(`${BY_KIND[kind].name}凭据已清除`);
  });
});
$("unbindBtn").addEventListener("click", () => withBusy($("unbindBtn"), async () => {
  const kind = state.selected;
  if (!await confirmAction(`解绑${BY_KIND[kind].name}机器人？`, "已绑定的聊天将无法继续远程控制桌面会话，需要重新发送绑定命令。", "解绑")) return;
  state.snapshot = await invoke("remote-control.unbind", { channel: kind });
  state.bind = null;
  render();
  await showBindCommand();
  toast(`${BY_KIND[kind].name}已解绑`);
}));
$("remoteConfigToggle").addEventListener("click", () => withBusy($("remoteConfigToggle"), async () => {
  const enabled = state.snapshot?.settings?.allowDangerousRemote === false;
  state.snapshot = await invoke("remote-control.setRemoteConfigEnabled", { enabled });
  toast(enabled ? "已允许远程配置切换，可在机器人发送 /项目" : "已关闭远程配置切换");
}));
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => withBusy(button, async () => {
    const kind = state.selected;
    if (kind === "feishu") return;
    const snapshot = await invoke("remote-control.updateSettings", { channel: kind, replyMode: button.dataset.mode });
    state.snapshot = snapshot;
    toast("回复颗粒度已更新");
  }));
}
$("advanced").addEventListener("toggle", () => { if ($("advanced").open) refresh(); });

$("scopeMode").addEventListener("change", () => {
  const saved = state.snapshot?.projectAccess?.[state.selected];
  state.scopeDraft = { mode: $("scopeMode").value, paths: saved?.mode === "selected" ? [...saved.paths] : [] };
  state.scopeError = "";
  renderProjectAccess();
  if (!state.projects) loadProjects();
});
$("scopeRefreshBtn").addEventListener("click", loadProjects);
$("scopeSaveBtn").addEventListener("click", async () => {
  if (state.scopeBusy || !state.scopeDraft) return;
  const kind = state.selected;
  const policy = state.scopeDraft;
  state.scopeBusy = true;
  state.scopeError = "";
  renderProjectAccess();
  try {
    state.snapshot = await invoke("remote-control.setProjectAccess", { channel: kind, ...policy });
    if (state.selected === kind) state.scopeDraft = null;
    toast("项目范围已保存");
  } catch (error) { state.scopeError = `保存失败：${errorMessage(error)}`; }
  finally { state.scopeBusy = false; renderProjectAccess(); }
});
createChannelList();
render();
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
setInterval(renderBindCode, 1000);
refresh();
