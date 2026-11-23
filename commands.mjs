/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { ApplicationCommandOptionType, ApplicationCommandType, InteractionResponseType,
  InteractionType, MessageFlags, PermissionFlagsBits, Routes } from 'discord.js';
import { allowedChannel, snowflake } from './transport.mjs';

const subcommands = [
  ['status', '查看鲸鲸在当前位置的回应状态'],
  ['pause', '暂停鲸鲸在当前位置接收新的聊天消息'],
  ['resume', '恢复鲸鲸在当前位置接收新的聊天消息']
];
const definition = {
  name: 'whale', description: '管理 WhaleLife 在当前频道或讨论串的回应',
  type: ApplicationCommandType.ChatInput, contexts: [0], integration_types: [0],
  options: subcommands.map(([name, description]) => ({
    type: ApplicationCommandOptionType.Subcommand, name, description
  }))
};

export async function registerCommand(rest, account, signal) {
  const route = Routes.applicationCommands(account);
  const existing = (await rest.get(route, { signal })).find(
    item => item.name === definition.name && item.type === definition.type);
  if (existing) {
    const matches = existing.description === definition.description &&
      existing.options?.length === subcommands.length &&
      definition.options.every(expected => existing.options.some(option =>
        option.type === expected.type && option.name === expected.name && !option.options?.length));
    if (!matches) throw Error('此 Bot 已有其他用途的 /whale 命令');
    return existing.id;
  }
  const created = await rest.post(route, { body: definition, signal });
  if (!snowflake(created.id)) throw Error('Discord 未确认命令注册');
  return created.id;
}

export async function handleCommand(event, { rest, commandId, account, signal, serial, getConfig, channelManager, savePaused }) {
  if (!commandId || event.type !== InteractionType.ApplicationCommand || event.application_id !== account ||
      event.data?.id !== commandId || event.data.type !== definition.type || event.data.name !== 'whale' ||
      !snowflake(event.id) || !event.token) return;

  // Begin the three-second acknowledgement immediately. Apply accepted actions in arrival order.
  const ack = rest.post(Routes.interactionCallback(event.id, event.token), {
    auth: false, signal, body: { type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral } }
  }).then(() => true, () => false);
  const result = await serial(async () => {
    if (!await ack) return;
    signal.throwIfAborted();
    const channel = event.channel_id;
    const config = getConfig();
    if (!snowflake(event.guild_id) || !snowflake(channel) || !await allowedChannel(config, event.guild_id, channel, channelManager))
      return '此位置未在 WhaleLife 的允许频道列表中。';
    const option = event.data.options?.[0];
    if (event.data.options?.length !== 1 || option.type !== ApplicationCommandOptionType.Subcommand ||
        !subcommands.some(([name]) => name === option.name)) return '请重新选择 /whale 子命令。';
    const key = account + ':' + channel;
    const paused = config.pausedRoutes.includes(key);
    if (option.name === 'status') return paused ? '鲸鲸已暂停回应当前位置的新消息。' : '鲸鲸会回应当前位置直接 @ 她或回复她的消息。';
    const permissions = event.member?.permissions;
    const required = PermissionFlagsBits.ManageChannels | PermissionFlagsBits.Administrator;
    if (!snowflake(event.member?.user?.id) || typeof permissions !== 'string' || !/^\d{1,24}$/.test(permissions) ||
        !(BigInt(permissions) & required)) return '需要当前位置的「管理频道」权限。';
    const pause = option.name === 'pause';
    if (paused !== pause) {
      const next = pause ? [...config.pausedRoutes, key] : config.pausedRoutes.filter(item => item !== key);
      try { await savePaused(next); }
      catch { return '保存失败，请重试或在 WhaleLife 控制台检查插件。'; }
    }
    return pause ? '已暂停当前位置的新消息。使用 /whale resume 恢复。' : '已恢复。直接 @鲸鲸 或回复她的消息即可聊天。';
  });
  if (result) await rest.patch(Routes.webhookMessage(account, event.token), {
    auth: false, signal, body: { content: result, allowed_mentions: { parse: [] } }
  });
}
