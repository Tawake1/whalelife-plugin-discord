/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { Events } from 'discord.js';
import { deliver, incoming, snowflake } from './transport.mjs';
import { registerCommand, handleCommand } from './commands.mjs';
import { setupPage } from './settings.mjs';

const defaults = { enabled: false, token: '', owner: '', channels: [], pausedRoutes: [], persona: 'whale', revision: '' };

export function validate(config) {
  if (typeof config.enabled !== 'boolean' || typeof config.persona !== 'string' || !config.persona.trim() ||
      typeof config.token !== 'string' || config.token.length > 512 || /\s/.test(config.token) ||
      (config.owner !== '' && !snowflake(config.owner)) || !Array.isArray(config.channels) ||
      config.channels.length > 256 || !config.channels.every(snowflake)) throw Error('请检查人格、用户 ID 和频道 ID。');
  if (config.pausedRoutes !== undefined && (!Array.isArray(config.pausedRoutes) ||
      !config.pausedRoutes.every(key => typeof key === 'string' && /^[1-9]\d{16,19}:[1-9]\d{16,19}$/.test(key))))
    throw Error('频道暂停记录无效。');
  if (config.enabled && (!config.token || !(config.owner || config.channels.length)))
    throw Error('连接前请填写 Bot Token，以及至少一个私信用户或频道 ID。');
  return config;
}

export async function startPlugin(ctx, makeClient) {
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
    const client = makeClient();
    const run = { client, controller: new AbortController(), account: '', handle: null };
    active = run;
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
              return deliver(client.rest, message, current, user.id, AbortSignal.any([signal, options.signal]));
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
          getConfig: () => config,
          savePaused: async pausedRoutes => {
            const next = { ...config, pausedRoutes };
            await ctx.config.save('config.json', next);
            config = next;
          }
        });
      } else if (packet.t === 'MESSAGE_CREATE' && run.handle) {
        if (packet.d.guild_id && config.pausedRoutes.includes(run.account + ':' + packet.d.channel_id)) return;
        const input = incoming(packet.d, run.account, current);
        if (!input) return;
        if (run.handle.supportsSenderProfile !== true) delete input.senderProfile;
        const result = await run.handle.receive(input, { signal });
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

  ctx.effect(() => stop);
  setupPage(ctx, {
    state: () => ({ config, status: [status, active?.commandNotice].filter(Boolean).join(' · '), account: active?.account || '', personas: ctx.personas.list() }),
    save: (revision, fields) => serial(async () => {
      if (revision !== config.revision) throw Error('配置已变更，请刷新后再保存。');
      const next = validate({ ...fields, pausedRoutes: config.pausedRoutes, token: fields.token || config.token, revision: randomUUID() });
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
