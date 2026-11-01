"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  REMOTE_TAG_PREFIX,
  IPC_EVENTS,
  DANGEROUS_COMMANDS,
  ATTACHMENT_ONLY_PROMPT,
} = require("./constants.cjs");
const { redactSecrets, truncate } = require("./security.cjs");
const { projectPath, pathKey, isProjectAllowed, listProjects } = require("./project-access.cjs");
const { replyModeFor } = require("./reply-mode.cjs");
const { createBotCommands, canonicalCommand } = require("./bot-commands.cjs");
const { resolveSendFile } = require("./file-access.cjs");
const { formatToolSummary } = require("./tool-summary.cjs");
const { createPhoneQuestions } = require("./phone-questions.cjs");
const { stagePromptAttachments } = require("./prompt-attachments.cjs");
const { createRemoteSchedule } = require("./remote-schedule.cjs");
const { readTurnMessages } = require("./session-reply.cjs");
const {
  chunkText,
  readSessionStatus,
  formatChoicePrompt,
  formatSessionList,
  formatSessionStatus,
  formatHelp,
} = require("./render.cjs");

/**
 * 桥接核心：把远程聊天消息翻译成宿主 desktop.control 调用，
 * 并把 Agent 事件流整形回推到手机。
 *
 * 所有宿主调用都走 pi.desktop.invoke；危险操作（risk=dangerous）必须显式 confirm。
 */

const PLAN_POLL_INTERVAL_MS = 5000;
const EXTENSION_END_WAIT_MS = 3000;
const MAX_PROMPT_CHARS = 65536; // 与宿主协作 API 上限一致
const HARD_RETRY_CHARS = 1800;

/**
 * 单条消息默认分片长度。iLink 的回复令牌几分钟就失效，
 * 分片越多越容易跨过失效点，所以单片尽量长（中文 1200 字约 3.6KB，留足余量）。
 */
const CHUNK_CHARS_DEFAULT = 1200;
/** 丢弃平台重复推送的记忆窗口大小（飞书/钉钉可能重推同一 messageId）。 */
const MAX_RECENT_MESSAGE_IDS = 500;

function remoteTag(channelKind) {
  return `${REMOTE_TAG_PREFIX}${channelKind}]`;
}

function createBridge({ store, getSettings, getChannel, setReplyMode, log, audit, channelKind, executionLocks = new Map(), now = Date.now }) {
  const busySessions = new Set();
  /** sessionId -> { queueKey, chatId, text, flushed, startedAt, turn } */
  const turnBuffers = new Map();
  const extensionRuns = new Map();
  const completedExtensionRuns = new Set();
  /** chatId -> [{ prompt, sessionId }] */
  const queues = new Map();
  /** chatId -> [{ text }] 通道暂不可达时的待发箱 */
  const outboxes = new Map();
  /** proposalId -> { chatId, sessionId, turnId, toolCallId, title, version } */
  const pendingApprovals = new Map();
  const notifiedApprovals = new Set();
  /** `${channel}:${messageId}` -> 最近处理时间；丢弃飞书/钉钉对同一消息的重复推送。 */
  const recentMessageIds = new Map();
  let planPollTimer = null;
  let disposed = false;
  const phoneQuestions = createPhoneQuestions({ sendChoice, send, now,
    isAuthorized: request => {
      const buffer = turnBuffers.get(request.sessionId);
      return buffer && !buffer.observed && buffer.extensionRunId === request.runId && authorizedTurn(buffer);
    },
  });
  const schedules = createRemoteSchedule({
    load: () => store.getSchedules().filter(task => !channelKind || task.channel === channelKind),
    save: tasks => store.saveSchedules(channelKind ? [...store.getSchedules().filter(task => task.channel !== channelKind), ...tasks] : tasks), now,
    onError: (error, task) => audit({ event: "schedule-failed", taskId: task?.id, error: redactSecrets(error.message) }),
    dispatch: async task => {
      const binding = store.getBinding(task.channel, task.chatId);
      const scheduled = store.getSchedules().find(item => item.id === task.id);
      const valid = () => !disposed && getChannel()?.kind === task.channel &&
        scheduled?.enabled && store.getSchedules().find(item => item.id === task.id) === scheduled &&
        store.getBinding(task.channel, task.chatId) === binding && binding?.sessionId === task.sessionId &&
        binding.boundAt === task.boundAt && store.isPaired(task.channel, task.chatId) &&
        JSON.stringify(authorizationFor(task.channel, task.chatId)) === JSON.stringify(task.authorization);
      if (!valid()) throw new Error("定时任务的授权或会话关联已变化，请删除后重新创建");
      const status = await invoke("agent/getStatus", [task.sessionId], { channel: task.channel });
      if (!valid()) throw new Error("定时任务的授权或会话关联已变化");
      if (busySessions.has(task.sessionId) || ["running", "busy", "waiting_permission", "waiting_input", "waiting_approval", "compacting"].includes(readSessionStatus(status).state)) throw new Error("会话忙碌，本次定时任务跳过");
      const result = await dispatchPrompt(task.channel, task.chatId, task.prompt, { userId: task.userId, scheduleId: task.id, beforeDispatch: valid });
      if (!result?.accepted) throw new Error(redactSecrets(result?.error || "定时任务未被接受"));
      audit({ event: "schedule-dispatched", taskId: task.id, sessionId: task.sessionId, turnId: result.turnId });
    },
  });
  const commands = createBotCommands({
    store, getSettings, invoke, send, sendChoice, setReplyMode, showStatus, now, audit,
    isBusy: id => busySessions.has(id),
    hasApproval: chatId => [...pendingApprovals.values()].some(item => item.chatId === chatId),
    onSessionBound: sessionId => beginObservedTurn(sessionId, { onlyRunning: true }),
  });

  /** 通道支持流式卡片且设置未显式关闭时，用单卡就地回传。 */
  function useCardMode() {
    const channel = getChannel();
    if (!channel?.capabilities?.streamingCard || typeof channel.beginTurn !== "function") {
      return false;
    }
    return channel.kind === "feishu";
  }

  function chatIdOf(queueKey) {
    return String(queueKey).split(":").slice(1).join(":");
  }

  function settings() {
    return getSettings() ?? {};
  }

  function channelOf(chatId) {
    return getChannel();
  }


  const retrying = new Set();
  async function retryDelivery(kind, chatId) {
    const failed = store.getFailedDelivery(kind, chatId);
    const channel = getChannel();
    if (!failed) return { delivered: false, reason: "没有可重试的失败结果" };
    const key = `${kind}:${chatId}`;
    if (retrying.has(key)) return { delivered: false, reason: "正在重试，请稍候" };
    const valid = () => {
      const binding = store.getBinding(kind, chatId);
      const pairing = store.getPairings()[key];
      return getChannel() === channel && channel?.kind === kind && binding?.sessionId === failed.sessionId &&
        binding.boundAt === failed.boundAt && failed.pairedAt === (pairing?.pairedAt ?? null) &&
        failed.userId === (pairing?.userId ?? null) && (settings().requirePairing === false || pairing);
    };
    retrying.add(key);
    try {
      if (!valid()) throw new Error("原结果的授权或关联已变化，无法重试");
      await invoke("agent/getStatus", [failed.sessionId], { channel: kind });
      for (const chunk of chunkText(failed.text, HARD_RETRY_CHARS)) {
        if (!valid()) throw new Error("原结果的授权或关联已变化，无法重试");
        const result = await channel.sendText(chatId, chunk, failed.options);
        if (result?.delivered === false) return result;
      }
      if (store.getFailedDelivery(kind, chatId)?.id === failed.id) store.clearFailedDelivery(kind, chatId);
      outboxes.delete(chatId);
      return { delivered: true };
    } finally { retrying.delete(key); }
  }
  async function showStatus(kind, chatId, configuredSession, changeLabel) {
    const binding = store.getBinding(kind, chatId);
    if (!binding) { await send(chatId, "尚未绑定会话。发送 /新建 或 /会话 选择会话。"); return; }
    const status = await invoke("agent/getStatus", [binding.sessionId], { channel: kind });
    const detail = await invoke("session/get", [binding.sessionId], { channel: kind });
    if (!detail?.session) throw new Error("宿主未返回会话信息");
    let providers = [];
    try { providers = (await invoke("providers/list"))?.providers ?? []; }
    catch (error) { log("warn", "status model labels unavailable", { error: error.message }); }
    const buffer = turnBuffers.get(binding.sessionId);
    return send(chatId, formatSessionStatus(status, {
      session: { ...detail.session, ...configuredSession, id: binding.sessionId }, providers,
      draft: binding.draft === true && !buffer,
      busy: busySessions.has(binding.sessionId),
      elapsedMs: buffer ? Math.max(0, now() - buffer.startedAt) : undefined,
      progress: buffer?.progress,
    }) + (changeLabel && !changeLabel.startsWith("模型：") ? `\n${changeLabel}` : ""), { format: "status" });
  }

  async function send(chatId, text, options) {
    const channel = channelOf(chatId);
    if (!channel) {
      audit({ event: "send-skipped", chatId, reason: "channel-not-running" });
      return { delivered: false, reason: "channel-not-running" };
    }
    try {
      const result = await channel.sendText(chatId, text, options);
      if (result && result.delivered === false) {
        // 发送失败直接丢弃：补发必须等用户发新消息（新令牌）才可能成功，
        // 而那时已经在回答新问题，旧内容再插进来只会和答复叠在一起，让人看不懂。
        audit({ event: "send-dropped", chatId, reason: String(result.reason ?? "") });
        return result;
      }
      return { delivered: true };
    } catch (error) {
      log("error", "send failed", { chatId, error: String(error?.message ?? error) });
      audit({ event: "send-failed", chatId, error: String(error?.message ?? error) });
      return { delivered: false, reason: String(error?.message ?? error) };
    }
  }

  function pushOutbox(chatId, text, options) {
    const box = outboxes.get(chatId) ?? [];
    box.push({ text, options, at: now() });
    outboxes.set(chatId, box.slice(-10));
  }


  async function sendChunked(chatId, text, chunkChars, buffer) {
    const chunks = chunkText(truncate(redactSecrets(text), MAX_PROMPT_CHARS), chunkChars);
    for (let index = 0; index < chunks.length; index += 1) {
      if (buffer && !authorizedTurn(buffer)) {
        // 轮次已失效（用户中断/解绑）：剩下的内容既发不出去也不能悄悄丢掉，
        // 交回调用方留档，面板才能提供重试，否则用户只看到半截回复。
        return { delivered: false, reason: "authorization-changed", unsent: chunks.slice(index).join("\n\n") };
      }
      const result = await send(chatId, chunks[index]);
      if (result.delivered === false) {
        // 失败的那一片已由 send() 存入待发箱，这里只带出它之后还没发的内容。
        return { ...result, unsent: chunks.slice(index + 1).join("\n\n") };
      }
    }
    return { delivered: true };
  }

  // ---------- 宿主调用 ----------

  async function invoke(operation, args = [], options = {}) {
    const rawInvoke = (op, values = []) => {
      if (typeof pi === "undefined" || !pi.desktop?.invoke) throw new Error("宿主未提供 desktop.control 网关（pi.desktop.invoke）");
      return pi.desktop.invoke({ operation: op, args: values, ...(options.confirm ? { confirm: true } : {}) });
    };
    const policy = store.getProjectAccess(options.channel ?? getChannel()?.kind ?? settings().channel);
    if (policy.mode === "selected") {
      if (operation === "session/create") {
        const projects = await listProjects(rawInvoke);
        const current = args[0]?.projectPath ?? projectPath((await rawInvoke("project/get"))?.workspace);
        const target = projects.find(project => pathKey(project.path) === pathKey(current) && isProjectAllowed(policy, project.path))
          ?? (!args[0]?.projectPath ? projects.find(project => isProjectAllowed(policy, project.path)) : null);
        if (!target) throw new Error("没有可访问的项目，请在桌面更新机器人项目范围");
        args = [{ ...args[0], projectPath: target.path }];
      } else if (operation === "session/list") {
        const result = await rawInvoke(operation, args);
        const sessions = Array.isArray(result) ? result : result?.sessions;
        if (!Array.isArray(sessions)) throw new Error("宿主未返回会话列表");
        const allowed = sessions.filter(session => isProjectAllowed(policy, projectPath(session)));
        return Array.isArray(result) ? allowed : { ...result, sessions: allowed };
      } else if (operation === "project/set") {
        if (!isProjectAllowed(policy, args[0])) throw new Error("该项目不在机器人允许的范围内");
      } else if (operation === "workspace/diff") {
        const current = await rawInvoke("project/get");
        if (!isProjectAllowed(policy, projectPath(current?.workspace))) throw new Error("当前桌面项目不在机器人允许的范围内");
      } else {
        const sessionId = typeof args[0] === "string" ? args[0] : args[0]?.sessionId ?? args[0]?.id;
        if (sessionId) {
          const result = await rawInvoke("session/list");
          const sessions = Array.isArray(result) ? result : result?.sessions;
          const session = sessions?.find(item => (item.id ?? item.sessionId) === sessionId);
          if (!session || !isProjectAllowed(policy, projectPath(session))) throw new Error("该会话不在机器人允许的项目范围内，请用 /sessions 和 /use 重新选择");
        }
      }
    } else if (operation === "session/create" && !args[0]?.projectPath) {
      const current = projectPath((await rawInvoke("project/get"))?.workspace);
      if (current) args = [{ ...args[0], projectPath: current }];
    }
    if (options.guard && !options.guard()) throw new Error("聊天授权、项目范围或任务状态已变化");
    return rawInvoke(operation, args);
  }

  // ---------- 入站处理 ----------

  async function handleInbound(message) {
    if (disposed) return;
    const { chatId, channel, text } = message;
    if (channelKind && channel !== channelKind) return;
    if (!chatId) return;
    if (message.meta?.chatType === "group") {
      await send(chatId, "请在机器人私聊中发送绑定命令或任务。");
      audit({ event: "rejected-group", channel, chatId });
      return;
    }
    if (message.messageId) {
      const dedupKey = `${channel}:${chatId}:${message.messageId}`;
      if (recentMessageIds.has(dedupKey)) {
        audit({ event: "inbound-duplicate-ignored", channel, chatId, messageId: message.messageId });
        return;
      }
      recentMessageIds.set(dedupKey, now());
      if (recentMessageIds.size > MAX_RECENT_MESSAGE_IDS) {
        recentMessageIds.delete(recentMessageIds.keys().next().value);
      }
      try {
        await processInbound(message);
      } catch (error) {
        recentMessageIds.delete(dedupKey);
        throw error;
      }
      return;
    }
    await processInbound(message);
  }

  async function processInbound(message) {
    const { chatId, channel, text } = message;

    const config = settings();
    const paired = store.isPaired(channel, chatId);
    const actor = store.getPairings()[`${channel}:${chatId}`]?.userId;
    if (paired && actor && actor !== message.userId) {
      audit({ event: "rejected-actor", channel, chatId });
      return;
    }

    // 未绑定：只接受 /bind。
    if (!paired && config.requirePairing !== false) {
      const pairMatch = /^\/bind\s+(\S+)/.exec(text.trim());
      if (pairMatch) {
        await pairChat(channel, chatId, pairMatch[1], message.userId);
        return;
      }
      await send(
        chatId,
        "该聊天尚未绑定。请在桌面端「Pi-Desktop 机器人」面板生成绑定命令，然后发送：/bind <绑定码>",
      );
      audit({ event: "rejected-unpaired", channel, chatId, text: redactSecrets(text).slice(0, 120) });
      return;
    }

    // 失败结果仅由显式重试发送，避免一条新消息触发未知结果的重复投递。
    if (await phoneQuestions.answer(channel, chatId, text.trim())) return;

    // 待处理审批优先：序号即批准/拒绝
    if ([...pendingApprovals.values()].some(item => item.chatId === chatId)) {
      const numeric = /^\s*([12])\s*$/.exec(text);
      if (numeric) {
        await resolveApprovalBySelection(chatId, numeric[1]);
        return;
      }
    }
    if (await commands.consumeText(channel, chatId, text)) return;

    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      await handleCommand(channel, chatId, trimmed, message);
      return;
    }

    await dispatchPrompt(channel, chatId, trimmed, message);
  }

  async function pairChat(channel, chatId, code, userId) {
    const stored = store.getPairingCode();
    const { verifyPairingCode } = require("./security.cjs");
    const result = verifyPairingCode(stored, code);
    if (!result.ok) {
      await send(chatId, `配对失败：${result.reason}`);
      audit({ event: "pair-failed", channel, chatId });
      return;
    }
    store.pair(channel, chatId, { userId });
    store.clearPairingCode();
    await send(
      chatId,
      ["绑定成功。发送 /帮助 查看可用命令。", formatHelp(settings())].join("\n\n"),
      { format: "command-guide" },
    );
    audit({ event: "paired", channel, chatId });
  }

  async function handleCommand(channel, chatId, line, message) {
    const [rawCommand, ...rest] = line.split(/\s+/);
    const command = canonicalCommand(rawCommand);
    const argument = rest.join(" ").trim();
    if (rawCommand === "/取消") { await send(chatId, "当前没有待选择的菜单。"); return; }
    if (await commands.handle(channel, chatId, command, argument)) return;
    if (["/new", "/clear", "/新建", "/unbind", "/cancel"].includes(command)) commands.clear(channel, chatId);

    switch (command) {
      case "/help":
      case "/帮助":
        await send(chatId, formatHelp(settings(), ["更多", "more"].includes(argument.toLowerCase())), { format: "command-guide" });
        return;
      case "/bind":
        await pairChat(channel, chatId, rest[0] ?? "", message.userId);
        return;
      case "/新建":
      case "/clear":
      case "/new": {
        const title = argument || "草稿";
        try {
          const result = await invoke("session/create", [{ title, mode: "agent" }]);
          const sessionId = result?.session?.id ?? result?.sessionId ?? result?.id;
          if (!sessionId) throw new Error("宿主未返回会话 ID");
          store.setBinding(channel, chatId, sessionId, { draft: true });
          await showStatus(channel, chatId);
          audit({ event: "session-created", channel, chatId, sessionId });
        } catch (error) {
          await send(chatId, `创建会话失败：${error.message}`);
        }
        return;
      }
      case "/sessions": {
        try {
          const result = await invoke("session/list", []);
          const sessions = Array.isArray(result) ? result : result?.sessions ?? [];
          await sendChunked(chatId, formatSessionList(sessions), settings().resultChunkChars);
        } catch (error) {
          await send(chatId, `读取会话列表失败：${error.message}`);
        }
        return;
      }
      case "/unbind":
        store.clearBinding(channel, chatId);
        await send(chatId, "已解除绑定。下一条指令将按设置自动创建新会话。");
        return;
      case "/状态":
      case "/status": {
        try { await showStatus(channel, chatId); }
        catch (error) { await send(chatId, `读取状态失败：${error.message}`); }
        return;
      }
      case "/cancel": {
        const binding = store.getBinding(channel, chatId);
        if (!binding) {
          await send(chatId, "尚未绑定会话。");
          return;
        }
        const buffer = turnBuffers.get(binding.sessionId);
        if (buffer) buffer.cancelRequested = true;
        try {
          await invoke("agent/abort", [{ sessionId: binding.sessionId }]);
          queues.delete(`${channel}:${chatId}`);
          await send(chatId, "已发送中断请求。");
          audit({ event: "aborted", channel, chatId, sessionId: binding.sessionId });
        } catch (error) {
          if (turnBuffers.get(binding.sessionId) === buffer && buffer) buffer.cancelRequested = false;
          await send(chatId, `中断失败：${error.message}`);
        }
        return;
      }
      case "/diff": {
        try {
          const diff = await invoke("workspace/diff", []);
          const text = typeof diff === "string" ? diff : JSON.stringify(diff ?? {}, null, 2);
          await sendChunked(chatId, text || "工作区没有改动。", settings().resultChunkChars);
        } catch (error) {
          await send(chatId, `读取 diff 失败：${error.message}`);
        }
        return;
      }
      case "/重试":
      case "/retry":
        try {
          const result = await retryDelivery(channel, chatId);
          if (result?.delivered === false) await send(chatId, result.reason, { retryable: false });
        } catch (error) { await send(chatId, `重试失败：${error.message}`, { retryable: false }); }
        return;
      case "/定时":
      case "/cron": {
        const binding = store.getBinding(channel, chatId);
        try {
          if (/^(每隔|每天)\s/.test(argument) && binding) await invoke("agent/getStatus", [binding.sessionId], { channel });
          const result = await schedules.command({ channel, chatId, userId: message.userId, sessionId: binding?.sessionId,
            authorization: authorizationFor(channel, chatId), boundAt: binding?.boundAt, text: argument });
          await sendChunked(chatId, result, HARD_RETRY_CHARS);
        } catch (error) { await send(chatId, `定时任务操作失败：${error.message}`); }
        return;
      }
      case "/send": {
        if (!argument) {
          await send(chatId, "用法：/send <本机绝对路径>");
          return;
        }
        const binding = store.getBinding(channel, chatId);
        if (!binding) {
          await send(chatId, "尚未绑定会话，无法确定发送目标。");
          return;
        }
        try {
          const channelAdapter = channelOf(chatId);
          const authorization = authorizationFor(channel, chatId);
          const file = await fileForSession(channel, binding.sessionId, argument);
          if (getChannel() !== channelAdapter || store.getBinding(channel, chatId) !== binding ||
              JSON.stringify(authorizationFor(channel, chatId)) !== JSON.stringify(authorization)) throw new Error("聊天授权或关联已变化");
          const info = await channelAdapter.uploadMedia(chatId, file);
          await send(chatId, `文件已发送：${info?.name ?? argument}`);
          audit({ event: "file-sent", channel, chatId, path: argument });
        } catch (error) {
          await send(chatId, `发送文件失败：${error.message}`);
        }
        return;
      }
      default:
        await send(chatId, `未知指令 ${command}。发送 /help 查看可用指令。`);
    }
  }


  // ---------- 指令派发与会话队列 ----------

  async function dispatchPrompt(channel, chatId, text, message) {
    const config = settings();
    if (text.length > MAX_PROMPT_CHARS) {
      await send(chatId, `指令过长（${text.length} 字，上限 ${MAX_PROMPT_CHARS}）。`);
      return;
    }

    let binding = store.getBinding(channel, chatId);
    if (!binding) {
      if (config.autoCreateSession === false) {
        await send(chatId, "尚未绑定会话。用 /new 创建或用 /use 绑定。");
        return;
      }
      try {
        const title = `远程会话 ${new Date(now()).toLocaleString("zh-CN")}`;
        const result = await invoke("session/create", [{ title, mode: "agent" }]);
        const sessionId = result?.session?.id ?? result?.sessionId ?? result?.id;
        if (!sessionId) throw new Error("宿主未返回会话 ID");
        store.setBinding(channel, chatId, sessionId);
        binding = store.getBinding(channel, chatId);
        audit({ event: "session-auto-created", channel, chatId, sessionId });
      } catch (error) {
        await send(chatId, `自动创建会话失败：${error.message}`);
        return;
      }
    }

    const queueKey = `${channel}:${chatId}`;
    const queue = queues.get(queueKey) ?? [];
    const maxQueue = Math.max(1, Number(config.maxQueuePerChat) || 3);
    if (queue.length >= maxQueue) {
      await send(chatId, `排队已满（${maxQueue} 条）。请等待当前任务完成，或用 /cancel 中断。`);
      return;
    }

    const attachments = message?.attachments ?? (message?.images ?? []).map(path => ({ path, kind: "image" }));
    const effectiveText = text || (attachments.length > 0 ? ATTACHMENT_ONLY_PROMPT : "");
    const content = `${remoteTag(channel)} ${effectiveText}`;
    queue.push({ content, attachments, sessionId: binding.sessionId, messageId: message?.messageId ?? "",
      boundAt: binding.boundAt, authorization: authorizationFor(channel, chatId) });
    queue[queue.length - 1].scheduleId = message?.scheduleId;
    queue[queue.length - 1].beforeDispatch = message?.beforeDispatch;
    queues.set(queueKey, queue);
    audit({ event: "prompt-queued", channel, chatId, sessionId: binding.sessionId, chars: content.length });

    if (!busySessions.has(binding.sessionId)) {
      return drainQueue(queueKey);
    } else {
      await send(chatId, "会话正在执行，指令已排队。");
    }
  }

  async function drainQueue(queueKey) {
    const queue = queues.get(queueKey) ?? [];
    const item = queue[0];
    if (!item) return;
    if (busySessions.has(item.sessionId)) return;
    if (executionLocks.has(item.sessionId)) {
      queue.shift();
      await send(chatIdOf(queueKey), "会话正在其他渠道执行，请等待完成后再发送任务。");
      return { accepted: false, error: "会话正在其他渠道执行" };
    }
    busySessions.add(item.sessionId);
    turnBuffers.set(item.sessionId, {
      authorization: item.authorization,
      boundAt: item.boundAt,
      queueKey,
      item,
      messageId: randomUUID(),
      dispatching: true,
      pendingHostEnds: new Map(),
      chatId: chatIdOf(queueKey),
      text: "",
      flushed: 0,
      startedAt: now(),
      turn: null,
      mode: replyModeFor(settings(), channelOf(chatIdOf(queueKey))?.kind),
      finalText: "",
      changes: new Map(),
      tools: new Map(),
    });
    const buffer = turnBuffers.get(item.sessionId);
    executionLocks.set(item.sessionId, buffer);
    saveTurn(buffer);
    try {
      if (buffer && useCardMode()) {
        buffer.turn =
          channelOf(buffer.chatId)?.beginTurn({ chatId: buffer.chatId, messageId: item.messageId }) ?? null;
      }
      const attachments = await stagePromptAttachments(item.attachments ?? [], item.sessionId, invoke);
      if (!authorizedTurn(buffer)) throw new Error("聊天授权或关联已变化");
      buffer.dispatchResult = invoke("agent/prompt", [{ sessionId: item.sessionId, content: item.content, messageId: buffer.messageId, ...(attachments.length ? { attachments } : {}) }],
        { guard: () => turnBuffers.get(item.sessionId) === buffer && authorizedTurn(buffer) && (!item.beforeDispatch || item.beforeDispatch()) });
      store.updateBinding(buffer.queueKey.split(":")[0], buffer.chatId, { draft: false });
      const result = await buffer.dispatchResult;
      if (turnBuffers.get(item.sessionId) !== buffer) return { accepted: true, turnId: result?.turnId };
      buffer.dispatching = false;
      buffer.hostTurnId = typeof result?.turnId === "string" ? result.turnId : "";
      saveTurn(buffer);
      const ended = buffer.pendingHostEnds.get(buffer.hostTurnId);
      buffer.pendingHostEnds.clear();
      if (ended) await handleHostTurnEnded(ended);
      else if (!buffer.hostTurnId && buffer.extensionEnd) await handleAgentEvent(buffer.extensionEnd);
      if (turnBuffers.get(item.sessionId) !== buffer) return { accepted: true, turnId: result?.turnId };
      if (buffer && !buffer.turn && buffer.mode !== "summary") {
        // 文本回落通道：开一个"正在输入"提示（Telegram/微信），失败只记日志不影响任务。
        try {
          await channelOf(buffer.chatId)?.sendTyping?.(buffer.chatId);
        } catch (error) {
          log("warn", "sendTyping failed", {
            chatId: buffer.chatId,
            error: String(error?.message ?? error),
          });
        }
      }
      audit({ event: "prompt-dispatched", sessionId: item.sessionId });
      return { accepted: true, turnId: buffer.hostTurnId };
    } catch (error) {
      busySessions.delete(item.sessionId);
      turnBuffers.delete(item.sessionId);
      if (executionLocks.get(item.sessionId) === buffer) executionLocks.delete(item.sessionId);
      store.removePendingTurn(item.sessionId, channelKind);
      if (buffer?.turn) {
        try { await buffer.turn.end("error"); }
        catch (endError) { log("warn", "failed turn could not close", { sessionId: item.sessionId, error: endError.message }); }
      }
      queue.shift();
      await send(chatIdOf(queueKey), `派发失败：${error.message}`);
      audit({ event: "prompt-failed", sessionId: item.sessionId, error: error.message });
      return { accepted: false, error: error.message };
    }
  }

  // ---------- Agent 事件 ----------

  async function beginObservedTurn(sessionId, event = {}) {
    if (disposed || turnBuffers.has(sessionId)) return turnBuffers.get(sessionId);
    const channel = getChannel();
    const kind = channel?.kind;
    const binding = store.listBindings().find(item => item.sessionId === sessionId && item.key.startsWith(`${kind}:`));
    if (!binding) return null;
    const chatId = chatIdOf(binding.key);
    if (settings().requirePairing !== false && !store.isPaired(kind, chatId)) return null;
    const authorization = authorizationFor(kind, chatId);
    const projectPolicy = JSON.stringify(store.getProjectAccess(kind));
    const status = await invoke("agent/getStatus", [sessionId], { channel: kind });
    if (event.onlyRunning && !["running", "busy", "compacting", "waiting_approval", "waiting_permission", "waiting_input"].includes(readSessionStatus(status).state)) return null;
    if (disposed || getChannel() !== channel || store.getBinding(kind, chatId)?.boundAt !== binding.boundAt ||
        JSON.stringify(authorizationFor(kind, chatId)) !== JSON.stringify(authorization) ||
        JSON.stringify(store.getProjectAccess(kind)) !== projectPolicy) return null;
    if (turnBuffers.has(sessionId)) return turnBuffers.get(sessionId);
    const buffer = {
      observed: true, queueKey: binding.key, chatId, item: { sessionId, messageId: "" },
      authorization, projectPolicy, boundAt: binding.boundAt,
      messageId: executionLocks.get(sessionId)?.messageId ?? "", hostTurnId: event.turnId ?? status?.status?.currentTurnId ?? status?.currentTurnId ?? "", dispatching: false,
      extensionRunId: extensionRuns.get(sessionId) ?? "",
      pendingHostEnds: new Map(), startedAt: now(), text: "", flushed: 0, finalText: "",
      mode: replyModeFor(settings(), kind), changes: new Map(), tools: new Map(), turn: null,
    };
    busySessions.add(sessionId);
    turnBuffers.set(sessionId, buffer);
    store.updateBinding(kind, chatId, { draft: false });
    if (useCardMode()) buffer.turn = getChannel().beginTurn({ chatId });
    saveTurn(buffer);
    return buffer;
  }

  async function handleHostTurnEnded(event) {
    if (disposed || !event?.sessionId || !event.turnId) return;
    const buffer = turnBuffers.get(event.sessionId);
    if (!buffer || buffer.ending) return;
    if (buffer.observed && !buffer.hostTurnId) buffer.hostTurnId = event.turnId;
    if (buffer.dispatching) {
      buffer.pendingHostEnds.set(event.turnId, event);
      return;
    }
    if (buffer.hostTurnId !== event.turnId) return;
    buffer.ending = true;
    buffer.terminalEvent = event;
    saveTurn(buffer);
    audit({ event: "host-turn-ended", sessionId: event.sessionId, turnId: event.turnId, reason: event.reason, extensionEvents: Boolean(buffer.extensionRunId) });
    let finalText = buffer.finalText;
    let snapshotText = "";
    let error = event.reason === "aborted" ? "任务已中断" : event.reason === "error" ? "任务执行失败" : "";
    let replyError = "";
    try {
      const current = await readTurnMessages(invoke, event.sessionId, event.turnId, buffer.messageId);
      if (!authorizedTurn(buffer) || turnBuffers.get(event.sessionId) !== buffer) {
        await discardTurn(event.sessionId, buffer);
        return;
      }
      if (!buffer.extensionRunId && !buffer.text && buffer.mode !== "summary") {
        for (const message of current) {
          if (message.parentToolCallId || message.agentName) continue;
          if (message.role === "assistant" && message.content) {
            const text = `${buffer.text ? "\n\n" : ""}${message.content}`;
            buffer.text += text;
            buffer.turn?.appendText(text);
          } else if (message.role === "tool" && buffer.turn) {
            buffer.turn.appendTool(formatToolSummary({ toolName: message.toolName, args: message.toolArgs,
              phase: "end", isError: message.toolStatus === "error" || message.isError }), message.toolCallId);
          }
        }
      }
      const final = current.filter(message => message.role === "assistant" && !message.parentToolCallId && !message.agentName).at(-1);
      if (typeof final?.content === "string") snapshotText = final.content;
      if (error && typeof final?.error?.message === "string") error = final.error.message;
    } catch (cause) {
      log("warn", "completed reply snapshot failed", { sessionId: event.sessionId, turnId: event.turnId, error: cause.message });
      if (!finalText) replyError = `无法读取本轮回复：${cause.message}`;
    }
    finalText ||= buffer.finalText;
    if (buffer.extensionRunId && !buffer.extensionEnd) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, EXTENSION_END_WAIT_MS);
        buffer.resolveExtensionEnd = () => { clearTimeout(timer); resolve(); };
      });
      delete buffer.resolveExtensionEnd;
      finalText ||= buffer.finalText;
    }
    finalText = buffer.finalText || finalText || snapshotText;
    if (finalText) replyError = "";
    if (disposed || turnBuffers.get(event.sessionId) !== buffer) return;
    await handleAgentEvent({ type: IPC_EVENTS.agentEnd, sessionId: event.sessionId, source: "host", finalText, error, replyError });
  }

  let checkingTurns = false;
  async function pollTurns() {
    if (checkingTurns || disposed) return;
    checkingTurns = true;
    try {
      for (const [sessionId, buffer] of turnBuffers) {
        if (buffer.dispatching || buffer.ending || !buffer.hostTurnId || !authorizedTurn(buffer)) continue;
        try {
          const status = await invoke("agent/getStatus", [sessionId]);
          if (!["idle", "completed", "stopped", "error", "failed"].includes(readSessionStatus(status).state)) continue;
          const messages = await readTurnMessages(invoke, sessionId, buffer.hostTurnId, buffer.messageId);
          const final = messages.filter(m => m.role === "assistant" && !m.parentToolCallId && !m.agentName).at(-1);
          if (!["complete", "completed", "error", "aborted"].includes(final?.status)) continue;
          await handleHostTurnEnded({ sessionId, turnId: buffer.hostTurnId,
            reason: final.status === "aborted" ? "aborted" : final.isError || final.error || final.status === "error" ? "error" : "completed" });
        } catch (error) { log("warn", "turn completion poll failed", { sessionId, error: redactSecrets(error.message) }); }
      }
    } finally { checkingTurns = false; }
  }

  async function handleAgentEvent(event) {
    if (disposed || !event?.type) return;
    if (event.type === IPC_EVENTS.agentStart && event.runId && completedExtensionRuns.has(event.runId)) return;
    if (event.type === IPC_EVENTS.agentStart && event.runId) {
      extensionRuns.delete(String(event.sessionId ?? ""));
      extensionRuns.set(String(event.sessionId ?? ""), event.runId);
      if (extensionRuns.size > MAX_RECENT_MESSAGE_IDS) extensionRuns.delete(extensionRuns.keys().next().value);
    }
    if (event.type === IPC_EVENTS.agentEnd && extensionRuns.get(String(event.sessionId ?? "")) === event.runId) {
      extensionRuns.delete(String(event.sessionId ?? ""));
    }
    if (event.type === IPC_EVENTS.agentStart && !turnBuffers.has(String(event.sessionId ?? ""))) {
      await beginObservedTurn(String(event.sessionId ?? ""), event);
    }
    const active = turnBuffers.get(String(event.sessionId ?? ""));
    if (active && !authorizedTurn(active)) {
      await discardTurn(String(event.sessionId), active);
      return { state: "expired", success: false, error: "聊天授权或关联已变化" };
    }
    if (event.type === IPC_EVENTS.phoneQuestionPoll) return phoneQuestions.poll(event);
    if (event.type === IPC_EVENTS.phoneQuestionCancel) return phoneQuestions.cancel(event);
    if (event.type === IPC_EVENTS.phoneQuestion) {
      if (!active || active.observed || !event.runId || active.extensionRunId !== event.runId) throw new Error("只有手机发起的当前任务可以提问");
      return phoneQuestions.request(event, { channel: active.queueKey.split(":")[0], chatId: active.chatId });
    }
    if (event.runId && event.type !== IPC_EVENTS.sendFile) {
      if (completedExtensionRuns.has(event.runId)) return;
      if (event.type !== IPC_EVENTS.agentStart && active?.extensionRunId !== event.runId) return;
    }
    if (active?.ending && event.source !== "host") {
      if (event.type === IPC_EVENTS.agentEnd && event.runId && event.runId === active.extensionRunId) {
        active.extensionEnd = event;
        if (typeof event.finalText === "string" && event.finalText.trim()) active.finalText = event.finalText;
        active.resolveExtensionEnd?.();
      }
      return;
    }
    switch (event.type) {
      case IPC_EVENTS.agentStart: {
        const sessionId = String(event.sessionId ?? "");
        if (sessionId && active) {
          busySessions.add(sessionId);
          active.extensionRunId = event.runId ?? "";
          audit({ event: "extension-turn-started", sessionId, runId: event.runId ?? "" });
        }
        return;
      }
      case IPC_EVENTS.assistantChunk: {
        const sessionId = String(event.sessionId ?? "");
        const buffer = turnBuffers.get(sessionId);
        if (!buffer) return;
        const content = String(event.content ?? "");
        if (content.trim()) buffer.progress = truncate(redactSecrets(content), 240);
        if (event.stopReason && event.stopReason !== "toolUse") buffer.finalText = content;
        if (buffer.mode === "summary") return;
        buffer.text += content;
        if (buffer.turn) {
          // 卡片模式：增量并入当前卡，写卡节流与失败恢复由通道负责。
          buffer.turn.appendText(content);
          return;
        }
        const config = settings();
        const limit = Math.max(80, Number(config.resultChunkChars) || CHUNK_CHARS_DEFAULT);
        if (buffer.text.length - buffer.flushed >= limit) {
          const pending = buffer.text.slice(buffer.flushed);
          buffer.flushed = buffer.text.length;
          // 没发完的部分直接丢弃（不补发）：过期内容重发只会和后续答复混在一起。
          await sendChunked(buffer.chatId, pending, limit, buffer);
        }
        return;
      }
      case IPC_EVENTS.assistantMessage: {
        const buffer = turnBuffers.get(String(event.sessionId ?? ""));
        if (buffer && event.stopReason !== "toolUse") buffer.finalText = String(event.content ?? "");
        return;
      }
      case IPC_EVENTS.toolProgress: {
        const buffer = turnBuffers.get(String(event.sessionId ?? ""));
        if (!buffer) return;
        const summary = event.args ? formatToolSummary(event, buffer.projectPath) : truncate(String(event.summary ?? event.toolName ?? "工具调用"), 240);
        buffer.progress = redactSecrets(summary);
        if (!buffer.turn && buffer.mode !== "full") return;
        const key = String(event.toolCallId ?? event.toolName ?? "tool");
        const previous = buffer.tools.get(key);
        if (previous?.summary === summary) return;
        if (event.phase === "update" && previous && now() - previous.at < 1000) return;
        buffer.tools.set(key, { summary, at: now() });
        if (buffer.turn) buffer.turn.appendTool(summary, event.toolCallId);
        else {
          const pending = buffer.text.slice(buffer.flushed);
          if (pending.trim()) {
            buffer.flushed = buffer.text.length;
            // 未发出的正文同样丢弃，不补发。
            await sendChunked(buffer.chatId, pending, Math.max(80, Number(settings().resultChunkChars) || CHUNK_CHARS_DEFAULT), buffer);
          }
          await send(buffer.chatId, summary);
        }
        return;
      }
      case IPC_EVENTS.fileChange: {
        const buffer = turnBuffers.get(String(event.sessionId ?? ""));
        if (!buffer || event.isError || !event.path) return;
        let operation = String(event.operation ?? "修改");
        if ([event.addedLines, event.removedLines].every(value => Number.isSafeInteger(value) && value >= 0)) {
          if (!event.addedLines && !event.removedLines) { buffer.changes.delete(String(event.path)); return; }
          operation += ` (+${event.addedLines}/-${event.removedLines})`;
        }
        buffer.changes.set(String(event.path), operation);
        return;
      }
      case IPC_EVENTS.agentEnd: {
        const sessionId = String(event.sessionId ?? "");
        const buffer = turnBuffers.get(sessionId);
        if (!buffer) return;
        if (event.source !== "host" && (buffer.dispatching || buffer.hostTurnId)) {
          buffer.extensionEnd = event;
          if (typeof event.finalText === "string" && event.finalText.trim()) buffer.finalText = event.finalText;
          return;
        }
        buffer.ending = true;
        if (buffer.extensionRunId) {
          completedExtensionRuns.add(buffer.extensionRunId);
          if (completedExtensionRuns.size > MAX_RECENT_MESSAGE_IDS) completedExtensionRuns.delete(completedExtensionRuns.values().next().value);
        }
        try {
          const changes = [...buffer.changes].map(([path, operation]) => `${operation}：${path}`);
          const visibleChanges = buffer.mode === "summary" ? changes.slice(0, 10) : changes;
          const changeText = changes.length
            ? [`文件变更${buffer.mode === "summary" ? "摘要" : ""}：${changes.length} 个文件`, ...visibleChanges,
              ...(visibleChanges.length < changes.length ? [`另有 ${changes.length - visibleChanges.length} 个文件`] : [])].join("\n") : "";
          const finalText = typeof event.finalText === "string" && event.finalText.trim() ? event.finalText : buffer.finalText;
          if (finalText && !buffer.text.endsWith(finalText)) {
            const extra = finalText.startsWith(buffer.text) ? finalText.slice(buffer.text.length) : `${buffer.text ? "\n\n" : ""}${finalText}`;
            buffer.text += extra;
            buffer.turn?.appendText(extra);
          }
          if (buffer.turn) {
            const footerText = [
              !finalText && !event.error && !event.replyError ? "本轮已结束，未产生最终回复。" : "",
              event.error ? `执行未完成：${event.error}` : "",
              event.replyError ? `回复同步失败：${event.replyError}` : "", changeText,
            ].filter(Boolean).join("\n\n");
            if (footerText) buffer.turn.appendText(`\n\n${footerText}`);
            await buffer.turn.end(event.error ? "error" : "completed", { finalText, footerText });
          } else {
            const pending = buffer.mode === "summary" ? finalText : buffer.text.slice(buffer.flushed);
            const errorText = event.error ? `执行未完成：${event.error}` : "";
            const replyErrorText = event.replyError ? `回复同步失败：${event.replyError}` : "";
            const output = [pending, errorText, replyErrorText, changeText].filter(text => text.trim()).join("\n\n")
              || (!buffer.text ? "本轮已结束，未产生最终回复。" : "");
            if (output) await sendChunked(buffer.chatId, output, Math.max(80, Number(settings().resultChunkChars) || CHUNK_CHARS_DEFAULT), buffer);
          }
          // 发送失败不在这里留档：补发只能等新消息带来新令牌，而那已经在答新问题，
          // 旧的半截内容再插进来只会和答复混在一起，所以直接丢弃。
          const kind = buffer.queueKey.split(":")[0];
          if (store.getBinding(kind, buffer.chatId)?.sessionId === sessionId && buffer.hostTurnId) {
            store.updateBinding(kind, buffer.chatId, { lastDeliveredTurnId: buffer.hostTurnId });
          }
          audit({ event: "turn-completed", sessionId, turnId: buffer.hostTurnId ?? "", scheduleId: buffer.item.scheduleId, source: event.source ?? "extension", error: event.error || "", replyError: event.replyError || "" });
          if (turnBuffers.get(sessionId) === buffer) store.removePendingTurn(sessionId, channelKind);
        } finally {
          if (turnBuffers.get(sessionId) === buffer) {
            turnBuffers.delete(sessionId);
            busySessions.delete(sessionId);
            if (executionLocks.get(sessionId) === buffer) executionLocks.delete(sessionId);
            if (buffer.cancelRequested) queues.delete(buffer.queueKey);
            for (const [key, queue] of queues.entries()) {
              if (key === buffer.queueKey && queue[0] === buffer.item) queue.shift();
              if (queue[0]?.sessionId === sessionId) await drainQueue(key);
            }
          }
        }
        return;
      }
      case IPC_EVENTS.sendFile: {
        const filePath = String(event.filePath ?? "");
        const location = active ? { channel: active.queueKey.split(":")[0], chatId: active.chatId } : null;
        if (!location || !active || active.observed || !event.runId || active.extensionRunId !== event.runId) {
          return { success: false, error: "没有当前手机任务的发送目标" };
        }
        try {
          const file = await fileForSession(location.channel, event.sessionId, filePath);
          if (!authorizedTurn(active)) throw new Error("聊天授权或关联已变化");
          const info = await channelOf(location.chatId).uploadMedia(location.chatId, file, event.displayName);
          await send(location.chatId, `文件已发送：${info?.name ?? filePath}`);
          audit({ event: "file-sent", channel: location.channel, chatId: location.chatId, path: filePath });
          return { success: true, name: info?.name ?? path.basename(file) };
        } catch (error) {
          await send(location.chatId, `文件发送失败：${error.message}`);
          return { success: false, error: redactSecrets(error.message) };
        }
        return;
      }
      case IPC_EVENTS.askBlocked: {
        audit({ event: "ask-blocked", sessionId: event.sessionId });
        return;
      }
      default:
        return;
    }
  }

  async function fileForSession(kind, sessionId, input) {
    const detail = await invoke("session/get", [sessionId], { channel: kind });
    return resolveSendFile(input, { projectPath: projectPath(detail?.session), policy: store.getProjectAccess(kind) });
  }

  function authorizationFor(kind, chatId) {
    const pairing = store.getPairings()[`${kind}:${chatId}`];
    return { pairedAt: pairing?.pairedAt ?? null, userId: pairing?.userId ?? null };
  }

  async function discardTurn(sessionId, buffer) {
    if (turnBuffers.get(sessionId) !== buffer) return;
    turnBuffers.delete(sessionId);
    busySessions.delete(sessionId);
    queues.delete(buffer.queueKey);
    if (executionLocks.get(sessionId) === buffer) executionLocks.delete(sessionId);
    store.removePendingTurn(sessionId, channelKind);
    await buffer.turn?.pause?.();
  }

  function authorizedTurn(buffer) {
    const kind = buffer.queueKey.split(":")[0];
    const binding = store.getBinding(kind, buffer.chatId);
    const authorization = authorizationFor(kind, buffer.chatId);
    return getChannel()?.kind === kind && binding?.sessionId === buffer.item.sessionId &&
      binding.boundAt === buffer.boundAt &&
      (!buffer.projectPolicy || buffer.projectPolicy === JSON.stringify(store.getProjectAccess(kind))) &&
      (settings().requirePairing === false || store.isPaired(kind, buffer.chatId)) &&
      authorization.pairedAt === buffer.authorization?.pairedAt && authorization.userId === buffer.authorization?.userId;
  }

  function chatIdForSession(sessionId) {
    const target = String(sessionId ?? "");
    for (const binding of store.listBindings()) {
      if (binding.sessionId === target && binding.key.startsWith(`${getChannel()?.kind}:`)) {
        const [channel] = binding.key.split(":");
        return { chatId: binding.key.split(":").slice(1).join(":"), channel };
      }
    }
    return null;
  }

  // ---------- Plan/Goal 远程审批 ----------

  function startPlanPolling() {
    if (planPollTimer) return;
    planPollTimer = setInterval(() => {
      void Promise.all([pollPendingApprovals(), pollTurns(), schedules.tick()]).catch(error => log("warn", "background poll failed", { error: redactSecrets(error.message) }));
    }, PLAN_POLL_INTERVAL_MS);
    planPollTimer.unref?.();
  }

  function stopPlanPolling() {
    if (planPollTimer) clearInterval(planPollTimer);
    planPollTimer = null;
  }

  async function pollPendingApprovals() {
    if (disposed || busySessions.size === 0) return;
    const sessionIds = [...busySessions];
    for (const sessionId of sessionIds) {
      try {
        const buffer = turnBuffers.get(sessionId);
        if (!buffer || buffer.observed || !authorizedTurn(buffer)) continue;
        const result = await invoke("plans/pending", [{ sessionId }]);
        if (!authorizedTurn(buffer) || turnBuffers.get(sessionId) !== buffer) continue;
        const plans = result?.plans ?? [];
        for (const plan of plans) {
          const proposalId = String(plan.id ?? "");
          const versionKey = `${proposalId}:${plan.version ?? ""}`;
          if (!proposalId || notifiedApprovals.has(versionKey) ||
              plan.sessionId !== sessionId || (plan.status && plan.status !== "pending") ||
              (plan.expiresAt && Date.parse(plan.expiresAt) <= now())) continue;
          const location = chatIdForSession(sessionId);
          if (!location) continue;
          notifiedApprovals.add(versionKey);
          pendingApprovals.set(proposalId, {
            channel: location.channel,
            chatId: location.chatId,
            sessionId,
            boundAt: buffer.boundAt, authorization: buffer.authorization, expiresAt: plan.expiresAt,
            turnId: String(plan.turnId ?? ""),
            toolCallId: String(plan.toolCallId ?? ""),
            title: String(plan.title ?? "Plan 检查点"),
            summary: String(plan.markdown ?? plan.summary ?? plan.description ?? ""),
            version: typeof plan.version === "number" ? plan.version : undefined,
          });
          await sendChoice(location.chatId, {
            choiceId: proposalId,
            title: `${plan.kind === "goal" ? "Goal" : "Plan"} 检查点需要批准`,
            prompt: [
              pendingApprovals.get(proposalId).title,
              pendingApprovals.get(proposalId).summary,
              "1. 批准执行",
              "2. 拒绝",
              "提交后仍需在桌面确认宿主授权。",
            ]
              .filter(Boolean)
              .join("\n"),
            options: ["批准执行", "拒绝"],
          });
          audit({ event: "plan-approval-requested", sessionId, proposalId });
        }
      } catch (error) {
        log("warn", "plans/pending failed", { sessionId, error: String(error?.message ?? error) });
      }
    }
  }

  async function handleChoice({ chatId, choiceId, selection, userId, channel = getChannel()?.kind }) {
    const pairing = store.getPairings()[`${channel}:${chatId}`];
    if (settings().requirePairing !== false && (!pairing || (userId && pairing.userId && pairing.userId !== userId))) {
      await send(chatId, "聊天授权已失效，请重新 /bind。");
      return;
    }
    if (await commands.select(channel, chatId, choiceId, selection)) return;
    if (await phoneQuestions.answer(channel, chatId, selection, choiceId)) return;
    const approval = pendingApprovals.get(String(choiceId));
    if (!approval || approval.chatId !== chatId || approval.channel !== channel ||
        store.getBinding(channel, chatId)?.sessionId !== approval.sessionId || !["1", "2"].includes(selection)) {
      await send(chatId, "该确认请求已过期，请重新触发。");
      return;
    }
    const buffer = turnBuffers.get(approval.sessionId);
    if (!buffer || buffer.observed || !authorizedTurn(buffer) || approval.boundAt !== buffer.boundAt ||
        JSON.stringify(approval.authorization) !== JSON.stringify(buffer.authorization) ||
        (approval.expiresAt && Date.parse(approval.expiresAt) <= now())) {
      pendingApprovals.delete(String(choiceId));
      await send(chatId, "该确认请求已过期，请重新触发。");
      return;
    }
    const approve = selection === "1";
    try {
      await invoke(
        "plans/resolve",
        [
          {
            proposalId: String(choiceId),
            sessionId: approval.sessionId,
            turnId: approval.turnId,
            toolCallId: approval.toolCallId,
            action: approve ? "approve" : "reject",
            ...(approve ? { targetPermissionMode: "ask" } : {}),
            ...(approval.version !== undefined ? { version: approval.version } : {}),
          },
        ],
        { confirm: true },
      );
      pendingApprovals.delete(String(choiceId));
      await send(chatId, approve ? "已批准，Plan 继续执行。" : "已拒绝，Plan 已停止。");
      audit({ event: "plan-resolved", sessionId: approval.sessionId, proposalId: String(choiceId), action: approve ? "approve" : "reject" });
    } catch (error) {
      await send(chatId, `审批失败：${error.message}`);
    }
  }

  async function resolveApprovalBySelection(chatId, selection) {
    for (const [proposalId, approval] of pendingApprovals.entries()) {
      if (approval.chatId === chatId) {
        await handleChoice({ chatId, choiceId: proposalId, selection });
        return;
      }
    }
  }

  /** 阻塞式交互（审批/提问）前封存该聊天正在写入的流式卡；后续输出由通道另起新卡。 */
  async function sealTurnsForChat(chatId) {
    const seals = [];
    for (const buffer of turnBuffers.values()) {
      if (buffer.chatId === chatId && buffer.turn) {
        seals.push(buffer.turn.seal());
      }
    }
    await Promise.all(seals);
  }

  async function sendChoice(chatId, request) {
    const channel = channelOf(chatId);
    await sealTurnsForChat(chatId);
    if (!channel || getChannel() !== channel) return { delivered: false, reason: "channel-changed" };
    if (request.guard && !request.guard()) return { delivered: false, reason: "authorization-changed" };
    try {
      if (typeof channel.sendChoice === "function") {
        const result = await channel.sendChoice(chatId, request);
        if (result && result.delivered === false) {
          pushOutbox(chatId, formatChoicePrompt(request));
        }
        return result ?? { delivered: true };
      }
      return send(chatId, formatChoicePrompt(request), { retryable: false });
    } catch (error) {
      log("error", "sendChoice failed", { chatId, error: String(error?.message ?? error) });
      return send(chatId, formatChoicePrompt(request), { retryable: false });
    }
  }

  // ---------- 生命周期 ----------

  function saveTurn(buffer) {
    const channel = buffer.queueKey.split(":")[0];
    const pairing = store.getPairings()[buffer.queueKey];
    buffer.authorization ??= { pairedAt: pairing?.pairedAt ?? null, userId: pairing?.userId ?? null };
    buffer.boundAt ??= store.getBinding(channel, buffer.chatId)?.boundAt;
    buffer.projectPolicy ??= JSON.stringify(store.getProjectAccess(channel));
    store.savePendingTurn({
      sessionId: buffer.item.sessionId, channel, chatId: buffer.chatId,
      queueKey: buffer.queueKey, messageId: buffer.messageId,
      inboundMessageId: buffer.item.messageId, hostTurnId: buffer.hostTurnId ?? "",
      scheduleId: buffer.item.scheduleId,
      pairedAt: buffer.authorization.pairedAt, userId: buffer.authorization.userId,
      boundAt: buffer.boundAt,
      projectPolicy: buffer.projectPolicy,
      startedAt: buffer.startedAt, mode: buffer.mode, text: buffer.text,
      flushed: buffer.flushed, finalText: buffer.finalText,
      changes: [...buffer.changes], tools: [...buffer.tools],
      observed: buffer.observed === true,
      extensionRunId: buffer.extensionRunId, terminalEvent: buffer.terminalEvent,
      card: buffer.turn?.snapshot?.() ?? null,
    });
  }

  async function attachChannel() {
    const channel = getChannel();
    for (const saved of store.getPendingTurns(channelKind)) {
      if (disposed || getChannel() !== channel) return;
      if (saved.channel !== channel?.kind || turnBuffers.has(saved.sessionId)) continue;
      const pairing = store.getPairings()[saved.queueKey];
      if (store.getBinding(saved.channel, saved.chatId)?.sessionId !== saved.sessionId ||
          (saved.boundAt && store.getBinding(saved.channel, saved.chatId)?.boundAt !== saved.boundAt) ||
          (settings().requirePairing !== false && !pairing) ||
          (saved.projectPolicy && saved.projectPolicy !== JSON.stringify(store.getProjectAccess(saved.channel))) ||
          (pairing?.pairedAt ?? null) !== saved.pairedAt || (pairing?.userId ?? null) !== saved.userId) {
        store.removePendingTurn(saved.sessionId, channelKind);
        audit({ event: "turn-recovery-rejected", sessionId: saved.sessionId, reason: "binding-or-authorization-changed" });
        continue;
      }
      if (store.getProjectAccess(saved.channel).mode === "selected") {
        try { await invoke("agent/getStatus", [saved.sessionId], { channel: saved.channel }); }
        catch (error) {
          log("warn", "turn recovery scope check failed", { sessionId: saved.sessionId, error: error.message });
          continue;
        }
        if (disposed || getChannel() !== channel || store.getBinding(saved.channel, saved.chatId)?.sessionId !== saved.sessionId || store.getPairings()[saved.queueKey] !== pairing) continue;
      }
      const item = { sessionId: saved.sessionId, messageId: saved.inboundMessageId, scheduleId: saved.scheduleId };
      const buffer = { ...saved, item, dispatching: false, ending: false,
        boundAt: saved.boundAt ?? store.getBinding(saved.channel, saved.chatId)?.boundAt,
        authorization: { pairedAt: saved.pairedAt, userId: saved.userId },
        pendingHostEnds: new Map(), changes: new Map(saved.changes), tools: new Map(saved.tools), turn: null };
      turnBuffers.set(saved.sessionId, buffer);
      if (!buffer.observed) executionLocks.set(saved.sessionId, buffer);
      busySessions.add(saved.sessionId);
      queues.set(saved.queueKey, [item]);
      if (saved.card && useCardMode()) buffer.turn = channel.beginTurn({ chatId: saved.chatId, messageId: saved.inboundMessageId, resume: saved.card });
      audit({ event: "turn-recovered", sessionId: saved.sessionId, turnId: saved.hostTurnId });
      try {
        const result = await invoke("agent/getStatus", [saved.sessionId], { channel: saved.channel });
        if (disposed || turnBuffers.get(saved.sessionId) !== buffer) continue;
        const status = readSessionStatus(result);
        if (saved.terminalEvent) await handleHostTurnEnded(saved.terminalEvent);
        else if (["idle", "completed", "stopped", "cancelled", "canceled", "interrupted", "error", "failed"].includes(status.state)) {
          await handleHostTurnEnded({ sessionId: saved.sessionId, turnId: saved.hostTurnId,
            reason: ["error", "failed"].includes(status.state) ? "error" : ["stopped", "cancelled", "canceled", "interrupted"].includes(status.state) ? "aborted" : "completed" });
        }
      } catch (error) {
        log("warn", "turn recovery status unavailable", { sessionId: saved.sessionId, error: error.message });
      }
    }
    if (!disposed && getChannel() === channel) {
      startPlanPolling();
      await schedules.tick();
    }
  }

  function detachChannel({ preserveTurns = false } = {}) {
    const pauses = [];
    for (const [sessionId, buffer] of turnBuffers) {
      const paused = buffer.turn?.pause?.();
      if (preserveTurns) {
        saveTurn(buffer);
        pauses.push(Promise.all([paused, buffer.dispatchResult]).then(([, result]) => {
          if (typeof result?.turnId === "string") buffer.hostTurnId = result.turnId;
          saveTurn(buffer);
        }).catch(error => {
          store.removePendingTurn(sessionId, channelKind);
          log("warn", "turn checkpoint failed", { sessionId, error: error.message });
        }));
      } else store.removePendingTurn(sessionId, channelKind);
      if (executionLocks.get(sessionId) === buffer) executionLocks.delete(sessionId);
    }
    if (!preserveTurns) {
      for (const saved of store.getPendingTurns(channelKind)) {
        if (!disposed) store.removePendingTurn(saved.sessionId, channelKind);
      }
    }
    stopPlanPolling();
    busySessions.clear();
    turnBuffers.clear();
    extensionRuns.clear();
    queues.clear();
    pendingApprovals.clear();
    phoneQuestions.clear();
    notifiedApprovals.clear();
    commands.clear();
    outboxes.clear();
    recentMessageIds.clear();
    completedExtensionRuns.clear();
    return Promise.all(pauses);
  }

  function dispose() {
    disposed = true;
    return detachChannel();
  }

  function snapshot() {
    return {
      busySessions: [...busySessions],
      queued: Object.fromEntries([...queues.entries()].map(([key, value]) => [key, value.length])),
      pendingApprovals: [...pendingApprovals.values()].map((item) => ({
        chatId: item.chatId,
        sessionId: item.sessionId,
        title: item.title,
      })),
      outboxes: Object.fromEntries([...outboxes.entries()].map(([key, value]) => [key, value.length])),
    };
  }

  return {
    handleInbound,
    handleChoice,
    handleAgentEvent,
    ownsInteraction: event => {
      const buffer = turnBuffers.get(String(event.sessionId ?? ""));
      return Boolean(buffer && !buffer.observed && event.runId && buffer.extensionRunId === event.runId && authorizedTurn(buffer));
    },
    handleHostTurnEnded,
    retryDelivery,
    showStatus,
    attachChannel,
    detachChannel,
    dispose,
    snapshot,
    /** 轮询入口：生产环境由定时器驱动，测试与面板可手动触发。 */
    pollApprovals: () => pollPendingApprovals(),
    tickSchedules: () => schedules.tick(),
    pollTurns,
    isDangerousCommand: command => DANGEROUS_COMMANDS.has(canonicalCommand(command)),
  };
}

module.exports = { createBridge, remoteTag };
