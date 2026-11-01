"use strict";

const { truncate } = require("./security.cjs");

/**
 * 结果整形：分段、纯文本渲染。
 * 手机端消息有长度上限，按段落边界切分，绝不硬截断一句话。
 */

const HARD_MAX_CHARS = 1800; // 飞书文本消息安全上限

function chunkText(text, maxChars = 1200) {
  const value = String(text ?? "").replace(/\r\n/g, "\n");
  if (!value) return [];
  const limit = Math.max(80, Math.min(Number(maxChars) || 1200, HARD_MAX_CHARS));
  if (value.length <= limit) return [value];

  const paragraphs = value.split(/\n{2,}/);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) {
        chunks.push(current.trimEnd());
        current = "";
      }
      // 超长段落按换行再切
      const lines = paragraph.split("\n");
      let line = "";
      for (const piece of lines) {
        if ((line + piece).length + 1 > limit) {
          if (line) chunks.push(line);
          if (piece.length > limit) {
            for (let i = 0; i < piece.length; i += limit) {
              chunks.push(piece.slice(i, i + limit));
            }
            line = "";
          } else {
            line = piece;
          }
        } else {
          line = line ? `${line}\n${piece}` : piece;
        }
      }
      current = line;
      continue;
    }
    if ((current + "\n\n" + paragraph).length > limit) {
      chunks.push(current.trimEnd());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

function formatChoicePrompt(request) {
  const options = Array.isArray(request.options) ? request.options : [];
  const menu = String(request.choiceId).startsWith("menu:") && options.at(-1) === "取消";
  const lines = [request.title || "需要你的确认", request.prompt].filter(Boolean);
  if (menu) lines.push("0. 取消", "");
  options.forEach((option, index) => {
    if (menu && index === options.length - 1) return;
    lines.push(`${index + 1}. ${option}`);
  });
  lines.push(menu ? "\n回复数字选择，0 取消。" : "回复序号进行选择。");
  return lines.join("\n");
}

function formatSessionList(sessions) {
  if (!sessions || sessions.length === 0) return "当前没有会话。用 /new 创建一个。";
  return sessions
    .map((session, index) => {
      const title = session.title || "(未命名)";
      const id = session.id ?? session.sessionId ?? "";
      const project = session.projectPath ? ` · ${session.projectPath}` : "";
      return `${index + 1}. ${title}\n   ${id}${project}`;
    })
    .join("\n");
}

function readSessionStatus(result) {
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" && value.trim() ? value : undefined;
  const source = record(result?.status) ? result.status : record(result?.state) ? result.state : result ?? {};
  const running = [source.isRunning, source.isStreaming, source.busy, source.running, source.active].find(value => typeof value === "boolean");
  let state = (text(source.state) ?? text(source.status))?.replace(/-/g, "_")
    ?? (running === undefined ? "unknown" : running ? "running" : "idle");
  if (running && ["idle", "unknown"].includes(state)) state = "running";
  if (source.isCompacting === true) state = "compacting";
  if (source.pendingToolConfirmations > 0) state = "waiting_permission";
  return {
    state,
    providerId: text(source.providerId) ?? text(source.model?.providerId),
    modelId: text(source.modelId) ?? text(source.model?.id),
    projectPath: text(source.projectPath),
    permissionMode: text(source.permissionMode),
  };
}

function formatSessionStatus(status, context = {}) {
  if (!status) return "无法读取会话状态。";
  const value = readSessionStatus(status);
  const session = context.session ?? {};
  const line = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const modelId = value.modelId || line(session.modelId);
  const providerId = value.providerId || (modelId === session.modelId ? session.providerId : undefined);
  const providers = Array.isArray(context.providers) ? context.providers : [];
  const candidates = providers.filter(provider => providerId ? provider.id === providerId : provider.models?.some(model => model.id === modelId));
  const provider = candidates.length === 1 ? candidates[0] : undefined;
  const model = provider?.models?.find(model => model.id === modelId);
  const modelLabel = line(model?.alias) || line(model?.name) || modelId || "未知";
  const providerLabel = line(provider?.name);
  const state = context.draft ? "draft" : context.busy && value.state === "unknown" ? "running" : value.state;
  const labels = {
    draft: "草稿",
    idle: "空闲", running: "执行中", busy: "执行中", compacting: "压缩上下文中",
    waiting_approval: "等待确认", waiting_permission: "等待确认", waiting_input: "等待输入",
    completed: "已完成", stopped: "已停止", cancelled: "已取消", canceled: "已取消",
    interrupted: "已中断", error: "执行失败", failed: "执行失败", unknown: "未知",
  };
  const sessionId = line(session.id) || line(session.sessionId);
  const title = truncate(line(session.title), 120);
  const lines = [
    `工作区：${line(session.workspaceLabel) || line(session.projectPath) || value.projectPath || "未设置"}`,
    `模型：${providerLabel ? `${providerLabel} / ` : ""}${modelLabel}`,
    "------",
    `${context.draft ? "任务：草稿" : `会话：${title ? `${title}${sessionId ? ` (${sessionId})` : ""}` : sessionId || "未知"}`}`,
    `状态：${labels[state] ?? state}`,
  ];
  const active = ["running", "busy", "compacting", "waiting_approval", "waiting_permission", "waiting_input"].includes(state);
  if (active && Number.isFinite(context.elapsedMs) && context.elapsedMs >= 0) {
    let seconds = Math.floor(context.elapsedMs / 1000);
    const parts = [];
    for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
      const amount = Math.floor(seconds / size);
      seconds %= size;
      if (amount || (size === 1 && !parts.length)) parts.push(`${amount}${unit}`);
    }
    lines.push(`本轮已用：${parts.join(" ")}`);
  }
  if (active && line(context.progress)) lines.push(`进展：${truncate(line(context.progress), 240)}`);
  const permission = value.permissionMode || line(session.permissionMode);
  if (permission) lines.push(`权限模式：${permission}`);
  return lines.join("\n");
}

function formatHelp(settings = {}, more = false) {
  const channel = settings.channel ?? "feishu";
  const lines = more ? [
    "其他命令",
    "",
    "执行设置",
    "/模式 — 选择 Agent / Plan / Goal",
    "/权限 — 选择会话权限模式",
    ...(["telegram", "weixin"].includes(channel) ? ["/回复 — 选择标准、完整或摘要回复"] : []),
    "",
    "文件与关联",
    "/改动 — 查看桌面工作区改动",
    ...(["feishu", "telegram"].includes(channel) ? ["/发送 <路径> — 把本机文件发到手机"] : []),
    "/解绑 — 解除会话关联，保留聊天授权",
    "/重试 — 重新发送最近一次失败结果（可能重复已收到的内容）",
    "/定时 — 管理私聊间隔或每日任务（需保持桌面运行）",
    "/bind <绑定码> — 绑定当前聊天",
    "",
    "/帮助 — 返回常用命令",
    "英文命令及原有别名仍可使用。",
  ] : [
    "常用命令",
    "",
    "会话",
    "/新建 — 新建并关联会话",
    "/会话 — 选择已有会话",
    "/状态 — 查看当前会话、工作区和模型",
    "/停止 — 中断当前任务",
    "",
    "配置",
    "/项目 — 切换工作区（已有会话不会移动）",
    "/模型 — 先选服务商，再选模型",
    "/思考 — 选择当前模型的思考等级",
    "",
    "/帮助 更多 — 查看其他命令",
    "直接发送消息即可执行任务。",
  ];
  lines.push("菜单可点击或回复序号，/取消 或 0 退出；10 分钟过期。");
  if (settings.allowDangerousRemote === false) {
    lines.push("配置切换已关闭，可在桌面「Pi-Desktop 机器人」面板的「机器人设置」中开启「允许远程配置切换」。");
  }
  return lines.join("\n");
}

module.exports = {
  chunkText,
  formatChoicePrompt,
  formatSessionList,
  readSessionStatus,
  formatSessionStatus,
  formatHelp,
  HARD_MAX_CHARS,
  truncate,
};
