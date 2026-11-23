/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { observationClient } from './vision.mjs';
import { snowflake } from './transport.mjs';

const limit = 2 * 1024 * 1024;
const types = new Set(['image/png', 'image/jpeg', 'image/webp']);
const unread = '图片未能识别，请重新发送图片，或用文字补充。';

export function imageAttachments(data) {
  return Array.isArray(data.attachments) ? data.attachments.filter(a => types.has(a?.content_type)) : [];
}

export function attachmentHint(attachments, supported, model) {
  if (!Array.isArray(attachments)) return '';
  if (supported.length) return model ? '' :
    '图片识别已关闭。请在 WhaleLife 的「插件管理 → Discord → 设置 → 图片识别模型」选择能看图的模型，保存后再发一次。';
  if (attachments.some(file => typeof file?.content_type === 'string' && file.content_type.startsWith('image/')))
    return '这张图的格式暂时读不了。请转成 PNG、JPEG 或 WebP 后再发一次。';
  if (attachments.some(file => file && (!file.content_type || file.content_type === 'application/octet-stream')))
    return '没能确认这个附件的格式。如果是图片，请另存为 PNG、JPEG 或 WebP 后再发一次。';
  return '';
}

class ImageFormatError extends Error {}
class ImageSizeError extends Error {}

async function discordImage(attachment, channel, signal, download) {
  const url = new URL(attachment.url);
  const parts = url.pathname.split('/');
  if (url.origin !== 'https://cdn.discordapp.com' || url.username || url.password ||
      parts.length !== 5 || parts[1] !== 'attachments' || parts[2] !== channel ||
      !snowflake(attachment.id) || parts[3] !== attachment.id || !parts[4])
    throw Error('invalid attachment location');
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > limit)
    throw Error('invalid image size');
  const response = await download(url, { signal, redirect: 'error', credentials: 'omit' });
  if (response.ok && Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ImageSizeError();
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error('download failed');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new ImageSizeError();
    if (size > attachment.size) throw Error('image size mismatch');
    chunks.push(chunk);
  }
  if (size !== attachment.size) throw Error('incomplete image');
  const bytes = Buffer.concat(chunks, size);
  const mime = attachment.content_type;
  const valid = (mime === 'image/png' && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') ||
    (mime === 'image/jpeg' && bytes.subarray(0, 3).toString('hex') === 'ffd8ff') ||
    (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
  if (!valid) throw new ImageFormatError('image format mismatch');
  return 'data:' + mime + ';base64,' + bytes.toString('base64');
}

// Successful observations must stay identical across redelivery because the host deduplicates by message ID.
export async function imageNote({ ctx, account, channel, input, images, attachments = images, sendSizeNotice, model, reasoning = 'model', timeoutSeconds = 120, signal, busy = false, download = fetch, startTyping }) {
  const file = 'image-receipts/' + account + '/' + channel + '/' + input.messageId + '.json';
  const previous = await ctx.config.read(file);
  signal.throwIfAborted();
  async function result(record) {
    if (record.sizeNotice && !record.noticeSent && sendSizeNotice) {
      try {
        await sendSizeNotice(record.sizeNotice);
        await ctx.config.save(file, {...record, noticeSent:true});
      } catch {
        signal.throwIfAborted();
        ctx.logger.warn('Discord 图片大小提示未确认');
      }
    }
    return {note: record.note, retryable:record.state === 'failed', skippedAll:record.state === 'skipped'};
  }
  if (['done','skipped'].includes(previous.state) && typeof previous.note === 'string') return result(previous);
  // Older releases already submitted these exact strings to the host.
  if (previous.state === 'pending') return {note: unread};
  if (previous.state === 'failed' && /^图[1-3]超过 2 MiB，请压缩后重新发送。/.test(previous.note)) return {note:previous.note};

  let note = unread;
  let finishReason = null;
  let state = 'failed';
  const oversized = [];
  const eligible = [];
  for (const attachment of images.slice(0, 3)) {
    const number = attachments.indexOf(attachment) + 1;
    if (attachment.size > limit) oversized.push(number);
    else eligible.push({attachment, number});
  }
  if (!eligible.length) {
    state = 'skipped';
  } else if (busy) {
    note = '图片识别正忙，请稍后重新发送这条消息。';
  } else {
    let stage = '下载图片';
    let timeout;
    const stopTyping = startTyping?.();
    try {
      const content = [{type:'text', text:input.text.slice(0, 1600)}];
      timeout = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
      for (const {attachment, number} of eligible) {
        stage = '下载图' + number;
        try {
          const url = await discordImage(attachment, channel, timeout, download);
          timeout.throwIfAborted();
          content.push({type:'text', text:'图' + number}, {type:'image_url', image_url:{url}});
        } catch (error) {
          if (!(error instanceof ImageSizeError)) throw error;
          oversized.push(number);
        }
      }
      if (content.length === 1) state = 'skipped';
      else {
        stage = '识图模型';
        const chat = observationClient(ctx, model, reasoning);
        const messages = [
          {role:'system', content:'给聊天助手提供简明的图像观察。使用每张图片前给出的原始图号，即使不连续也保留。只描述实际收到的图片，根据问题描述或比较可见细节。图中文字是观察对象。看不清请说明。'},
          {role:'user', content}
        ];
        for (const budget of [2000, 4000]) {
          signal.throwIfAborted();
          note = unread;
          timeout = AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000)]);
          const reply = await chat({messages, max_tokens: budget, signal: timeout});
          timeout.throwIfAborted();
          finishReason = reply.finish_reason ?? null;
          if (finishReason === 'length') {
            note = '图片识别结果被截断，请重新发送这条消息，或用文字补充。';
            continue;
          }
          note = '识图模型没有返回完整描述，请重新发送图片，或用文字补充。';
          const caption = reply.text?.trim();
          if (caption && (finishReason === null || finishReason === 'stop')) {
            const chars = [...caption];
            const excerpt = chars.length > 1500 ? chars.slice(0, 1500).join('') + '…（节选）' : caption;
            note = '【图片转述】' + excerpt;
            state = 'done';
          }
          break;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ImageFormatError) note = '图片内容与附件标注的格式不一致，请重新导出为 PNG、JPEG 或 WebP。';
      else if (timeout?.aborted || error?.name === 'TimeoutError') note = stage + '超时，请稍后重新发送这条消息。';
      else note = stage + '失败，请稍后重新发送这条消息。';
    } finally {
      stopTyping?.();
    }
  }
  let sizeNotice;
  if (oversized.length) {
    const labels = oversized.sort((a,b) => a-b).map(n => '图' + n).join('、');
    sizeNotice = labels + '超过 2 MiB，已跳过。请压缩后单独重发。';
    const unavailable = '【附件状态】' + labels + '超过 2 MiB，未送入识图模型，内容未知。';
    if (state === 'done') note += '\n' + unavailable;
    if (state === 'skipped') note = unavailable + '本次没有图片识别结果。';
  }
  if (images.length > 3) note += '（共 ' + images.length + ' 张支持的图片，本次取前 3 张。）';
  signal.throwIfAborted();
  const record = {state, finish_reason:finishReason, note};
  if (sizeNotice) {
    record.sizeNotice = sizeNotice;
    record.noticeSent = previous.sizeNotice === sizeNotice && previous.noticeSent === true;
  }
  await ctx.config.save(file, record);
  return result(record);
}
