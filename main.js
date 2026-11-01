"use strict";

const {
  PLUGIN_ID,
  SERVICE_ID,
  CHANNEL_KIND_FEISHU,
  CHANNEL_KIND_DINGTALK,
  CHANNEL_KIND_TELEGRAM,
  CHANNEL_KIND_WEIXIN,
  CHANNEL_KINDS,
} = require("./lib/constants.cjs");
const { createFeishuRegistration } = require("./lib/feishu-registration.cjs");
const { createWeixinRegistration } = require("./lib/weixin-registration.cjs");
const { createStore } = require("./lib/store.cjs");
const { createBridge } = require("./lib/bridge.cjs");
const { createChannel } = require("./lib/channel.cjs");
const { startIpcServer } = require("./lib/ipc.cjs");
const { generatePairingCode, createRateLimiter } = require("./lib/security.cjs");
const { qrDataUrl, BOTFATHER_URL } = require("./lib/qr.cjs");
const { listProjects, pathKey } = require("./lib/project-access.cjs");
const { TEXT_REPLY_MODES, TEXT_REPLY_CHANNELS, replyModeFor } = require("./lib/reply-mode.cjs");

const COMMAND_ID = "mobile-remote.openPanel";

/** 各通道缺少凭据时的面板提示。 */
const MISSING_CREDENTIAL_HINTS = {
  [CHANNEL_KIND_FEISHU]: "缺少飞书 AppID/AppSecret",
  [CHANNEL_KIND_DINGTALK]: "缺少钉钉 ClientID/ClientSecret",
  [CHANNEL_KIND_TELEGRAM]: "缺少 Telegram BotToken（找 @BotFather 申请，或用面板填写）",
  [CHANNEL_KIND_WEIXIN]: "缺少微信 iLink BotToken（用面板扫码登录获取）",
};

const CREDENTIAL_FIELDS = {
  feishu: ["feishuAppId", "feishuAppSecret"],
  dingtalk: ["dingtalkClientId", "dingtalkClientSecret"],
  telegram: ["telegramBotToken"],
  weixin: ["weixinBotToken", "weixinBotId"],
};

/** 面板 → 插件 的自定义 RPC 通道。 */
const PANEL_CHANNELS = {
  "remote-control.getState": "getState",
  "remote-control.generatePairingCode": "generatePairingCode",
  "remote-control.saveCredentials": "saveCredentials",
  "remote-control.clearCredentials": "clearCredentials",
  "remote-control.startChannel": "startChannel",
  "remote-control.stopChannel": "stopChannel",
  "remote-control.unpair": "unpair",
  "remote-control.unbind": "unbind",
  "remote-control.getAudit": "getAudit",
  "remote-control.updateSettings": "updateSettings",
  "remote-control.beginAppRegistration": "beginAppRegistration",
  "remote-control.pollAppRegistration": "pollAppRegistration",
  "remote-control.cancelAppRegistration": "cancelAppRegistration",
  "remote-control.beginWeixinRegistration": "beginWeixinRegistration",
  "remote-control.pollWeixinRegistration": "pollWeixinRegistration",
  "remote-control.cancelWeixinRegistration": "cancelWeixinRegistration",
  "remote-control.getBotFatherQr": "getBotFatherQr",
  "remote-control.getProjectAccess": "getProjectAccess",
  "remote-control.setProjectAccess": "setProjectAccess",
  "remote-control.retryDelivery": "retryDelivery",
  "remote-control.setRemoteConfigEnabled": "setRemoteConfigEnabled",
};

/** 扫码会话：deviceCode/qrcode 只在插件内存中保存，不落盘。 */
let appRegistration = null;
let weixinRegistration = null;

let store = null;
let ipc = null;
let dataDir = null;
let settingsCache = {};
const runtimes = new Map();
const executionLocks = new Map();

const inboundLimiter = createRateLimiter();
function log(level, message, data) {
  try {
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      `[${PLUGIN_ID}] ${message}`,
      data ? JSON.stringify(data) : "",
    );
  } catch {
    /* 日志不影响主流程 */
  }
}

function getSettings() {
  return settingsCache;
}
async function setReplyMode(kind, mode) {
  if (!TEXT_REPLY_CHANNELS.includes(kind) || !TEXT_REPLY_MODES.includes(mode)) throw new Error("不支持的回复颗粒度");
  await pi.plugin.setSettings({ [`${kind}ReplyMode`]: mode });
  await refreshSettings();
}


function runtimeFor(kind) {
  if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
  let runtime = runtimes.get(kind);
  if (!runtime) {
    runtime = { kind, channel: null, status: "stopped", error: "", sequence: 0, stopping: Promise.resolve() };
    runtime.bridge = createBridge({ store, channelKind: kind, executionLocks,
      getSettings: () => ({ ...getSettings(), channel: kind }), getChannel: () => runtime.channel,
      setReplyMode, log, audit: entry => store.audit(entry) });
    runtimes.set(kind, runtime);
  }
  return runtime;
}

async function dispatchAgentEvent(event) {
  const bridges = [...runtimes.values()].map(runtime => runtime.bridge);
  if (["send_file", "phone_question", "phone_question_poll", "phone_question_cancel"].includes(event.type)) {
    const owner = bridges.find(bridge => bridge.ownsInteraction(event));
    if (owner) return owner.handleAgentEvent(event);
    if (event.type === "send_file") return { success: false, error: "没有当前手机任务的发送目标" };
    if (event.type === "phone_question") throw new Error("只有手机发起的当前任务可以提问");
    return { state: "expired", success: false, error: "原任务或授权已失效" };
  }
  await Promise.all([...runtimes.values()].filter(runtime => runtime.channel).map(runtime => runtime.bridge.handleAgentEvent(event)));
}

function activeChannelKind() {
  const kind = getSettings().channel;
  return CHANNEL_KINDS.includes(kind) ? kind : CHANNEL_KIND_FEISHU;
}

function credentialsFor(kind) {
  const credentials = store?.loadCredentials() ?? null;
  if (!credentials) return null;
  if (kind === CHANNEL_KIND_DINGTALK) {
    if (!credentials.dingtalkClientId || !credentials.dingtalkClientSecret) return null;
    return { clientId: credentials.dingtalkClientId, clientSecret: credentials.dingtalkClientSecret };
  }
  if (kind === CHANNEL_KIND_TELEGRAM) {
    if (!credentials.telegramBotToken) return null;
    return { botToken: credentials.telegramBotToken };
  }
  if (kind === CHANNEL_KIND_WEIXIN) {
    if (!credentials.weixinBotToken) return null;
    return { botToken: credentials.weixinBotToken, botId: credentials.weixinBotId ?? "" };
  }
  if (!credentials.feishuAppId || !credentials.feishuAppSecret) return null;
  return { appId: credentials.feishuAppId, appSecret: credentials.feishuAppSecret };
}

async function refreshSettings() {
  try {
    settingsCache = (await pi.plugin.getSettings()) ?? {};
  } catch (error) {
    log("warn", "getSettings failed", { error: String(error?.message ?? error) });
    settingsCache = {};
  }
  return settingsCache;
}

async function startChannel(kind = activeChannelKind()) {
  const runtime = runtimeFor(kind);
  const sequence = ++runtime.sequence;
  await refreshSettings();
  if (sequence !== runtime.sequence) return { started: false, reason: "连接已取消" };
  await stopChannel(kind, false, true);
  if (sequence !== runtime.sequence) return { started: false, reason: "连接已取消" };
  const credentials = credentialsFor(kind);
  if (!credentials) {
    runtime.status = "unconfigured";
    runtime.error = "";
    return { started: false, reason: MISSING_CREDENTIAL_HINTS[kind] ?? "缺少通道凭据" };
  }
  runtime.error = "";
  runtime.status = "connecting";
  const active = createChannel(kind, {
    ...credentials, dataDir,
    onMessage: async message => {
      if (runtime.channel !== active) return;
      if (!inboundLimiter.check(`${kind}:${message.chatId}`)) {
        await active.sendText(message.chatId, "消息过于频繁，请稍后再试（每分钟 12 条）。");
        return;
      }
      await runtime.bridge.handleInbound({ ...message, channel: kind });
      if (runtime.channel === active && kind === "weixin" && message.meta?.contextToken && store.isPaired(kind, message.chatId) &&
          store.getPairings()[`${kind}:${message.chatId}`]?.userId === message.userId) {
        store.saveContextToken(kind, message.chatId, message.meta.contextToken);
      }
    },
    onChoice: choice => runtime.channel === active ? runtime.bridge.handleChoice({ ...choice, channel: kind }) : undefined,
    onLog: (level, message, data) => {
      log(level, message, data);
      // 把 onLog 的 data 一起落盘：微信 poll/send 的真实错误码只在 data 里，
      // 之前被丢弃，导致 audit.jsonl 只能看到 "weixin poll failed" 却不知道原因。
      store.audit({ event: "channel-log", channel: kind, level, message, ...(data === undefined ? {} : { data }) });
    },
    onStatus: (status, error) => {
      if (runtime.channel !== active) return;
      runtime.status = status;
      if (status === "connected") runtime.error = "";
      else if (error) runtime.error = String(error);
    },
    isAuthorized: (chatId, userId) => store.isPaired(kind, chatId) && store.getPairings()[`${kind}:${chatId}`]?.userId === userId,
    loadContextToken: async chatId => store.getContextToken(kind, chatId),
    saveContextToken: async (chatId, token) => { if (runtime.channel === active) store.saveContextToken(kind, chatId, token); },
    loadOffset: async () => store.getOffset(kind),
    saveOffset: async value => { if (runtime.channel === active) store.setOffset(kind, value); },
    loadBuf: async () => store.getOffset(kind),
    saveBuf: async value => { if (runtime.channel === active) store.setOffset(kind, value); },
  });
  runtime.channel = active;
  try {
    await active.start();
    if (runtime.channel === active) await runtime.bridge.attachChannel();
  } catch (error) {
    if (runtime.channel !== active) return { started: false, reason: "连接已取消" };
    await stopChannel(kind, false, true);
    if (sequence !== runtime.sequence) return { started: false, reason: "连接已取消" };
    runtime.status = "stopped";
    runtime.error = String(error?.message ?? error);
    log("error", `channel start failed (${kind})`, { error: runtime.error });
    store.audit({ event: "channel-start-failed", channel: kind, error: runtime.error });
    return { started: false, reason: runtime.error };
  }
  if (runtime.channel !== active) return { started: false, reason: "连接已取消" };
  if (runtime.status === "connecting" && !runtime.error) runtime.status = "starting";
  store.audit({ event: "channel-start", channel: kind });
  return { started: true };
}

async function stopChannel(kind = activeChannelKind(), invalidate = true, preserveTurns = false) {
  const runtime = runtimeFor(kind);
  if (invalidate) runtime.sequence += 1;
  const active = runtime.channel;
  runtime.channel = null;
  if (active) {
    runtime.stopping = (async () => {
      await runtime.bridge.detachChannel({ preserveTurns });
      try { await active.stop(); }
      catch (error) { log("warn", "channel stop failed", { channel: kind, error: String(error?.message ?? error) }); }
      store.audit({ event: "channel-stop", channel: kind });
    })();
  } else if (!preserveTurns) await runtime.bridge.detachChannel();
  await runtime.stopping;
  if (!runtime.channel) runtime.status = "stopped";
}

async function stopAllChannels(preserveTurns) {
  await Promise.all([...runtimes.keys()].map(kind => stopChannel(kind, true, preserveTurns)));
}

async function onHostTurnEnded(event) {
  await Promise.all([...runtimes.values()].filter(runtime => runtime.channel).map(runtime =>
    runtime.bridge.handleHostTurnEnded(event).catch(error => {
      log("error", "host turn completion failed", { channel: runtime.kind, sessionId: event?.sessionId, turnId: event?.turnId, error: String(error?.message ?? error) });
    })));
}

async function onLoad() {
  if (typeof pi === "undefined") {
    throw new Error("pi host api unavailable");
  }
  dataDir = await pi.plugin.getDataPath();
  store = createStore(dataDir);
  await refreshSettings();
  for (const kind of CHANNEL_KINDS) runtimeFor(kind);
  pi.events.on("session:turnEnded", onHostTurnEnded);

  ipc = await startIpcServer({
    dataDir,
    onEvent: dispatchAgentEvent,
    onError: (message, error) => log("warn", message, { error: String(error?.message ?? error) }),
  });

  await pi.commands.register({
    id: COMMAND_ID,
    title: "Pi-Desktop 机器人: 打开控制面板",
    keywords: [
      "remote", "远程", "control", "控制",
      "feishu", "飞书", "dingtalk", "钉钉",
      "telegram", "weixin", "微信", "bot", "机器人",
    ],
    run: async () => {
      await pi.ui.openPanel({ title: "Pi-Desktop 机器人" });
    },
  });

  // 常驻服务由宿主 broker 在 onLoad 返回后启动；未配置时保持空闲（不抛错，
  // 避免被标记为 failed），配置就绪或网络抖动时由宿主重试。
  await pi.services.register({
    id: SERVICE_ID,
    start: async () => {
      const enabled = store.getEnabledChannels() ?? [activeChannelKind()];
      await Promise.all(enabled.filter(kind => CHANNEL_KINDS.includes(kind)).map(kind => startChannel(kind)));
    },
    stop: async () => { await stopAllChannels(true); },
  });

  if (!credentialsFor(activeChannelKind())) {
    runtimeFor(activeChannelKind()).status = "unconfigured";
    log("info", "loaded without credentials; waiting for panel setup");
  }

  log("info", "loaded", { ipcPort: ipc.port });
}

async function onUnload() {
  pi.events.off("session:turnEnded", onHostTurnEnded);
  appRegistration = null;
  weixinRegistration = null;
  await stopAllChannels(true);
  await Promise.all([...runtimes.values()].map(runtime => runtime.bridge.dispose()));
  runtimes.clear();
  executionLocks.clear();
  if (ipc) {
    await ipc.stop();
    ipc = null;
  }
  store?.removeIpcFile();
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    /* 宿主可能已卸载命令表 */
  }
}

function clearChannelBindings(kind) {
  const prefix = `${kind}:`;
  for (const key of Object.keys(store.getPairings())) {
    if (key.startsWith(prefix)) store.unpair(kind, key.slice(prefix.length));
  }
  for (const binding of store.listBindings()) {
    if (binding.key.startsWith(prefix)) store.clearBinding(kind, binding.key.slice(prefix.length));
  }
}

async function saveChannelCredentials(kind, next, isCurrent = () => true) {
  const fields = CREDENTIAL_FIELDS[kind];
  const previous = store.loadCredentials() ?? {};
  const changed = fields.some(field => (previous[field] ?? "") !== (next[field] ?? ""));
  if (changed) await stopChannel(kind);
  if (!isCurrent()) return false;
  if (changed) {
    clearChannelBindings(kind);
    store.setOffset(kind, null);
    if (kind === activeChannelKind()) store.clearPairingCode();
  }
  const merged = { ...(store.loadCredentials() ?? {}) };
  for (const field of fields) {
    if (next[field]) merged[field] = next[field];
    else delete merged[field];
  }
  store.saveCredentials(merged);
  return true;
}

function panelState() {
  const credentials = store?.loadCredentials() ?? null;
  const pairings = Object.values(store?.getPairings() ?? {});
  const bindings = store?.listBindings() ?? [];
  const pairing = store?.getPairingCode() ?? null;
  const selected = runtimeFor(activeChannelKind());
  const channels = Object.fromEntries(CHANNEL_KINDS.map(kind => {
    const runtime = runtimeFor(kind);
    return [kind, { channelStatus: runtime.status, channelError: runtime.error,
      deliveryError: runtime.channel?.getDeliveryError?.() ?? "", snapshot: runtime.bridge.snapshot() }];
  }));
  return {
    channels,
    channelStatus: selected.status,
    channelError: selected.error,
    channel: activeChannelKind(),
    credentials: credentials
      ? {
          feishuAppId: credentials.feishuAppId ?? "",
          feishuAppSecret: credentials.feishuAppSecret ? "***" : "",
          dingtalkClientId: credentials.dingtalkClientId ?? "",
          dingtalkClientSecret: credentials.dingtalkClientSecret ? "***" : "",
          telegramBotToken: credentials.telegramBotToken ? "***" : "",
          weixinBotToken: credentials.weixinBotToken ? "***" : "",
          weixinBotId: credentials.weixinBotId ?? "",
        }
      : null,
    pairingCode: pairing && Date.now() - pairing.at < 10 * 60 * 1000 ? pairing.code : null,
    pairingExpiresAt: pairing ? pairing.at + 10 * 60 * 1000 : null,
    pairings,
    bindings,
    settings: getSettings(),
    replyModes: Object.fromEntries(CHANNEL_KINDS.map(kind => [kind, replyModeFor(getSettings(), kind)])),
    projectAccess: Object.fromEntries(CHANNEL_KINDS.map(kind => [kind, store.getProjectAccess(kind)])),
    snapshot: selected.bridge.snapshot(),
    ipcPort: ipc?.port ?? 0,
    deliveryError: selected.channel?.getDeliveryError?.() ?? "",
    deliveryRetries: bindings.filter(binding => {
      const [kind, ...rest] = binding.key.split(":");
      const failed = store.getFailedDelivery(kind, rest.join(":"));
      return failed?.sessionId === binding.sessionId && failed.boundAt === binding.boundAt;
    }).map(binding => ({ key: binding.key })),
  };
}

async function onPanelInvoke(channelKey, payload = {}) {
  const action = PANEL_CHANNELS[channelKey];
  if (!action) throw new Error(`unsupported panel channel: ${channelKey}`);

  switch (action) {
    case "getState":
      return panelState();
    case "getBotFatherQr":
      return { url: BOTFATHER_URL, qrDataUrl: await qrDataUrl(BOTFATHER_URL) };
    case "retryDelivery": {
      const kind = String(payload.key ?? "").split(":")[0];
      const key = String(payload.key ?? "");
      if (!CHANNEL_KINDS.includes(kind) || !runtimeFor(kind).channel) throw new Error("请先连接原渠道");
      const chatId = key.slice(kind.length + 1);
      if (getSettings().requirePairing !== false && !store.isPaired(kind, chatId)) throw new Error("聊天授权已失效");
      const result = await runtimeFor(kind).bridge.retryDelivery(kind, chatId);
      if (result?.delivered === false) throw new Error(result.reason || "结果重试失败");
      return panelState();
    }
    case "getProjectAccess": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      return { policy: store.getProjectAccess(kind), projects: await listProjects((operation, args) => pi.desktop.invoke({ operation, args })) };
    }
    case "setProjectAccess": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      if (!["all", "selected"].includes(payload.mode)) throw new Error("不支持的项目范围");
      let paths = [];
      if (payload.mode === "selected") {
        if (!Array.isArray(payload.paths) || !payload.paths.length || payload.paths.some(value => typeof value !== "string" || !value.trim())) throw new Error("请至少选择一个项目");
        const projects = await listProjects((operation, args) => pi.desktop.invoke({ operation, args }));
        paths = [...new Set(payload.paths.map(value => {
          const project = projects.find(item => pathKey(item.path) === pathKey(value));
          if (!project) throw new Error("项目已不存在，请刷新项目列表");
          return project.path;
        }))];
      }
      store.setProjectAccess(kind, { mode: payload.mode, paths });
      store.audit({ event: "project-access-updated", channel: kind, mode: payload.mode, count: paths.length });
      return panelState();
    }
    case "generatePairingCode": {
      const { code } = generatePairingCode();
      store.setPairingCode(code);
      store.audit({ event: "pairing-code-generated" });
      return { code, expiresAt: store.getPairingCode().at + 10 * 60 * 1000 };
    }
    case "unbind": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      clearChannelBindings(kind);
      store.clearPairingCode();
      store.audit({ event: "unbound", channel: kind });
      return panelState();
    }
    case "saveCredentials": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      const next = { ...(store.loadCredentials() ?? {}) };
      const fields = CREDENTIAL_FIELDS;
      for (const field of fields[kind]) {
        if (payload[field]) next[field] = String(payload[field]).trim();
      }
      for (const field of fields[kind]) {
        if (field.endsWith("BotId")) continue;
        if (!next[field]) {
          throw new Error(kind === CHANNEL_KIND_WEIXIN ? "请先扫码登录微信" : "请填写完整的通道凭据");
        }
      }
      if (kind === "feishu") appRegistration = null;
      if (kind === "weixin") weixinRegistration = null;
      await saveChannelCredentials(kind, next);
      store.audit({ event: "credentials-saved", channel: kind });
      await refreshSettings();
      if (kind !== getSettings().channel) {
        store.clearPairingCode();
        await pi.plugin.setSettings({ channel: kind });
        await refreshSettings();
      }
      return panelState();
    }
    case "clearCredentials": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      if (kind === "feishu") appRegistration = null;
      if (kind === "weixin") weixinRegistration = null;
      await stopChannel(kind);
      store.setChannelEnabled(kind, false, [activeChannelKind()]);
      store.setOffset(kind, null);
      clearChannelBindings(kind);
      if (kind === activeChannelKind()) store.clearPairingCode();
      const previous = store.loadCredentials();
      if (previous) {
        const next = { ...previous };
        for (const key of Object.keys(next)) {
          if (key.toLowerCase().startsWith(kind)) delete next[key];
        }
        if (Object.keys(next).length) store.saveCredentials(next);
        else store.clearCredentials();
      }
      runtimeFor(kind).status = "unconfigured";
      runtimeFor(kind).error = "";
      store.audit({ event: "credentials-cleared", channel: kind });
      return panelState();
    }
    case "startChannel": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      if (kind !== activeChannelKind()) {
        store.clearPairingCode();
        await pi.plugin.setSettings({ channel: kind });
        await refreshSettings();
      }
      store.setChannelEnabled(kind, true, [...runtimes.values()].filter(runtime => runtime.channel).map(runtime => runtime.kind));
      await startChannel(kind);
      return panelState();
    }
    case "stopChannel": {
      const kind = payload.channel ?? activeChannelKind();
      if (!CHANNEL_KINDS.includes(kind)) throw new Error("不支持的通道");
      store.setChannelEnabled(kind, false, [activeChannelKind()]);
      await stopChannel(kind);
      return panelState();
    }
    case "setRemoteConfigEnabled": {
      if (typeof payload.enabled !== "boolean") throw new Error("远程配置开关必须为布尔值");
      await pi.plugin.setSettings({ allowDangerousRemote: payload.enabled });
      settingsCache = { ...settingsCache, allowDangerousRemote: payload.enabled };
      store.audit({ event: "remote-config-updated", enabled: payload.enabled });
      return panelState();
    }
    case "updateSettings": {
      const kind = payload.channel ?? activeChannelKind();
      if (kind === "feishu" && payload.replyMode === "streaming_card") return panelState();
      if (!TEXT_REPLY_CHANNELS.includes(kind) || !TEXT_REPLY_MODES.includes(payload.replyMode)) {
        throw new Error("不支持的回复颗粒度");
      }
      await setReplyMode(kind, payload.replyMode);
      return panelState();
    }
    case "unpair": {
      const key = String(payload.key ?? "");
      const [kind, ...rest] = key.split(":");
      if (key !== `${kind}:${rest.join(":")}`) throw new Error("无效的聊天标识");
      store.unpair(kind, rest.join(":"));
      store.audit({ event: "unpaired", key });
      return panelState();
    }
    case "getAudit":
      return { entries: store.readAudit(Number(payload.limit) || 50) };
    case "beginAppRegistration": {
      const registration = createFeishuRegistration();
      const attempt = { registration };
      appRegistration = attempt;
      const session = await registration.begin();
      const image = await qrDataUrl(session.qrUrl);
      if (appRegistration !== attempt) return { status: "idle" };
      Object.assign(attempt, { deviceCode: session.deviceCode, expiresAt: session.expiresAt });
      store.audit({ event: "app-registration-begin" });
      return { qrUrl: session.qrUrl, qrDataUrl: image, userCode: session.userCode, interval: session.interval, expiresAt: session.expiresAt };
    }
    case "pollAppRegistration": {
      const attempt = appRegistration;
      if (!attempt) return { status: "idle" };
      if (!attempt.deviceCode) return { status: "pending" };
      if (Date.now() >= attempt.expiresAt) {
        appRegistration = null;
        return { status: "expired", message: "扫码授权已过期，请重新开始" };
      }
      const result = await attempt.registration.poll({ deviceCode: attempt.deviceCode });
      if (appRegistration !== attempt) return { status: "idle" };
      if (Date.now() >= attempt.expiresAt) {
        appRegistration = null;
        return { status: "expired", message: "扫码授权已过期，请重新开始" };
      }
      if (result.status === "success") {
        const saved = await saveChannelCredentials("feishu", { feishuAppId: result.appId, feishuAppSecret: result.appSecret }, () => appRegistration === attempt);
        if (!saved) return { status: "idle" };
        appRegistration = null;
        store.audit({ event: "app-registration-success", appId: result.appId });
        await refreshSettings();
        if (getSettings().channel !== CHANNEL_KIND_FEISHU) {
          store.clearPairingCode();
          await pi.plugin.setSettings({ channel: CHANNEL_KIND_FEISHU });
          await refreshSettings();
        }
        return { status: "success", appName: result.appName ?? "", state: panelState() };
      }
      if (result.status !== "pending") appRegistration = null;
      return result;
    }
    case "cancelAppRegistration":
      appRegistration = null;
      store.audit({ event: "app-registration-cancelled" });
      return { status: "cancelled" };
    case "beginWeixinRegistration": {
      const registration = createWeixinRegistration();
      const attempt = { registration };
      weixinRegistration = attempt;
      const session = await registration.begin();
      const image = await qrDataUrl(session.qrUrl);
      if (weixinRegistration !== attempt) return { status: "idle" };
      Object.assign(attempt, { qrCode: session.qrCode, expiresAt: session.expiresAt });
      store.audit({ event: "weixin-registration-begin" });
      return { qrUrl: session.qrUrl, qrDataUrl: image, userCode: session.userCode, interval: session.interval, expiresAt: session.expiresAt };
    }
    case "pollWeixinRegistration": {
      const attempt = weixinRegistration;
      if (!attempt) return { status: "idle" };
      if (!attempt.qrCode) return { status: "pending" };
      if (Date.now() >= attempt.expiresAt) {
        weixinRegistration = null;
        return { status: "expired", message: "扫码登录已过期，请重新开始" };
      }
      const result = await attempt.registration.poll({ qrCode: attempt.qrCode });
      if (weixinRegistration !== attempt) return { status: "idle" };
      if (Date.now() >= attempt.expiresAt) {
        weixinRegistration = null;
        return { status: "expired", message: "扫码登录已过期，请重新开始" };
      }
      if (result.status === "success") {
        const saved = await saveChannelCredentials("weixin", { weixinBotToken: result.botToken, weixinBotId: result.botId }, () => weixinRegistration === attempt);
        if (!saved) return { status: "idle" };
        weixinRegistration = null;
        store.audit({ event: "weixin-registration-success" });
        await refreshSettings();
        if (getSettings().channel !== CHANNEL_KIND_WEIXIN) {
          store.clearPairingCode();
          await pi.plugin.setSettings({ channel: CHANNEL_KIND_WEIXIN });
          await refreshSettings();
        }
        return { status: "success", state: panelState() };
      }
      if (!["pending", "scanned"].includes(result.status)) weixinRegistration = null;
      return result;
    }
    case "cancelWeixinRegistration":
      weixinRegistration = null;
      store.audit({ event: "weixin-registration-cancelled" });
      return { status: "cancelled" };
    default:
      throw new Error(`unhandled panel action: ${action}`);
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
