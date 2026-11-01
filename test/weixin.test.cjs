"use strict";

/**
 * weixin：iLink 协议解析（入站消息/附件/buf 游标）、AES-128-ECB 解密、
 * 发送报文形状，以及适配器发送路径（注入 requestJson，不触网）。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { requestJson } = require("../lib/http.cjs");
const {
  createWeixinChannel,
  parseGetUpdates,
  buildInboundMessage,
  buildSendPayload,
  decryptWeixinCdnMedia,
  parseWeixinAesKey,
} = require("../lib/weixin.cjs");

const AES_KEY_HEX = "0123456789abcdef0123456789abcdef";

function encryptAesEcb(plain) {
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(AES_KEY_HEX, "hex"), null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

test("parseWeixinAesKey 支持 hex32 与 base64-16", () => {
  assert.deepEqual(parseWeixinAesKey(AES_KEY_HEX), Buffer.from(AES_KEY_HEX, "hex"));
  const base64 = Buffer.from(AES_KEY_HEX, "hex").toString("base64");
  assert.deepEqual(parseWeixinAesKey(base64), Buffer.from(AES_KEY_HEX, "hex"));
  assert.equal(parseWeixinAesKey("not-a-key"), null);
  assert.equal(parseWeixinAesKey(""), null);
});

test("decryptWeixinCdnMedia 解密 AES-128-ECB 密文，密钥非法即抛错", () => {
  const plain = Buffer.from("weixin-image-bytes");
  const decrypted = decryptWeixinCdnMedia(encryptAesEcb(plain), AES_KEY_HEX);
  assert.equal(decrypted.toString(), "weixin-image-bytes");
  assert.throws(() => decryptWeixinCdnMedia(plain, "bad-key"), /AES key is invalid/);
});

test("parseGetUpdates 解析 data 包装、msgs 列表与 buf 游标", () => {
  const result = parseGetUpdates({
    ret: 0,
    data: {
      msgs: [{ from_user_id: "wxid_1" }],
      get_updates_buf: "buf-next",
    },
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.buf, "buf-next");
});

test("parseGetUpdates 兼容无 data 包装与 syncKey 游标", () => {
  const result = parseGetUpdates({ msgs: [{ from_user_id: "wxid_1" }], syncKey: "sk-1" });
  assert.equal(result.messages.length, 1);
  assert.equal(result.buf, "sk-1");
});

test("buildInboundMessage：item_list 文本 + 发送者路由 + context_token", () => {
  const inbound = buildInboundMessage({
    from_user_id: "wxid_abc",
    message_id: 991,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "你好" } }],
  });
  assert.equal(inbound.chatId, "wxid_abc");
  assert.equal(inbound.userId, "wxid_abc");
  assert.equal(inbound.text, "你好");
  assert.equal(inbound.messageId, "991");
  assert.equal(inbound.contextToken, "ctx-1");
  assert.equal(inbound.chatType, "private");
});

test("buildInboundMessage：过滤机器人自己的消息（message_type=2）", () => {
  assert.equal(
    buildInboundMessage({ message_type: 2, from_user_id: "bot", text: "echo" }),
    null,
  );
});

test("buildInboundMessage：群消息 room 只进 meta，chatId 仍是发送者", () => {
  const inbound = buildInboundMessage({
    from: { id: "wxid_in_group" },
    room: "room-77",
    text: "大家好",
  });
  assert.equal(inbound.chatId, "wxid_in_group");
  assert.equal(inbound.room, "room-77");
  assert.equal(inbound.chatType, "group");
});

test("buildInboundMessage：image_item 提取 media/full_url/aes_key/mid_size", () => {
  const inbound = buildInboundMessage({
    from_user_id: "wxid_pic",
    item_list: [
      {
        image_item: {
          media: "mid-1",
          full_url: "https://cdn.example.com/a.jpg",
          aes_key: AES_KEY_HEX,
          mid_size: 12345,
        },
      },
    ],
  });
  assert.equal(inbound.text, "");
  assert.equal(inbound.attachments.length, 1);
  const attachment = inbound.attachments[0];
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.providerFileId, "mid-1");
  assert.equal(attachment.downloadUrl, "https://cdn.example.com/a.jpg");
  assert.equal(attachment.aesKey, AES_KEY_HEX);
  assert.equal(attachment.sizeBytes, 12345);
});
test("buildInboundMessage：voice_item 取微信官方语音转文字文本，不当音频附件", () => {
  const inbound = buildInboundMessage({
    from_user_id: "wxid_voice",
    item_list: [{ type: 3, voice_item: { text: "帮我查一下明天的天气" } }],
  });
  assert.equal(inbound.text, "帮我查一下明天的天气");
  assert.equal(inbound.attachments.length, 0);
});

test("buildInboundMessage：voice_item 无文字时给占位文本，消息不被丢弃", () => {
  const inbound = buildInboundMessage({
    from_user_id: "wxid_voice",
    item_list: [{ type: 3, voice_item: {} }],
  });
  assert.match(inbound.text, /语音消息 — 未能识别文字/);
  assert.equal(inbound.attachments.length, 0);
});

test("微信语音消息：先回识别文字到微信，再派发给 AI（顺序正确）", { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-voice-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dispatched = [];
  const adapter = pollAdapter(t, [{ from_user_id: "wxid_voice", item_list: [
    { type: 3, voice_item: { text: "帮我查一下明天的天气" } },
  ] }], {
    dataDir: dir,
    onMessage: async msg => {
      // 派发时 sendmessage 应该已经发出去了
      const sendReq = adapter.requests.find(req => req.url.endsWith("/sendmessage"));
      assert.ok(sendReq, "语音确认文字应先于派发发回微信");
      assert.match(sendReq.body.msg.item_list[0].text_item.text, /已识别语音/);
      dispatched.push(msg);
    },
  });
  await adapter.channel.start();
  await adapter.done;
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].text, "帮我查一下明天的天气");
  assert.equal(dispatched[0].isVoice, true);
  assert.equal(dispatched[0].voiceText, "帮我查一下明天的天气");
});
test("buildInboundMessage：无发送者或无内容返回 null", () => {
  assert.equal(buildInboundMessage({ text: "hi" }), null);
  assert.equal(buildInboundMessage({ from_user_id: "wxid_x" }), null);
});

test("buildSendPayload：CRLF 换行、base_info、context_token 可选", () => {
  const withToken = buildSendPayload({ chatId: "wxid_abc", text: "一\n二\r\n三", contextToken: "ctx-1" });
  assert.equal(withToken.base_info.channel_version, "2.0.0");
  assert.equal(withToken.msg.to_user_id, "wxid_abc");
  assert.equal(withToken.msg.message_type, 2);
  assert.equal(withToken.msg.context_token, "ctx-1");
  assert.equal(withToken.msg.item_list[0].text_item.text, "一\r\n二\r\n三");
  assert.match(withToken.msg.client_id, /^pi-weixin-/);

  const withoutToken = buildSendPayload({ chatId: "wxid_abc", text: "hi" });
  assert.equal("context_token" in withoutToken.msg, false);
});

function createAdapter(handlers = {}) {
  const requests = [];
  const channel = createWeixinChannel({
    botToken: "BT",
    dataDir: os.tmpdir(),
    onMessage: () => {},
    requestJson: async (options) => {
      requests.push(options);
      const pathSuffix = options.url.replace("https://ilinkai.weixin.qq.com/ilink/bot", "");
      const handler = handlers[pathSuffix];
      return handler ? handler(options) : { status: 200, data: { ret: 0 } };
    },
  });
  return { channel, requests };
}

test("sendText：POST /sendmessage，Bearer 头与 base_info 包装", async () => {
  const { channel, requests } = createAdapter();
  const result = await channel.sendText("wxid_abc", "回复内容");
  assert.deepEqual(result, { delivered: true });
  const request = requests[0];
  assert.match(request.url, /\/ilink\/bot\/sendmessage$/);
  assert.equal(request.headers.Authorization, "Bearer BT");
  assert.equal(request.headers.AuthorizationType, "ilink_bot_token");
  assert.equal(request.headers["iLink-App-Id"], "bot");
  assert.equal(request.headers["iLink-App-ClientVersion"], "131072");
  assert.equal(request.body.msg.to_user_id, "wxid_abc");
  assert.equal(request.body.base_info.channel_version, "2.0.0");
});

test("sendText：ret 非零返回 delivered:false", async () => {
  const { channel } = createAdapter({
    "/sendmessage": () => ({ status: 200, data: { ret: 1001, errmsg: "token 失效" } }),
  });
  const result = await channel.sendText("wxid_abc", "hi");
  assert.equal(result.delivered, false);
  assert.match(result.reason, /token 失效/);
});

test("sendChoice：iLink 无按钮，渲染为编号文本", async () => {
  const { channel, requests } = createAdapter();
  await channel.sendChoice("wxid_abc", {
    choiceId: "p1",
    title: "Plan 检查点需要批准",
    prompt: "部署计划",
    options: ["批准执行", "拒绝"],
  });
  const text = requests[0].body.msg.item_list[0].text_item.text;
  assert.match(text, /Plan 检查点需要批准/);
  assert.match(text, /1\. 批准执行/);
  assert.match(text, /2\. 拒绝/);
  assert.match(text, /回复序号进行选择。/);
});

test("命令菜单：微信使用 0 取消、数字选项及单行操作提示", async () => {
  const { channel, requests } = createAdapter();
  await channel.sendChoice("wxid_abc", { choiceId: "menu:project", title: "选择项目", prompt: "", options: ["项目甲", "项目乙", "取消"] });
  const text = requests[0].body.msg.item_list[0].text_item.text;
  assert.equal(text, "选择项目\r\n0. 取消\r\n\r\n1. 项目甲\r\n2. 项目乙\r\n\r\n回复数字选择，0 取消。");
});

test("sendTyping：有 typing_ticket 才发 /sendtyping", async () => {
  const withTicket = createAdapter({
    "/getconfig": () => ({ status: 200, data: { ret: 0, typing_ticket: "tk-1" } }),
  });
  await withTicket.channel.sendTyping("wxid_abc");
  assert.equal(withTicket.requests.length, 2);
  assert.match(withTicket.requests[1].url, /\/sendtyping$/);
  assert.deepEqual(withTicket.requests[1].body, {
    base_info: { channel_version: "2.0.0" },
    ilink_user_id: "wxid_abc",
    typing_ticket: "tk-1",
    status: 1,
  });

  const withoutTicket = createAdapter({
    "/getconfig": () => ({ status: 200, data: { ret: 0 } }),
  });
  await withoutTicket.channel.sendTyping("wxid_abc");
  assert.equal(withoutTicket.requests.length, 1, "无 ticket 不得调 sendtyping");
});

test("uploadMedia：明确抛出不支持", async () => {
  const { channel } = createAdapter();
  await assert.rejects(() => channel.uploadMedia("wxid_abc", "C:\\tmp\\a.png"), /暂不支持媒体上传/);
});

test("扫码后 getconfig 返回 412 不阻断启动，首轮拉取成功才连接并保留首批消息和游标", { timeout: 3000 }, async t => {
  const first = deferred();
  const requested = deferred();
  const nextPoll = deferred();
  const statuses = [];
  const requests = [];
  const messages = [];
  const saved = [];
  let polls = 0;
  const adapter = createWeixinChannel({
    botToken: "BT", dataDir: os.tmpdir(),
    loadBuf: async () => "saved-buf",
    saveBuf: async value => { saved.push(value); },
    onMessage: async message => { messages.push(message); },
    onStatus: status => { statuses.push(status); },
    requestJson: async options => {
      requests.push(options);
      if (options.url.endsWith("/getconfig")) return { status: 412, data: null };
      assert.match(options.url, /\/getupdates$/);
      if (polls++ === 0) {
        assert.equal(options.body.get_updates_buf, "saved-buf");
        requested.resolve();
        return first.promise;
      }
      assert.equal(options.body.get_updates_buf, "next-buf");
      nextPoll.resolve();
      return abortWait(options.signal);
    },
  });
  t.after(() => adapter.stop());
  await adapter.start();
  await requested.promise;
  assert.deepEqual(statuses, ["connecting"]);
  first.resolve({ status: 200, data: { ret: 0, msgs: [{ from_user_id: "wxid", message_id: "first", text: "/bind code" }], get_updates_buf: "next-buf" } });
  await nextPoll.promise;
  assert.deepEqual(statuses, ["connecting", "connected"]);
  assert.deepEqual(messages.map(message => message.messageId), ["first"]);
  assert.deepEqual(saved, ["next-buf"]);
  assert.equal(requests.some(options => options.url.endsWith("/getconfig")), false);
});

for (const failure of [
  { label: "HTTP 412", response: { status: 412, data: null }, message: /getupdates.*HTTP 412/ },
  { label: "令牌失效", response: { status: 200, data: { ret: -14, errmsg: "token expired" } }, message: /token expired/ },
  { label: "非 JSON 响应", response: { status: 200, data: null }, message: /getupdates.*invalid JSON/ },
]) {
test(`拉取${failure.label}明确显示连接错误，重试成功后才报 connected`, { timeout: 3000 }, async t => {
  const retry = deferred();
  const failed = deferred();
  const nextPoll = deferred();
  const statuses = [];
  let polls = 0;
  const adapter = createWeixinChannel({
    botToken: "BT", dataDir: os.tmpdir(), onMessage: async () => {},
    onStatus: (status, error) => { statuses.push([status, error]); },
    sleep: async () => { failed.resolve(); await retry.promise; },
    requestJson: async options => {
      assert.match(options.url, /\/getupdates$/);
      if (polls++ === 0) return failure.response;
      if (polls === 2) return { status: 200, data: { ret: 0, msgs: [], get_updates_buf: "buf" } };
      nextPoll.resolve();
      return abortWait(options.signal);
    },
  });
  t.after(() => adapter.stop());
  await adapter.start();
  await failed.promise;
  assert.equal(statuses.some(([status]) => status === "connected"), false);
  assert.equal(statuses.at(-1)[0], "connecting");
  assert.match(statuses.at(-1)[1], failure.message);
  retry.resolve();
  await nextPoll.promise;
  assert.deepEqual(statuses.at(-1), ["connected", undefined]);
  assert.equal(adapter.getDeliveryError(), "");
});
}

test("停止后迟到的首轮拉取响应不能重新连接或处理消息", { timeout: 3000 }, async t => {
  const response = deferred();
  const requested = deferred();
  const statuses = [];
  const adapter = createWeixinChannel({
    botToken: "BT", dataDir: os.tmpdir(),
    onMessage: async () => assert.fail("停止后不能处理消息"),
    onStatus: status => { statuses.push(status); },
    requestJson: async options => { assert.match(options.url, /\/getupdates$/); requested.resolve(); return response.promise; },
  });
  t.after(() => adapter.stop());
  await adapter.start();
  await requested.promise;
  await adapter.stop();
  response.resolve({ status: 200, data: { ret: 0, msgs: [{ from_user_id: "wxid", text: "late" }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, ["connecting", "stopped"]);
});

test("typing 的 getconfig 412 只记录警告，不标记消息投递失败或覆盖真实发送错误", async () => {
  const warnings = [];
  const channel = createWeixinChannel({
    botToken: "BT", onLog: (level, message, data) => { warnings.push({ level, message, data }); },
    requestJson: async options => options.url.endsWith("/getconfig")
      ? { status: 412, data: null }
      : { status: 200, data: { ret: 1001, errmsg: "message rejected" } },
  });
  await channel.sendTyping("wxid");
  assert.equal(channel.getDeliveryError(), "");
  assert.match(warnings[0].data.error, /getconfig.*HTTP 412/);
  assert.equal(warnings[0].level, "warn");
  const sent = await channel.sendText("wxid", "test");
  assert.equal(sent.delivered, false);
  await channel.sendTyping("wxid");
  assert.equal(channel.getDeliveryError(), sent.reason);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function abortWait(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function pollAdapter(t, messages, overrides = {}) {
  const done = deferred();
  const requests = [];
  const saved = [];
  let polls = 0;
  const channel = createWeixinChannel({
    botToken: "bot-secret", dataDir: os.tmpdir(), onMessage: async () => {},
    loadBuf: async () => "before", sleep: async () => {},
    saveBuf: async value => { saved.push(value); done.resolve(); },
    requestJson: async options => {
      requests.push(options);
      if (!options.url.endsWith("/getupdates")) return { status: 200, data: { ret: 0 } };
      if (polls++ === 0) {
        assert.equal(options.body.get_updates_buf, "before");
        return { status: 200, data: { ret: 0, msgs: messages, get_updates_buf: "after" } };
      }
      assert.equal(options.body.get_updates_buf, "after");
      return abortWait(options.signal);
    },
    ...overrides,
  });
  t.after(() => channel.stop());
  return { channel, requests, saved, done: done.promise };
}

test("微信重启后出站和 typing 从持久化上下文加载，加载一次供内存复用", async () => {
  const requests = [];
  const loads = [];
  const channel = createWeixinChannel({
    botToken: "bot-secret",
    loadContextToken: async chatId => { loads.push(chatId); return "stored-context"; },
    requestJson: async options => { requests.push(options); return { status: 200, data: { ret: 0 } }; },
  });
  assert.deepEqual(await channel.sendText("wxid", "重启后回复"), { delivered: true });
  await channel.sendTyping("wxid");
  assert.equal(requests[0].body.msg.context_token, "stored-context");
  assert.equal(requests[1].body.context_token, "stored-context");
  assert.deepEqual(loads, ["wxid"]);
});

test("微信只持久化授权私聊 token，未授权配对可回复，群消息不能污染上下文", { timeout: 3000 }, async t => {
  const persisted = [];
  let authorized = true;
  const adapter = pollAdapter(t, [
    { from_user_id: "wxid", text: "authorized", context_token: "trusted" },
    { from_user_id: "wxid", text: "/bind code", context_token: "pairing" },
    { from_user_id: "wxid", room: "room", text: "group", context_token: "group-token" },
  ], {
    isAuthorized: async (chatId, userId) => { assert.equal(chatId, "wxid"); assert.equal(userId, "wxid"); return authorized; },
    saveContextToken: async (chatId, token) => { persisted.push([chatId, token]); },
    loadContextToken: async () => assert.fail("入站内存 token 应优先于 load"),
    onMessage: async inbound => {
      if (inbound.meta.chatType === "group") assert.equal(inbound.meta.contextToken, undefined);
      else assert.ok(inbound.meta.contextToken);
      await adapter.channel.sendText(inbound.chatId, "reply");
      authorized = false;
    },
  });
  await adapter.channel.start();
  await adapter.done;
  assert.deepEqual(persisted, [["wxid", "trusted"]]);
  assert.deepEqual(adapter.requests.filter(options => options.url.endsWith("/sendmessage")).map(options => options.body.msg.context_token), ["trusted", "pairing", "pairing"]);
});

test("微信不提供授权回调时默认不持久化入站 token", { timeout: 3000 }, async t => {
  const adapter = pollAdapter(t, [{ from_user_id: "wxid", text: "/bind code", context_token: "untrusted" }], {
    saveContextToken: async () => assert.fail("未授权不能保存"),
  });
  await adapter.channel.start();
  await adapter.done;
  assert.deepEqual(adapter.saved, ["after"]);
});

test("微信持久化 token 失效明确返回 deliveryError，错误隐藏 bot 和上下文凭据", async () => {
  const channel = createWeixinChannel({
    botToken: "bot-secret", loadContextToken: async () => "stored-context",
    requestJson: async () => ({ status: 200, data: { ret: 1001, errmsg: "context expired: stored-context bot-secret" } }),
  });
  const result = await channel.sendText("wxid", "hello");
  assert.equal(result.delivered, false);
  assert.match(result.reason, /context expired/);
  assert.doesNotMatch(result.reason, /stored-context|bot-secret/);
  assert.equal(channel.getDeliveryError(), result.reason);
});

test("微信附件临时失败保留批次重试、不确认游标、不派发残缺文本或重放前条", { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inbound = [];
  const logs = [];
  let downloads = 0;
  const adapter = pollAdapter(t, [
    { from_user_id: "wxid", message_id: 1, text: "first" },
    { from_user_id: "wxid", message_id: 2, text: "analyze", attachments: [
      { kind: "file", filename: "first.txt", data_base64: "YQ==" },
      { kind: "file", filename: "../report.pdf", mime_type: "application/pdf", url: "https://cdn.example/file?key=raw-secret", size: 100 },
    ] },
  ], {
    dataDir: dir,
    onMessage: async msg => { inbound.push(msg); },
    onLog: (level, message, data) => { logs.push(data); },
    sleep: async () => {
      assert.deepEqual(adapter.saved, []);
      assert.deepEqual(fs.readdirSync(path.join(dir, "attachments")), []);
      assert.deepEqual(inbound.map(msg => msg.messageId), ["1"]);
    },
    request: async options => {
      if (downloads++ === 0) throw new Error(`timeout bot-secret ${options.url}`);
      return { status: 200, buffer: Buffer.from("pdf bytes") };
    },
  });
  await adapter.channel.start();
  await adapter.done;
  assert.equal(downloads, 2);
  assert.deepEqual(inbound.map(msg => msg.messageId), ["1", "2"]);
  assert.deepEqual(adapter.saved, ["after"]);
  assert.doesNotMatch(JSON.stringify(logs), /bot-secret|raw-secret/);
  const attachment = inbound[1].attachments[1];
  assert.deepEqual(attachment, { path: attachment.path, kind: "file", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 9 });
  assert.equal(path.dirname(attachment.path), path.join(dir, "attachments"));
  assert.deepEqual(inbound[1].images, inbound[1].attachments.map(value => value.path));
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 2);
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "pdf bytes");
});

test("微信 AES 图片入站保留图片 MIME 与解密后实际大小", { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-image-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let inbound;
  const adapter = pollAdapter(t, [{ from_user_id: "wxid", item_list: [{ image_item: {
    filename: "photo.png", mime_type: "image/png", aes_key: AES_KEY_HEX,
    data_base64: encryptAesEcb(Buffer.from("png bytes")).toString("base64"),
  } }] }], { dataDir: dir, onMessage: async msg => { inbound = msg; } });
  await adapter.channel.start();
  await adapter.done;
  const attachment = inbound.attachments[0];
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.filename, "photo.png");
  assert.equal(attachment.sizeBytes, 9);
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "png bytes");
});

test("微信超限大小或条数整体拒绝并确认，不执行附带文本", { timeout: 3000 }, async t => {
  for (const attachments of [
    [{ filename: "large.pdf", size: 6 * 1024 * 1024, url: "https://cdn.example/large" }],
    Array.from({ length: 5 }, (_, i) => ({ filename: `file-${i}`, data_base64: "YQ==" })),
  ]) {
    await t.test(`reject ${attachments.length} attachments`, async sub => {
      const adapter = pollAdapter(sub, [{ from_user_id: "wxid", text: "do not execute", context_token: "ctx", attachments }], {
        onMessage: async () => assert.fail("超限消息不能执行"),
        request: async () => assert.fail("不能下载已知超限附件"),
      });
      await adapter.channel.start();
      await adapter.done;
      const notice = adapter.requests.find(options => options.url.endsWith("/sendmessage"));
      assert.match(notice.body.msg.item_list[0].text_item.text, /附件无法接收.*上限/);
      assert.deepEqual(adapter.saved, ["after"]);
    });
  }
});

test("微信拒绝通知发送失败时保留 update，通知成功后才确认游标", { timeout: 3000 }, async t => {
  let sends = 0;
  let polls = 0;
  const saved = [];
  const done = deferred();
  const channel = createWeixinChannel({
    botToken: "bot-secret", onMessage: async () => assert.fail("不能派发"),
    sleep: async () => assert.deepEqual(saved, []),
    saveBuf: async value => { saved.push(value); done.resolve(); },
    requestJson: async options => {
      if (options.url.endsWith("/sendmessage")) return { status: 200, data: { ret: sends++ === 0 ? 1001 : 0 } };
      if (options.url.endsWith("/getconfig")) return { status: 200, data: { ret: 0 } };
      if (polls++ === 0) return { status: 200, data: { msgs: [{ from_user_id: "wxid", text: "ignore", attachments: [{ filename: "large", size: 6 * 1024 * 1024, url: "https://cdn.example/large" }] }], get_updates_buf: "after" } };
      return abortWait(options.signal);
    },
  });
  t.after(() => channel.stop());
  await channel.start();
  await done.promise;
  assert.equal(sends, 2);
  assert.deepEqual(saved, ["after"]);
});

test("微信原始媒体类型优先保留，音视频标签和文件图像 MIME 独立表达", () => {
  const inbound = buildInboundMessage({ from_user_id: "wxid", attachments: [
    { kind: "file", filename: "photo.png", mime_type: "image/png", data_base64: "YQ==" },
    { audio_item: { filename: "voice.ogg", mime_type: "audio/ogg", data_base64: "YQ==" } },
    { video_item: { filename: "clip.mp4", mime_type: "video/mp4", data_base64: "YQ==" } },
  ] });
  assert.deepEqual(inbound.attachments.map(({ kind, filename, mimeType }) => ({ kind, filename, mimeType })), [
    { kind: "file", filename: "photo.png", mimeType: "image/png" },
    { kind: "audio", filename: "voice.ogg", mimeType: "audio/ogg" },
    { kind: "video", filename: "clip.mp4", mimeType: "video/mp4" },
  ]);
});

test("微信实际下载字节超限也拒绝并确认，不派发附带文本", { timeout: 3000 }, async t => {
  const adapter = pollAdapter(t, [{ from_user_id: "wxid", text: "不能执行", attachments: [
    { filename: "large.bin", url: "https://cdn.example/large" },
  ] }], {
    onMessage: async () => assert.fail("实际大小超限不能执行文本"),
    request: async () => ({ status: 200, buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }),
  });
  await adapter.channel.start();
  await adapter.done;
  const notice = adapter.requests.find(options => options.url.endsWith("/sendmessage"));
  assert.match(notice.body.msg.item_list[0].text_item.text, /附件无法接收.*上限/);
  assert.deepEqual(adapter.saved, ["after"]);
});

test("首轮成功后连续 HTTP 412 保留游标、展示脱敏原因并退避，恢复成功清除错误", { timeout: 5000 }, async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      seen.push({ headers: req.headers, body: JSON.parse(bytes.toString("utf8")), length: bytes.length });
      const success = seen.length === 1 || seen.length === 5;
      res.writeHead(success ? 200 : 412, { "Content-Type": "application/json" });
      res.end(JSON.stringify(success
        ? { ret: 0, msgs: [], get_updates_buf: seen.length === 1 ? "first-buf" : "recovered-buf" }
        : { ret: 451, errmsg: "request rejected token=secret-token; https://example.com/private", private_body: "NEVER-FORWARD" }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const done = deferred();
  const delays = [];
  const statuses = [];
  const saved = [];
  const adapter = createWeixinChannel({
    botToken: "secret-token", onMessage: async () => {},
    onStatus: (status, error) => statuses.push({ status, error }),
    saveBuf: async value => saved.push(value),
    requestJson: options => requestJson({ ...options, url: `http://127.0.0.1:${server.address().port}/ilink/bot/getupdates` }),
    sleep: async ms => {
      delays.push(ms);
      if (delays.length === 4) { await adapter.stop(); done.resolve(); }
    },
  });
  t.after(() => adapter.stop());
  await adapter.start();
  await done.promise;
  assert.deepEqual(delays, [2000, 2000, 30000, 2000]);
  assert.deepEqual(saved, ["first-buf", "recovered-buf"]);
  assert.deepEqual(seen.map(item => item.body.get_updates_buf), ["", "first-buf", "first-buf", "first-buf", "first-buf", "recovered-buf"]);
  for (const item of seen) {
    assert.equal(item.headers["ilink-app-id"], "bot");
    assert.equal(item.headers["ilink-app-clientversion"], "131072");
    assert.equal(item.headers["content-length"], String(item.length));
    assert.equal(item.headers["transfer-encoding"], undefined);
  }
  const errors = statuses.filter(item => item.error);
  assert.equal(statuses.filter(item => item.status === "connected").length, 2);
  assert.match(errors[0].error, /getupdates.*HTTP 412.*ret=451.*request rejected/);
  assert.match(errors[2].error, /30 秒后重试/);
  assert.doesNotMatch(JSON.stringify(errors), /secret-token|example\.com|NEVER-FORWARD/);
  assert.equal(statuses[5].status, "connected");
  assert.equal(statuses[5].error, undefined);
  assert.equal(adapter.getDeliveryError(), "");
});
