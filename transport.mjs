/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';

export const snowflake = value => typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value);

// Only the immediate reply snapshot delivered by Discord belongs to this turn.
function replyText(data, question, botId) {
  if (data.type !== 19) return question;
  const ref = data.message_reference;
  const original = data.referenced_message;
  const author = original?.author;
  const sameLocation = location =>
    (location.channel_id === undefined || location.channel_id === data.channel_id) &&
    (location.guild_id === undefined || location.guild_id === data.guild_id);
  const available = ref && (ref.type === undefined || ref.type === 0) && original &&
    snowflake(ref.message_id) && original.id === ref.message_id &&
    original.channel_id === data.channel_id && sameLocation(ref) && sameLocation(original) &&
    snowflake(author?.id) && (data.guild_id || author.id === data.author.id || author.id === botId) &&
    typeof original.content === 'string' && original.content.trim();
  if (!available) return '【Discord 回复：原消息文字不可用】\n' + question;

  const content = [...original.content.trim()];
  const quote = {
    作者: String(original.member?.nick || author.global_name || author.username || author.id).slice(0, 80),
    作者ID: author.id,
    正文: content.slice(0, 1500).join('') + (content.length > 1500 ? '…（已截断）' : '')
  };
  if (author.id === botId) quote.作者身份 = '当前 Discord Bot';
  return '【Discord 引用原文】' + JSON.stringify(quote) + '\n【当前发言】' + question;
}

export function incoming(data, botId, config) {
  if (![0, 19].includes(data.type) || data.webhook_id || data.author?.bot ||
      data.author?.system || data.author?.id === botId || !snowflake(data.author?.id) ||
      !snowflake(data.id) || !snowflake(data.channel_id) || typeof data.content !== 'string') return;
  let text = data.content.trim();
  let peer;
  if (data.guild_id === undefined) {
    if (data.author.id !== config.owner) return;
    peer = 'dm:' + data.author.id;
  } else {
    if (!snowflake(data.guild_id) || !config.channels.includes(data.channel_id) ||
        !data.mentions?.some(user => user.id === botId)) return;
    const mention = new RegExp('<@!?' + botId + '>', 'g');
    if (!mention.test(text)) return;
    text = text.replace(mention, '').trim();
    peer = 'guild:' + data.guild_id + ':' + data.channel_id;
  }
  if (!text) return;
  const nickname = data.member?.nick || data.author.global_name || data.author.username;
  return { peer, sender: data.author.id, messageId: data.id, text: replyText(data, text, botId),
    ...(nickname && { senderProfile: { nickname } }) };
}

// Discord measures the maximum message length in UTF-16 units. Keep surrogate pairs intact.
export function splitText(text) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > 2000) {
    let end = 2000;
    if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
    const window = rest.slice(0, end);
    const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    if (boundary >= end / 2) end = boundary + 1;
    const part = rest.slice(0, end);
    if (part.trim()) parts.push(part);
    rest = rest.slice(end);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

export async function deliver(rest, message, config, account, signal) {
  signal.throwIfAborted();
  if (account !== message.account) throw Error('Bot 账号已变更');
  const [kind, first, second, extra] = message.peer.split(':');
  let channelId;
  if (kind === 'dm' && snowflake(first) && first === config.owner && second === undefined) {
    const dm = await rest.post('/users/@me/channels', { body: { recipient_id: first }, signal });
    if (dm.type !== 1 || !snowflake(dm.id) || !dm.recipients?.some(user => user.id === first))
      throw Error('未确认私信收件人');
    channelId = dm.id;
  } else if (kind === 'guild' && snowflake(first) && snowflake(second) &&
             config.channels.includes(second) && extra === undefined) {
    channelId = second;
  } else throw Error('目的地不在当前允许范围内');
  const parts = splitText(message.text);
  if (!parts.length) throw Error('没有可发送的文字');
  for (const [index, content] of parts.entries()) {
    signal.throwIfAborted();
    const nonce = createHash('sha256').update(JSON.stringify([message.deliveryId, index])).digest('hex').slice(0, 24);
    const body = { content, nonce, enforce_nonce: true, allowed_mentions: { parse: [], replied_user: false } };
    if (!index && snowflake(message.replyTo)) {
      body.message_reference = { message_id: message.replyTo, fail_if_not_exists: false };
    }
    try {
      const result = await rest.post('/channels/' + channelId + '/messages', { body, signal });
      if (!snowflake(result?.id) || result.channel_id !== channelId) throw Error();
    } catch {
      throw Error('Discord 未确认第 ' + (index + 1) + '/' + parts.length + ' 段，已确认 ' + index + ' 段；请核对实际消息');
    }
  }
}
