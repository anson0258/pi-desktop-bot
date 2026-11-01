"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createDecipheriv, randomInt, randomUUID } = require("node:crypto");
const { request, requestJson } = require("./http.cjs");
const { redactSecrets } = require("./security.cjs");
const { formatChoicePrompt } = require("./render.cjs");
const { attachmentMetadata, validateAttachments, mimeTypeFromFilename } = require("./attachment.cjs");
const {
  WEIXIN_ILINK_BASE_URL,
  WEIXIN_BOT_API_PREFIX,
  WEIXIN_CHANNEL_VERSION,
  WEIXIN_APP_HEADERS,
  WEIXIN_MESSAGE_TYPE_BOT,
  WEIXIN_GET_UPDATES_TIMEOUT_MS,
} = require("./constants.cjs");

/**
 * 微信 iLink Bot 通道（对齐 ZCode weixinProvider）：
 * 长轮询 /getupdates 收消息（get_updates_buf 游标持久化），
 * /sendmessage 发文本，/getconfig + /sendtyping 做"正在输入"，
 * 入站附件走 CDN 下载 + AES-128-ECB 解密。
 * 群消息（room）按发送者用户路由，不实现群协作（与 ZCode 非群路径一致）。
 */

const WEIXIN_CDN_AES_ALGORITHM = "aes-128-ecb";

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function readString(record, key) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record, key) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberOrString(record, key) {
  if (typeof record?.[key] === "string") return record[key];
  return typeof record?.[key] === "number" && Number.isFinite(record[key])
    ? String(record[key])
    : "";
}

/** iLink AES key：32 位十六进制，或 base64 解码后 16 字节。 */
function parseWeixinAesKey(value) {
  const trimmed = String(value ?? "").trim();
  if (/^[a-f0-9]{32}$/iu.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) return decoded;
    const decodedText = decoded.toString("utf8").trim();
    if (/^[a-f0-9]{32}$/iu.test(decodedText)) {
      return Buffer.from(decodedText, "hex");
    }
  } catch {
    return null;
  }
  return null;
}

/** 微信 CDN 返回 AES-128-ECB + PKCS7 的密文字节，直接保存会得到不可识别的 data 文件。 */
function decryptWeixinCdnMedia(data, aesKey) {
  const key = parseWeixinAesKey(aesKey);
  if (!key) {
    throw new Error("Weixin attachment AES key is invalid.");
  }
  const decipher = createDecipheriv(WEIXIN_CDN_AES_ALGORITHM, key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function buildRandomWechatUin() {
  return Buffer.from(String(randomInt(0, 0x1_0000_0000)), "utf8").toString("base64");
}

function buildHeaders(token) {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": buildRandomWechatUin(),
    ...WEIXIN_APP_HEADERS,
  };
}

function appendBaseInfo(body) {
  if (!isRecord(body)) return body;
  return { base_info: { channel_version: WEIXIN_CHANNEL_VERSION }, ...body };
}


function inferWeixinAttachmentKind(item, mediaSource) {
  if (isRecord(item.image_item)) return "image";
  if (isRecord(item.audio_item)) return "audio";
  if (isRecord(item.video_item)) return "video";
  if (isRecord(item.file_item)) return "file";
  const explicit =
    readString(item, "kind") ||
    readString(item, "media_type") ||
    readString(item, "mediaType") ||
    readString(item, "type_name");
  const explicitKind = explicit.trim().toLowerCase();
  if (["image", "audio", "video", "file"].includes(explicitKind)) return explicitKind;
  const mimeType = readString(mediaSource, "mime_type") || readString(mediaSource, "mimeType");
  const filename =
    readString(mediaSource, "filename") ||
    readString(mediaSource, "file_name") ||
    readString(mediaSource, "name");
  const normalized = `${explicit} ${mimeType} ${filename}`.toLowerCase();
  if (
    normalized.includes("image") ||
    normalized.includes("photo") ||
    normalized.includes("picture") ||
    /\.(svg|png|jpe?g|gif|webp|heic|bmp)$/iu.test(filename)
  ) {
    return "image";
  }
  if (normalized.includes("audio") || normalized.includes("voice")) return "audio";
  if (normalized.includes("video")) return "video";
  return "file";
}

function readWeixinAttachmentItem(item, index) {
  if (!isRecord(item)) return null;
  if (readWeixinTextItem(item)) return null;
  const media = isRecord(item.image_item)
    ? item.image_item
    : isRecord(item.file_item)
      ? item.file_item
      : isRecord(item.video_item)
        ? item.video_item
        : isRecord(item.audio_item)
          ? item.audio_item
          : isRecord(item.media_item)
            ? item.media_item
            : item;
  const mediaPayload = isRecord(media.media) ? media.media : null;
  const mediaSource = mediaPayload ? { ...media, ...mediaPayload } : media;
  const providerFileId =
    readNumberOrString(mediaSource, "file_id") ||
    readNumberOrString(mediaSource, "fileId") ||
    readNumberOrString(mediaSource, "media_id") ||
    readNumberOrString(mediaSource, "mediaId") ||
    readNumberOrString(mediaSource, "id") ||
    readNumberOrString(mediaSource, "encrypt_query_param") ||
    readNumberOrString(mediaSource, "encryptQueryParam") ||
    // 微信图片消息的 image_item 常只返回 media 字段，没有 file_id/md5；media 作为下载与去重标识。
    readNumberOrString(mediaSource, "media") ||
    readNumberOrString(mediaSource, "md5");
  const downloadUrl =
    readString(mediaSource, "url") ||
    readString(mediaSource, "download_url") ||
    readString(mediaSource, "downloadUrl") ||
    readString(mediaSource, "full_url") ||
    readString(mediaSource, "fullUrl");
  const dataBase64 =
    readString(mediaSource, "data_base64") ||
    readString(mediaSource, "dataBase64") ||
    readString(mediaSource, "base64");
  if (!providerFileId && !downloadUrl && !dataBase64) return null;
  const kind = inferWeixinAttachmentKind({ ...item, ...mediaSource }, mediaSource);
  const filename =
    readString(mediaSource, "filename") ||
    readString(mediaSource, "file_name") ||
    readString(mediaSource, "name") ||
    (kind === "image" ? `weixin-image-${index + 1}.jpg` : `weixin-attachment-${index + 1}`);
  const mimeType =
    readString(mediaSource, "mime_type") ||
    readString(mediaSource, "mimeType") ||
    mimeTypeFromFilename(filename) ||
    (kind === "image"
      ? "image/jpeg"
      : kind === "audio"
        ? "audio/mpeg"
        : kind === "video"
          ? "video/mp4"
          : "application/octet-stream");
  const sizeBytes =
    readNumber(mediaSource, "size") ??
    readNumber(mediaSource, "sizeBytes") ??
    readNumber(mediaSource, "file_size") ??
    readNumber(mediaSource, "len") ??
    // image_item 没有通用 size，mid_size 是实际图片资源大小，thumb_size 只是缩略图。
    readNumber(mediaSource, "mid_size");
  const aesKey =
    readString(mediaSource, "aes_key") ||
    readString(mediaSource, "aesKey") ||
    readString(mediaSource, "aeskey");
  return {
    id: providerFileId || downloadUrl || `weixin-${index + 1}`,
    kind,
    filename,
    mimeType,
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(providerFileId ? { providerFileId } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(aesKey ? { aesKey } : {}),
  };
}

function readWeixinTextItem(item) {
  if (!isRecord(item)) return "";
  const textItem = isRecord(item.text_item) ? item.text_item : null;
  const voiceItem = isRecord(item.voice_item) ? item.voice_item : null;
  // 微信语音消息：微信官方语音转文字的结果就在 voice_item.text 里（与 Pi-WechatBot 同一来源）；
  // 识别不到文字时给出占位文本，避免整条消息被直接丢弃。
  if (voiceItem) {
    return readString(voiceItem, "text") || "[语音消息 — 未能识别文字，请以文字发送]";
  }
  return readString(textItem, "text") || readString(item, "text") || readString(item, "content");
}

/** 微信语音消息：voice_item.text 是微信官方语音转文字的结果（与 Pi-WechatBot 同一来源）。 */
function readWeixinVoice(message) {
  const inner = innerOf(message);
  const items = [
    ...itemListOf(message),
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(inner?.attachments) ? inner.attachments : []),
  ];
  for (const item of items) {
    if (isRecord(item?.voice_item)) {
      return { isVoice: true, text: readString(item.voice_item, "text").trim() };
    }
  }
  return { isVoice: false, text: "" };
}
function innerOf(message) {
  return isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
}

function itemListOf(message) {
  const inner = innerOf(message);
  if (Array.isArray(message.item_list)) return message.item_list;
  if (Array.isArray(inner?.item_list)) return inner.item_list;
  return [];
}

function readWeixinText(message) {
  const direct =
    readString(message, "text") || readString(message, "content") || readString(message, "message");
  if (direct) return direct;
  const inner = innerOf(message);
  const joined = itemListOf(message)
    .map(readWeixinTextItem)
    .filter(Boolean)
    .join("\n");
  return joined || readString(inner, "text") || readString(inner, "content");
}

function readWeixinAttachments(message) {
  const inner = innerOf(message);
  const direct = Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(inner?.attachments)
      ? inner.attachments
      : [];
  return [
    ...itemListOf(message)
      .map((item, index) => readWeixinAttachmentItem(item, index))
      .filter((attachment) => attachment !== null),
    ...direct
      .map((item, index) => readWeixinAttachmentItem(item, index))
      .filter((attachment) => attachment !== null),
  ];
}

function readWeixinUserId(message) {
  const from = isRecord(message.from) ? message.from : null;
  const sender = isRecord(message.sender) ? message.sender : null;
  return (
    readString(message, "from_user_id") ||
    readString(message, "from") ||
    readString(message, "from_user") ||
    readString(message, "fromUser") ||
    readString(message, "user") ||
    readString(message, "user_id") ||
    readString(message, "userId") ||
    readString(from, "id") ||
    readString(from, "wxid") ||
    readString(sender, "id") ||
    readString(sender, "wxid")
  );
}

function readWeixinMessageId(message) {
  const inner = innerOf(message);
  const messageId =
    readString(message, "id") ||
    readString(message, "msgid") ||
    readString(message, "msgId") ||
    readNumberOrString(message, "message_id") ||
    readString(inner, "id") ||
    readString(inner, "msgid") ||
    readString(inner, "msgId") ||
    readNumberOrString(inner, "message_id");
  if (messageId) return messageId;
  const numericId =
    readNumber(message, "id") ??
    readNumber(message, "msgid") ??
    readNumber(message, "msgId") ??
    readNumber(inner, "id") ??
    readNumber(inner, "msgid") ??
    readNumber(inner, "msgId");
  return numericId === null ? "" : String(numericId);
}

function readWeixinContextToken(message) {
  const inner = innerOf(message);
  return (
    readString(message, "context_token") ||
    readString(message, "contextToken") ||
    readString(message, "context") ||
    readString(inner, "context_token") ||
    ""
  );
}

function readWeixinRoom(message) {
  return (
    readString(message, "room") ||
    readString(message, "room_id") ||
    readString(message, "roomId") ||
    readString(message, "chat") ||
    readString(message, "chat_id") ||
    readString(message, "chatId") ||
    ""
  );
}

/** 从 /getupdates 响应解析原始消息列表与下一轮 buf 游标。 */
function parseGetUpdates(payload) {
  const data = isRecord(payload) && "data" in payload ? payload.data : payload;
  const container = isRecord(data) ? data : {};
  const raw = container.msgs ?? container.messages ?? container.updates ?? container.items ?? container.list;
  const messages = Array.isArray(raw) ? raw.filter(isRecord) : isRecord(raw) ? [raw] : [];
  const buf =
    readString(container, "get_updates_buf") ||
    readString(container, "buf") ||
    readString(container, "next_buf") ||
    readString(container, "nextBuf") ||
    readString(container, "getUpdatesBuf") ||
    readString(container, "syncKey");
  return { messages, buf };
}

/**
 * 单条原始消息 → 统一入站结构（不含下载）。
 * message_type=2 是机器人自己发出的消息，过滤避免自环。
 * chatId 统一用发送者 userId（群 room 只记录在 meta），与 ZCode 非群发送路径一致。
 */
function buildInboundMessage(rawMessage) {
  if (readNumber(rawMessage, "message_type") === WEIXIN_MESSAGE_TYPE_BOT) return null;
  const text = readWeixinText(rawMessage).trim();
  const attachments = readWeixinAttachments(rawMessage);
  const userId = readWeixinUserId(rawMessage).trim();
  if ((!text && attachments.length === 0) || !userId) return null;
  const room = readWeixinRoom(rawMessage);
  const voice = readWeixinVoice(rawMessage);
  return {
    chatId: userId,
    userId,
    text,
    messageId: readWeixinMessageId(rawMessage),
    attachments,
    contextToken: readWeixinContextToken(rawMessage),
    chatType: room ? "group" : "private",
    room,
    isVoice: voice.isVoice,
    voiceText: voice.text,
  };
}

/** /sendmessage 报文体：文本放 msg.item_list，换行统一 CRLF（iLink 对 LF 处理不一致）。 */
function buildSendPayload({ chatId, text, contextToken, fromUserId = "" }) {
  return appendBaseInfo({
    msg: {
      from_user_id: fromUserId,
      to_user_id: chatId,
      client_id: `pi-weixin-${randomUUID()}`,
      message_type: WEIXIN_MESSAGE_TYPE_BOT,
      message_state: 2,
      ...(contextToken ? { context_token: contextToken } : {}),
      item_list: [
        {
          type: 1,
          text_item: { text: String(text).replace(/\r\n|\r|\n/g, "\r\n") },
        },
      ],
    },
  });
}

function createWeixinChannel({
  botToken,
  botId = "",
  fromUserId = "",
  dataDir,
  onMessage,
  onLog,
  onStatus,
  requestJson: requestJsonImpl = requestJson,
  request: requestImpl = request,
  loadBuf = async () => null,
  saveBuf = async () => {},
  loadContextToken = async () => null,
  saveContextToken = async () => {},
  isAuthorized = async () => false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let controller = null;
  let stopped = false;
  let deliveryError = "";
  /** chatId -> 最近一条入站消息的 context_token，供回复/typing 使用。 */
  const contextTokens = new Map();

  function errorMessage(error) {
    let message = String(error?.message ?? error);
    for (const secret of [botToken, ...contextTokens.values()]) {
      if (secret) message = message.split(secret).join("[REDACTED]");
    }
    return redactSecrets(message.replace(/https?:\/\/[^\s)]+/giu, "[URL]"));
  }

  async function getContextToken(chatId) {
    if (contextTokens.has(chatId)) return contextTokens.get(chatId);
    const token = await loadContextToken(chatId);
    if (typeof token === "string" && token) {
      contextTokens.set(chatId, token);
      return token;
    }
    return "";
  }

  function log(level, message, data) {
    onLog?.(level, message, data);
  }

  function apiUrl(pathSuffix) {
    return `${WEIXIN_ILINK_BASE_URL}${WEIXIN_BOT_API_PREFIX}${pathSuffix}`;
  }

  async function call(pathSuffix, body, timeoutMs) {
    const response = await requestJsonImpl({
      method: "POST",
      url: apiUrl(pathSuffix),
      headers: buildHeaders(botToken),
      body: appendBaseInfo(body ?? {}),
      timeoutMs,
      signal: controller?.signal,
    }).catch(error => {
      throw Object.assign(new Error(errorMessage(error)), { name: error?.name || "Error" });
    });
    const payload = response.data;
    const ret = readNumber(payload, "ret");
    const errcode = readNumber(payload, "errcode");
    const codes = [ret !== null ? `ret=${ret}` : "", errcode !== null ? `errcode=${errcode}` : ""].filter(Boolean).join(" ");
    const detail = errorMessage(readString(payload, "errmsg") || readString(payload, "message")).slice(0, 300);
    if (response.status !== 200) {
      const explanation = [codes, detail].filter(Boolean).join(" ");
      throw new Error(`weixin iLink ${pathSuffix} failed: HTTP ${response.status}${explanation ? ` (${explanation})` : ""}`);
    }
    if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
      throw new Error(`weixin iLink ${pathSuffix} failed: ${[codes, detail].filter(Boolean).join(" ")}`);
    }
    return payload;
  }

  async function downloadInbound(attachment) {
    validateAttachments([attachment]);
    let buffer;
    if (attachment.dataBase64) {
      const encoded = attachment.dataBase64.replace(/\s/gu, "");
      const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
      validateAttachments([{ sizeBytes: Math.floor(encoded.length * 3 / 4) - padding }]);
      buffer = Buffer.from(encoded, "base64");
    } else if (attachment.downloadUrl) {
      const response = await requestImpl({
        method: "GET",
        url: attachment.downloadUrl,
        timeoutMs: 30000,
        signal: controller?.signal,
      });
      if (response.status !== 200) {
        throw new Error(`weixin attachment download failed: HTTP ${response.status}`);
      }
      buffer = response.buffer;
    } else {
      throw new Error("weixin attachment has no downloadable payload");
    }
    validateAttachments([{ sizeBytes: buffer.length }]);
    if (attachment.aesKey) buffer = decryptWeixinCdnMedia(buffer, attachment.aesKey);
    const metadata = attachmentMetadata("", attachment, buffer.length);
    const dir = path.join(dataDir, "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `weixin-${randomUUID()}-${metadata.filename}`);
    fs.writeFileSync(target, buffer);
    return { ...metadata, path: target };
  }

  async function handleRawMessage(rawMessage) {
    const parsed = buildInboundMessage(rawMessage);
    if (!parsed) return;
    if (parsed.chatType === "private" && parsed.contextToken) {
      const authorized = await isAuthorized(parsed.chatId, parsed.userId);
      // Pairing replies need the current token before the binding is persisted by the caller.
      contextTokens.set(parsed.chatId, parsed.contextToken);
      if (authorized === true) await saveContextToken(parsed.chatId, parsed.contextToken);
    }

    const attachments = [];
    try {
      validateAttachments(parsed.attachments);
      for (const attachment of parsed.attachments) {
        attachments.push(await downloadInbound(attachment));
      }
    } catch (error) {
      for (const attachment of attachments) fs.rmSync(attachment.path, { force: true });
      if (error.code !== "ATTACHMENT_LIMIT") throw error;
      const result = await sendText(parsed.chatId, `附件无法接收：${error.message}`);
      if (!result.delivered) throw new Error(result.reason);
      return;
    }
    const images = attachments.map(attachment => attachment.path);
    if (!parsed.text && attachments.length === 0) return;

    // 微信语音消息：先把官方语音转文字的结果回发到微信，再派发给 AI（与 Pi-WechatBot 行为一致）。
    if (parsed.isVoice && parsed.voiceText) {
      await sendText(parsed.chatId, `🎙️ 已识别语音: "${parsed.voiceText}"\n正在派发给 AI 处理...`);
    }

    await onMessage({
      channel: "weixin",
      chatId: parsed.chatId,
      userId: parsed.userId,
      text: parsed.text,
      messageId: parsed.messageId,
      images,
      attachments,
      isVoice: parsed.isVoice,
      voiceText: parsed.voiceText,
      meta: {
        chatType: parsed.chatType, room: parsed.room,
        ...(parsed.chatType === "private" && parsed.contextToken ? { contextToken: parsed.contextToken } : {}),
      },
    });
  }

  async function pollLoop() {
    let buf = await loadBuf();
    let pending = null;
    let pollFailures = 0;
    while (!stopped) {
      try {
        if (!pending) {
          const payload = await call("/getupdates", { get_updates_buf: buf ?? "" }, WEIXIN_GET_UPDATES_TIMEOUT_MS);
          if (stopped) return;
          if (!isRecord(payload) || Array.isArray(payload)) throw new Error("weixin iLink /getupdates returned invalid JSON response");
          pending = { ...parseGetUpdates(payload), index: 0 };
          pollFailures = 0;
          onStatus?.("connected");
        }
        while (pending.index < pending.messages.length) {
          if (stopped) return;
          await handleRawMessage(pending.messages[pending.index]);
          pending.index += 1;
        }
        if (pending.buf && pending.buf !== buf) {
          await saveBuf(pending.buf);
          buf = pending.buf;
        }
        pending = null;
      } catch (error) {
        if (stopped || error?.name === "AbortError") return;
        const retryMs = !pending && ++pollFailures >= 3 ? 30000 : 2000;
        if (!pending) {
          onStatus?.("connecting", `${errorMessage(error)}（${retryMs / 1000} 秒后重试）`);
          if (pollFailures >= 3) pollFailures = 0;
        } else noteDeliveryError(error);
        log("warn", "weixin poll failed", { error: errorMessage(error), retryMs });
        await sleep(retryMs);
      }
    }
  }

  function noteDeliveryError(error) {
    deliveryError = errorMessage(error);
  }

  async function sendText(chatId, text) {
    try {
      await call("/sendmessage", buildSendPayload({
        chatId,
        text: redactSecrets(text),
        contextToken: await getContextToken(chatId),
        fromUserId,
      }));
      deliveryError = "";
      return { delivered: true };
    } catch (error) {
      noteDeliveryError(error);
      return { delivered: false, reason: deliveryError };
    }
  }

  /** iLink 文本无按钮载体：选择请求渲染为编号文本，用户回复序号即可。 */
  async function sendChoice(chatId, request) {
    return sendText(chatId, formatChoicePrompt(request));
  }

  async function sendTyping(chatId) {
    try {
      const contextToken = await getContextToken(chatId);
      const config = await call("/getconfig", {
        ilink_user_id: chatId,
        ...(contextToken ? { context_token: contextToken } : {}),
      });
      const ticket = readString(config, "typing_ticket");
      if (!ticket) return;
      await call("/sendtyping", { ilink_user_id: chatId, typing_ticket: ticket, status: 1 });
    } catch (error) {
      log("warn", "weixin typing failed", { error: errorMessage(error) });
    }
  }

  async function uploadMedia() {
    throw new Error("微信 iLink 通道暂不支持媒体上传；请用 /send <路径> 获取本机路径");
  }

  async function start() {
    if (stopped) throw new Error("channel already stopped");
    stopped = false;
    controller = new AbortController();
    onStatus?.("connecting");
    log("info", "weixin iLink polling started", { botId });
    void pollLoop();
  }

  async function stop() {
    stopped = true;
    controller?.abort();
    controller = null;
    onStatus?.("stopped");
  }

  return {
    kind: "weixin",
    capabilities: { streamingCard: false },
    start,
    stop,
    sendText,
    sendChoice,
    sendTyping,
    uploadMedia,
    getDeliveryError: () => deliveryError,
    describe: () => ({ botToken: botToken ? "***" : "", botId, deliveryError }),
  };
}

module.exports = {
  createWeixinChannel,
  parseGetUpdates,
  buildInboundMessage,
  buildSendPayload,
  decryptWeixinCdnMedia,
  parseWeixinAesKey,
};
