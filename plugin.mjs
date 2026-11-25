/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Events } from 'discord.js';
import { allowedChannel, deliver, incoming, snowflake, startImageTyping } from './transport.mjs';
import { registerCommand, handleCommand } from './commands.mjs';
import { attachmentHint, describePictures, hostImageLimitMiB, imageAttachments, imageLimitFor, imageNote, maxImageLimitMiB, validImageLimit } from './images.mjs';
import { expiredImage, scheduleReceiptCleanup } from './receipts.mjs';
import { incomingTurns, defaultQuietMs, minQuietMs, maxQuietMs } from './incoming-turns.mjs';
import { setupPage } from './settings.mjs';

const defaults = { enabled: false, dmDebounce:true, dmQuietMs:defaultQuietMs, channelMerge:true, token: '', owner: '', channels: [], pausedRoutes: [], inheritThreads: false, replyIntent: false, imageReasoning: 'auto', imageTimeout: 120, imageModel: '', imageMode: 'auto', imageLimitsMiB: {}, persona: 'whale', revision: '' };

export function validate(config) {
  if (typeof config.enabled !== 'boolean' || typeof config.persona !== 'string' || !config.persona.trim() ||
      typeof config.token !== 'string' || config.token.length > 512 || /\s/.test(config.token) ||
      (config.owner !== '' && !snowflake(config.owner)) || !Array.isArray(config.channels) ||
      config.channels.length > 256 || !config.channels.every(snowflake)) throw Error('请检查人格、用户 ID 和频道 ID。');
  if (config.pausedRoutes !== undefined && (!Array.isArray(config.pausedRoutes) ||
      !config.pausedRoutes.every(key => typeof key === 'string' && /^[1-9]\d{16,19}:[1-9]\d{16,19}$/.test(key))))
    throw Error('频道暂停记录无效。');
  if (config.imageMode !== undefined && !['auto','describe','off'].includes(config.imageMode))
    throw Error('请选择有效的图片处理方式。');
  if (config.imageMode === 'describe' && !config.imageModel) throw Error('始终转述需要先选择图片识别模型。');
  if (config.imageModel !== undefined && (typeof config.imageModel !== 'string' || config.imageModel.length > 200))
    throw Error('图片识别模型 ID 无效。');
  if (config.imageLimitsMiB !== undefined && (!config.imageLimitsMiB || typeof config.imageLimitsMiB !== 'object' ||
      Array.isArray(config.imageLimitsMiB) || !Object.values(config.imageLimitsMiB).every(validImageLimit)))
    throw Error('单图上限可设置为 0.1 至 ' + maxImageLimitMiB + ' MiB，最多一位小数。');
  if (config.imageTimeout !== undefined && (!Number.isInteger(config.imageTimeout) || config.imageTimeout < 30 || config.imageTimeout > 300))
    throw Error('识图超时可设置为 30 至 300 秒。');
  if (config.imageReasoning !== undefined && !['auto','none','model'].includes(config.imageReasoning))
    throw Error('请选择有效的识图思考模式。');
  if (!Number.isInteger(config.dmQuietMs ?? defaultQuietMs) || (config.dmQuietMs ?? defaultQuietMs) < minQuietMs || (config.dmQuietMs ?? defaultQuietMs) > maxQuietMs)
    throw Error('私信等待时间须为 ' + minQuietMs + ' 至 ' + maxQuietMs + ' 之间的整数毫秒。');
  for (const flag of ['inheritThreads','replyIntent','dmDebounce','channelMerge'])
    if (config[flag] !== undefined && typeof config[flag] !== 'boolean') throw Error('频道设置无效。');
  if (config.enabled && (!config.token || !(config.owner || config.channels.length)))
    throw Error('连接前请填写 Bot Token，以及至少一个私信用户或频道 ID。');
  return config;
}

const loginRetrySeconds = [5, 15, 45];

function connectionCode(error) {
  for (const value of [error?.code, error?.cause?.code]) {
    if (Number.isFinite(value) || (typeof value === 'string' && value.trim())) return String(value).slice(0, 128);
  }
  return '';
}

export async function startPlugin(ctx, makeClient, downloadImage = fetch) {
  const saved = await ctx.config.read();
  const legacyMode = saved.imageModel ? 'describe' : 'off';
  let config = { ...defaults, imageMode: Object.keys(saved).length ? legacyMode : 'auto', ...saved };
  let status = '未连接';
  let active;
  let retryTimer;
  let lastError = '';
  function reportError(label, error, fallback = '') {
    const code = connectionCode(error) || fallback || '未提供';
    lastError = label + ' · 错误码 ' + code;
    ctx.logger.warn(label, {code});
  }
  let tail = Promise.resolve();
  const serial = fn => {
    const next = tail.then(() => { ctx.signal.throwIfAborted(); return fn(); });
    tail = next.catch(() => {});
    return next;
  };

  async function stop() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const old = active;
    active = undefined;
    if (!old) return;
    old.controller.abort();
    try { old.handle?.dispose(); }
    finally { await old.client.destroy(); }
  }

  async function restart(attempt = 0) {
    await stop();
    ctx.signal.throwIfAborted();
    connect(attempt);
  }

  function connect(attempt = 0) {
    if (!config.enabled) { status = '连接已关闭'; return; }
    const client = makeClient(config);
    const run = { client, controller: new AbortController(), account: '', handle: null };
    active = run;
    let activeImages = 0;
    const nativeQuestions = new Map();
    const signal = AbortSignal.any([ctx.signal, run.controller.signal]);
    run.turns = incomingTurns(() => run.handle, signal, () => {
      if (!signal.aborted) ctx.logger.warn('Discord 来信处理未完成');
    });
    const current = config;
    status = attempt ? '正在重试登录（' + attempt + '/' + loginRetrySeconds.length + '）' : '正在连接';
    const setStatus = value => { if (!signal.aborted) status = value; };
    const connectionFailed = (label, error) => {
      if (signal.aborted) return;
      run.lastCode = connectionCode(error) || run.lastCode;
      reportError(label, error, run.lastCode);
      setStatus(label);
    };
    client.on(Events.Error, error => connectionFailed('Discord 连接异常', error));
    client.on(Events.ShardError, error => connectionFailed('Discord 网关连接异常', error));
    client.on(Events.ShardReconnecting, () => setStatus('正在重连'));
    client.on(Events.ShardResume, () => setStatus('已连接'));
    client.on(Events.ShardDisconnect, event => connectionFailed('Discord 网关连接已断开', event));
    async function dispatch(packet) {
      if (signal.aborted) return;
      if (packet.t === 'READY') {
        const user = packet.d.user;
        if (!user?.bot || !snowflake(user.id)) throw Error('无效的 Bot 身份');
        if (run.handle && run.account !== user.id) throw Error('连接账号发生变化');
        if (!run.handle) {
          run.handle = ctx.channels.register({
            id: 'discord', name: 'Discord', account: user.id, persona: current.persona, permission: 'off',
            ...(current.imageMode === 'auto' && current.imageModel && {
              async describeImages({messageId, images}, options) {
                const context = nativeQuestions.get(messageId);
                if (!context || context.numbers.length !== images.length) throw Error('原图上下文已失效，请重发。');
                if (activeImages >= 3) throw Error('辅助识图正忙，请稍后重发。');
                activeImages++;
                try {
                  const answer = await describePictures(ctx, {
                    model:current.imageModel, reasoning:current.imageReasoning, timeoutSeconds:current.imageTimeout,
                    signal:AbortSignal.any([signal, options.signal])
                  }, context.question, images.map((image,i) => ({number:context.numbers[i], image})));
                  if (answer.state !== 'done') throw Error(answer.note);
                  return answer.note;
                } finally { activeImages--; }
              }
            }),
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
          catch (error) {
            if (!signal.aborted) {
              reportError('频道命令注册失败', error);
              run.commandNotice = '请检查应用命令授权和 /whale 同名冲突，再点「重新连接」。';
            }
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
        const listed = current.channels.includes(packet.d.channel_id);
        const checkParent = Boolean(packet.d.guild_id && !listed && current.inheritThreads);
        // Reserve the peer queue before looking up a thread. Inherited routes are
        // checked inside submit, before sending hints, reading images or calling receive.
        const supported = imageAttachments(packet.d);
        const direct = current.imageMode === 'auto' && run.handle.supportsImageInput === true;
        const canRead = current.imageMode !== 'off' && (direct || Boolean(current.imageModel));
        const limitMiB = direct && !current.imageModel ? hostImageLimitMiB : imageLimitFor(config.imageLimitsMiB, current.imageModel);
        const images = canRead ? supported : [];
        if (supported.length && expiredImage(packet.d.id)) return;
        const hint = supported.length && current.imageMode === 'auto' && !canRead
          ? '当前宿主需要辅助模型转述图片。请选择图片识别模型，或升级至 WhaleLife v0.1.5 后重发。'
          : attachmentHint(packet.d.attachments, supported, canRead);
        const textInput = incoming(packet.d, run.account, current, '', listed || checkParent);
        if (!textInput && !images.length && !hint) return;
        const input = textInput ?? incoming(packet.d, run.account, current, '请看看这张图。', listed || checkParent);
        if (!input) return;
        const sendImageStatus = (text, kind = 'status') => deliver(client.rest, {account: run.account, peer: input.peer, text,
          replyTo: input.messageId, deliveryId: 'discord-image-' + kind + ':' + input.messageId}, current, run.account, signal, client.channels);
        if (run.handle.supportsSenderProfile !== true) delete input.senderProfile;
        let fallbackContext;
        const mode = packet.d.guild_id ? (config.channelMerge ? 'live' : 'single') : (config.dmDebounce ? 'quiet' : 'single');
        run.turns.add({input, question:textInput?.text || '',
          async prepare(batchQuestion) {
            signal.throwIfAborted();
            if (checkParent) {
              const allowed = await allowedChannel(current, packet.d.guild_id, packet.d.channel_id, client.channels);
              if (!allowed || signal.aborted) return;
            }
            if (hint) {
              const notice = sendImageStatus(hint);
              if (!textInput) { await notice; return; }
              void notice.catch(() => { if (!signal.aborted) ctx.logger.warn('Discord 附件提示发送失败'); });
            }
            if (images.length) {
              const busy = activeImages >= 3;
              if (!busy) activeImages++;
              let recognition;
              try {
                recognition = await imageNote({ctx, account:run.account, channel:packet.d.channel_id,
                  input:batchQuestion ? {...input, text:batchQuestion} : input, images, attachments:packet.d.attachments, sendAttachmentNotice:text => sendImageStatus(text, 'size'),
                  model:current.imageModel, direct, limitMiB, reasoning:current.imageReasoning, timeoutSeconds:current.imageTimeout, signal, busy, download:downloadImage,
                  startTyping: () => startImageTyping(client.rest, packet.d.channel_id, signal)});
              } finally { if (!busy) activeImages--; }
              if (recognition.skippedAll && !textInput) return;
              if (recognition.retryable) {
                // Keep this ID free in the host so a replay can submit the completed observation.
                await sendImageStatus(recognition.note);
                return;
              }
              if (recognition.native) {
                input.images = recognition.native.map(p => p.image);
                const question = textInput?.text || '';
                input.text = [question, recognition.note].filter(Boolean).join('\n');
                if (current.imageModel && !nativeQuestions.has(input.messageId)) {
                  fallbackContext = {numbers:recognition.native.map(p => p.number), question:batchQuestion || question};
                  nativeQuestions.set(input.messageId, fallbackContext);
                }
              } else input.text += '\n' + (recognition.note.startsWith('【图片转述】') ? recognition.note : '【Discord 图片】' + recognition.note);
            }
            signal.throwIfAborted();
            return true;
          },
          cleanup() {
            if (fallbackContext && nativeQuestions.get(input.messageId) === fallbackContext) nativeQuestions.delete(input.messageId);
          },
          async finished(result) {
            if (input.images && result.status === 'generation_failed' && !result.duplicate && !signal.aborted) {
              await sendImageStatus(current.imageModel ? '本次主模型未能完成看图，请稍后重发或切到「始终转述」。'
                : '本次主模型未能完成看图。可选择辅助识图模型，以便主模型明确不支持图片时转述。');
            }
            if (result.status !== 'sent' && !signal.aborted)
              ctx.logger.warn('Discord 消息未完成', { messageId: input.messageId, status: result.status });
          }
        }, mode, config.dmQuietMs);
      }
    }
    client.on(Events.Raw, packet => {
      void dispatch(packet).catch(error => {
        if (signal.aborted) return;
        if (packet.t === 'READY') connectionFailed('注册渠道失败，请核对人格并重新连接', error);
        ctx.logger.warn('Discord 事件未完成', { event: packet.t });
      });
    });
    async function login() {
      try {
        await client.login(current.token);
      } catch (error) {
        await serial(async () => {
          if (active !== run || signal.aborted) return;
          reportError('Discord 登录失败', error, run.lastCode);
          await stop();
          if (ctx.signal.aborted) return;
          const seconds = loginRetrySeconds[attempt];
          if (seconds === undefined) {
            status = '登录失败，3 次自动重试已用完。可点「重新连接」。';
            return;
          }
          status = '登录失败，' + seconds + ' 秒后进行第 ' + (attempt + 1) + ' 次重试';
          const timer = setTimeout(() => {
            void serial(() => {
              if (timer !== retryTimer) return;
              retryTimer = undefined;
              connect(attempt + 1);
            }).catch(recoveryFailed);
          }, seconds * 1000);
          retryTimer = timer;
        });
      }
    }
    function recoveryFailed(error) {
      if (ctx.signal.aborted) return;
      status = '连接恢复失败，可点「重新连接」。';
      reportError('Discord 连接恢复失败', error);
    }
    void login().catch(recoveryFailed);
  }

  ctx.effect(() => scheduleReceiptCleanup(ctx));
  ctx.effect(() => stop);
  const connectionState = () => ({
    status: [status, active?.commandNotice].filter(Boolean).join(' · '), lastError,
    online: status === '已连接', enabled: config.enabled,
    account: active?.account || '', canBind: Boolean(active?.handle && config.owner)
  });
  setupPage(ctx, {
    connectionState,
    state: () => ({ config, ...connectionState(), personas: ctx.personas.list(), imageModels: ctx.models.list('chat').filter(m => m.callable) }),
    reconnect: revision => serial(async () => {
      if (revision !== config.revision) throw Error('配置已变更，请刷新后再连接。');
      if (!config.enabled) throw Error('请先启用并保存 Discord 连接。');
      validate(config);
      await restart();
    }),
    save: (revision, fields) => serial(async () => {
      if (revision !== config.revision) throw Error('配置已变更，请刷新后再保存。');
      const next = validate({ ...fields, imageLimitsMiB:config.imageLimitsMiB, pausedRoutes: config.pausedRoutes, token: fields.token || config.token, revision: randomUUID() });
      if (next.imageMode !== 'off' && next.imageModel && !ctx.models.list('chat').some(m => m.id === next.imageModel && m.callable))
        throw Error('请选择已启用、支持图像输入的对话模型。');
      if (!ctx.personas.list().some(p => p.id === next.persona)) throw Error('请选择已存在的人格。');
      // Timing changes take effect on new arrivals without cancelling an in-flight message.
      const policyKeys = ['dmQuietMs','dmDebounce','channelMerge'];
      const policyChanged = policyKeys.some(key => next[key] !== config[key]);
      const reconnect = !policyChanged || Object.keys(next).some(key => key !== 'revision' && !policyKeys.includes(key)
        && !isDeepStrictEqual(next[key], config[key]));
      await ctx.config.save('config.json', next);
      config = next;
      if (reconnect) await restart();
    }),
    saveImageLimit: (revision, model, limitMiB) => serial(async () => {
      if (revision !== config.revision) throw Error('配置已变更，请刷新后再保存。');
      if (!ctx.models.list('chat').some(m => m.callable && m.id === model)) throw Error('所选模型已不可用。');
      const next = validate({...config, imageLimitsMiB:{...config.imageLimitsMiB, [model]:limitMiB}, revision:randomUUID()});
      await ctx.config.save('config.json', next);
      config = next;
    }),
    binding: (action, form) => serial(async () => {
      if (!active?.handle || !config.owner) throw Error('请先连接 Bot 并设置私信用户。');
      if (form.revision !== config.revision || form.account !== active.account) throw Error('连接或配置已变更，请刷新。');
      const peer = 'dm:' + config.owner;
      if (active.turns.busy(peer)) throw Error('私信等待或处理中，请稍后重试绑定。');
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
