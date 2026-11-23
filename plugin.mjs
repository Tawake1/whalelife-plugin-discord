/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { Events } from 'discord.js';
import { addressesBot, allowedChannel, deliver, incoming, snowflake, startImageTyping } from './transport.mjs';
import { registerCommand, handleCommand } from './commands.mjs';
import { attachmentHint, imageAttachments, imageNote } from './images.mjs';
import { expiredImage, scheduleReceiptCleanup } from './receipts.mjs';
import { setupPage } from './settings.mjs';

const defaults = { enabled: false, token: '', owner: '', channels: [], pausedRoutes: [], inheritThreads: false, replyIntent: false, imageReasoning: 'auto', imageTimeout: 120, imageModel: '', persona: 'whale', revision: '' };

export function validate(config) {
  if (typeof config.enabled !== 'boolean' || typeof config.persona !== 'string' || !config.persona.trim() ||
      typeof config.token !== 'string' || config.token.length > 512 || /\s/.test(config.token) ||
      (config.owner !== '' && !snowflake(config.owner)) || !Array.isArray(config.channels) ||
      config.channels.length > 256 || !config.channels.every(snowflake)) throw Error('请检查人格、用户 ID 和频道 ID。');
  if (config.pausedRoutes !== undefined && (!Array.isArray(config.pausedRoutes) ||
      !config.pausedRoutes.every(key => typeof key === 'string' && /^[1-9]\d{16,19}:[1-9]\d{16,19}$/.test(key))))
    throw Error('频道暂停记录无效。');
  if (config.imageModel !== undefined && (typeof config.imageModel !== 'string' || config.imageModel.length > 200))
    throw Error('图片识别模型 ID 无效。');
  if (config.imageTimeout !== undefined && (!Number.isInteger(config.imageTimeout) || config.imageTimeout < 30 || config.imageTimeout > 300))
    throw Error('识图超时可设置为 30 至 300 秒。');
  if (config.imageReasoning !== undefined && !['auto','none','model'].includes(config.imageReasoning))
    throw Error('请选择有效的识图思考模式。');
  for (const flag of ['inheritThreads','replyIntent'])
    if (config[flag] !== undefined && typeof config[flag] !== 'boolean') throw Error('频道设置无效。');
  if (config.enabled && (!config.token || !(config.owner || config.channels.length)))
    throw Error('连接前请填写 Bot Token，以及至少一个私信用户或频道 ID。');
  return config;
}

export async function startPlugin(ctx, makeClient, downloadImage = fetch) {
  let config = { ...defaults, ...await ctx.config.read() };
  let status = '未连接';
  let active;
  let tail = Promise.resolve();
  const serial = fn => {
    const next = tail.then(() => { ctx.signal.throwIfAborted(); return fn(); });
    tail = next.catch(() => {});
    return next;
  };

  async function stop() {
    const old = active;
    active = undefined;
    if (!old) return;
    old.controller.abort();
    try { old.handle?.dispose(); }
    finally { await old.client.destroy(); }
  }

  function connect() {
    if (!config.enabled) { status = '连接已关闭'; return; }
    const client = makeClient(config);
    const run = { client, controller: new AbortController(), account: '', handle: null };
    active = run;
    // Only hold this ordering barrier until submission to the host, not until its model replies.
    run.preparing = new Map();
    let activeImages = 0;
    const signal = AbortSignal.any([ctx.signal, run.controller.signal]);
    const current = config;
    status = '正在连接';
    const setStatus = value => { if (!signal.aborted) status = value; };
    client.on(Events.Error, () => setStatus('Discord 连接异常，请检查网络或重新连接'));
    client.on(Events.ShardError, () => setStatus('Discord 网关连接异常'));
    client.on(Events.ShardReconnecting, () => setStatus('正在重连'));
    client.on(Events.ShardResume, () => setStatus('已连接'));
    client.on(Events.ShardDisconnect, event => setStatus('连接已断开，代码 ' + event.code));
    async function dispatch(packet) {
      if (signal.aborted) return;
      if (packet.t === 'READY') {
        const user = packet.d.user;
        if (!user?.bot || !snowflake(user.id)) throw Error('无效的 Bot 身份');
        if (run.handle && run.account !== user.id) throw Error('连接账号发生变化');
        if (!run.handle) {
          run.handle = ctx.channels.register({
            id: 'discord', name: 'Discord', account: user.id, persona: current.persona, permission: 'off',
            send(message, options) {
              return deliver(client.rest, message, current, user.id, AbortSignal.any([signal, options.signal]), client.channels);
            }
          });
          run.account = user.id;
        }
        setStatus('已连接');
        if (current.channels.length && !run.commandId && !run.registering) {
          run.registering = true;
          try { run.commandId = await registerCommand(client.rest, user.id, signal); }
          catch {
            if (!signal.aborted) run.commandNotice = '频道命令注册失败，请检查应用命令授权和 /whale 同名冲突，再保存设置重连。';
          } finally { run.registering = false; }
          if (run.commandId) run.commandNotice = '';
        }
      } else if (packet.t === 'INTERACTION_CREATE') {
        await handleCommand(packet.d, {
          rest: client.rest, commandId: run.commandId, account: run.account, signal, serial,
          getConfig: () => config, channelManager: client.channels,
          savePaused: async pausedRoutes => {
            const next = { ...config, pausedRoutes };
            await ctx.config.save('config.json', next);
            config = next;
          }
        });
      } else if (packet.t === 'MESSAGE_CREATE' && run.handle) {
        if (packet.d.guild_id && config.pausedRoutes.includes(run.account + ':' + packet.d.channel_id)) return;
        let allowed = false;
        if (packet.d.guild_id) {
          if (!addressesBot(packet.d, run.account) || packet.d.author?.bot || packet.d.webhook_id) return;
          allowed = await allowedChannel(current, packet.d.guild_id, packet.d.channel_id, client.channels);
          if (!allowed || signal.aborted) return;
        }
        const supported = imageAttachments(packet.d);
        const images = current.imageModel ? supported : [];
        if (supported.length && expiredImage(packet.d.id)) return;
        const hint = attachmentHint(packet.d.attachments, supported, current.imageModel);
        const textInput = incoming(packet.d, run.account, current, '', allowed);
        if (!textInput && !images.length && !hint) return;
        const input = textInput ?? incoming(packet.d, run.account, current, '请看看这张图。', allowed);
        if (!input) return;
        const sendImageStatus = (text, kind = 'status') => deliver(client.rest, {account: run.account, peer: input.peer, text,
          replyTo: input.messageId, deliveryId: 'discord-image-' + kind + ':' + input.messageId}, current, run.account, signal, client.channels);
        if (hint) {
          const notice = sendImageStatus(hint);
          if (!textInput) { await notice; return; }
          void notice.catch(() => { if (!signal.aborted) ctx.logger.warn('Discord 附件提示发送失败'); });
        }
        if (run.handle.supportsSenderProfile !== true) delete input.senderProfile;
        const preceding = run.preparing.get(input.peer);
        let receipt;
        if (images.length || preceding) {
          const submit = async () => {
            signal.throwIfAborted();
            if (images.length) {
              const busy = activeImages >= 3;
              if (!busy) activeImages++;
              let recognition;
              try {
                recognition = await imageNote({ctx, account:run.account, channel:packet.d.channel_id,
                  input, images, attachments:packet.d.attachments, sendSizeNotice:text => sendImageStatus(text, 'size'),
                  model:current.imageModel, reasoning:current.imageReasoning, timeoutSeconds:current.imageTimeout, signal, busy, download:downloadImage,
                  startTyping: () => startImageTyping(client.rest, packet.d.channel_id, signal)});
              } finally { if (!busy) activeImages--; }
              if (recognition.skippedAll && !textInput) return;
              if (recognition.retryable) {
                // Keep this ID free in the host so a replay can submit the completed observation.
                await sendImageStatus(recognition.note);
                return;
              }
              input.text += '\n' + (recognition.note.startsWith('【图片转述】') ? recognition.note : '【Discord 图片】' + recognition.note);
            }
            signal.throwIfAborted();
            receipt = run.handle.receive(input, { signal });
            // Mark a synchronous rejection as observed while releasing the ordering barrier.
            Promise.resolve(receipt).catch(() => {});
          };
          const queued = (preceding || Promise.resolve()).catch(() => {}).then(submit);
          run.preparing.set(input.peer, queued);
          try { await queued; }
          finally { if (run.preparing.get(input.peer) === queued) run.preparing.delete(input.peer); }
        } else receipt = run.handle.receive(input, { signal });
        if (!receipt) return;
        const result = await receipt;
        if (result.status !== 'sent' && !signal.aborted)
          ctx.logger.warn('Discord 消息未完成', { messageId: input.messageId, status: result.status });
      }
    }
    client.on(Events.Raw, packet => {
      void dispatch(packet).catch(() => {
        if (signal.aborted) return;
        if (packet.t === 'READY') setStatus('注册渠道失败，请核对人格并重新连接');
        ctx.logger.warn('Discord 事件未完成', { event: packet.t });
      });
    });
    void client.login(current.token).catch(() => setStatus('登录失败，请核对 Token、网络和 Bot 设置后重新连接'));
  }

  ctx.effect(() => scheduleReceiptCleanup(ctx));
  ctx.effect(() => stop);
  setupPage(ctx, {
    state: () => ({ config, status: [status, active?.commandNotice].filter(Boolean).join(' · '), account: active?.account || '', personas: ctx.personas.list(), imageModels: ctx.models.list('chat').filter(m => m.callable) }),
    save: (revision, fields) => serial(async () => {
      if (revision !== config.revision) throw Error('配置已变更，请刷新后再保存。');
      const next = validate({ ...fields, pausedRoutes: config.pausedRoutes, token: fields.token || config.token, revision: randomUUID() });
      if (next.imageModel && !ctx.models.list('chat').some(m => m.id === next.imageModel && m.callable))
        throw Error('请选择已启用、支持图像输入的对话模型。');
      if (!ctx.personas.list().some(p => p.id === next.persona)) throw Error('请选择已存在的人格。');
      await ctx.config.save('config.json', next);
      config = next;
      await stop();
      ctx.signal.throwIfAborted();
      connect();
    }),
    binding: (action, form) => serial(async () => {
      if (!active?.handle || !config.owner) throw Error('请先连接 Bot 并设置私信用户。');
      if (form.revision !== config.revision || form.account !== active.account) throw Error('连接或配置已变更，请刷新。');
      const peer = 'dm:' + config.owner;
      if (active.preparing.has(peer)) throw Error('私信图片处理中，请稍后重试绑定。');
      if (action === 'preview') {
        return { old: (await active.handle.context(peer)).id, target: await ctx.sessions.current() };
      }
      if (!form.old) throw Error('请先查看当前绑定。');
      if (action === 'bind' && (form.target !== await ctx.sessions.current() || form.target.startsWith('ch_')))
        throw Error('请选择独立的网页会话，再重新预览。');
      return active.handle.rebind(peer, { expectedSessionId: form.old, ...(action === 'bind' && { sessionId: form.target }) });
    })
  });
  try { validate(config); connect(); }
  catch { status = '配置无效，请在本页修正并保存'; }
}
