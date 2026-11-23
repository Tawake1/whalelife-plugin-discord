/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { observationClient } from './vision.mjs';
import { snowflake } from './transport.mjs';

export const defaultImageLimitMiB = 2;
export const maxImageLimitMiB = 32;

export function validImageLimit(value) {
  return typeof value === 'number' && Number.isInteger(value * 10) && value >= 0.1 && value <= maxImageLimitMiB;
}

export function imageLimitFor(limits, model) {
  return limits && Object.hasOwn(limits, model) && validImageLimit(limits[model]) ? limits[model] : defaultImageLimitMiB;
}
const pngHeader = Buffer.from('89504e470d0a1a0a','hex');
const jpegHeader = Buffer.from('ffd8ff','hex');
const riffHeader = Buffer.from('RIFF');
const webpHeader = Buffer.from('WEBP');

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(pngHeader)) return 'image/png';
  if (bytes.subarray(0, 3).equals(jpegHeader)) return 'image/jpeg';
  if (bytes.subarray(0, 4).equals(riffHeader) && bytes.subarray(8, 12).equals(webpHeader)) return 'image/webp';
  return null;
}

const unread = '图片未能识别，请重新发送图片，或用文字补充。';

export function imageAttachments(data) {
  if (!Array.isArray(data.attachments)) return [];
  return data.attachments.filter(file => /^image\//i.test(file?.content_type ?? '') ||
    /\.(?:png|jpe?g|webp)$/i.test(file?.filename ?? ''));
}

export function attachmentHint(attachments, supported, model) {
  if (!Array.isArray(attachments)) return '';
  if (supported.length) return model ? '' :
    '图片识别已关闭。请在 WhaleLife 的「插件管理 → Discord → 设置 → 图片识别模型」选择能看图的模型，保存后再发一次。';
  if (attachments.some(file => file && (!file.content_type || file.content_type === 'application/octet-stream')))
    return '没能确认这个附件的格式。如果是图片，请另存为 PNG、JPEG 或 WebP 后再发一次。';
  return '';
}

class ImageFormatError extends Error {}
class ImageSizeError extends Error {}

async function discordImage(attachment, channel, signal, download, limit) {
  const url = new URL(attachment.url);
  const parts = url.pathname.split('/');
  if (url.origin !== 'https://cdn.discordapp.com' || url.username || url.password ||
      parts.length !== 5 || parts[1] !== 'attachments' || parts[2] !== channel ||
      !snowflake(attachment.id) || parts[3] !== attachment.id || !parts[4])
    throw Error('invalid attachment location');
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > limit)
    throw Error('invalid image size');
  const response = await download(url, { signal, redirect: 'error', credentials: 'omit' });
  const length = response.headers.get('content-length');
  const responseSize = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  if (response.ok && responseSize !== null && responseSize > limit) {
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
    chunks.push(chunk);
  }
  // Fetch decodes content encodings; Content-Length counts bytes before decoding.
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if ((!encoding || encoding === 'identity') && responseSize !== null && size !== responseSize)
    throw Error('response size mismatch');
  const bytes = Buffer.concat(chunks, size);
  const mime = imageType(bytes);
  if (!mime) throw new ImageFormatError('unrecognized image header');
  return {mime, url:'data:' + mime + ';base64,' + bytes.toString('base64')};
}

// Successful observations must stay identical across redelivery because the host deduplicates by message ID.
export async function imageNote({ ctx, account, channel, input, images, attachments = images, sendAttachmentNotice, model, reasoning = 'model', timeoutSeconds = 120, limitMiB = defaultImageLimitMiB, signal, busy = false, download = fetch, startTyping }) {
  const limit = Math.floor(limitMiB * 1024 * 1024);
  const file = 'image-receipts/' + account + '/' + channel + '/' + input.messageId + '.json';
  const previous = await ctx.config.read(file);
  signal.throwIfAborted();
  async function result(record) {
    const notice = record.attachmentNotice ?? record.sizeNotice;
    if (notice && !record.noticeSent && sendAttachmentNotice) {
      try {
        await sendAttachmentNotice(notice);
        await ctx.config.save(file, {...record, noticeSent:true});
      } catch {
        signal.throwIfAborted();
        ctx.logger.warn('Discord 附件提示未确认');
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
  const formats = [];
  const unknownFormats = [];
  const oversized = [];
  const failedDownloads = [];
  const eligible = [];
  for (const attachment of images.slice(0, 3)) {
    const number = attachments.indexOf(attachment) + 1;
    const format = {number, declared_type:typeof attachment.content_type === 'string' ? attachment.content_type : null, detected_type:null};
    formats.push(format);
    if (attachment.size > limit) oversized.push(number);
    else eligible.push({attachment, format});
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
      const content = [{type:'text', text:input.text}];
      timeout = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
      for (const {attachment, format} of eligible) {
        const {number} = format;
        stage = '下载图' + number;
        try {
          timeout.throwIfAborted();
          const {url, mime} = await discordImage(attachment, channel, timeout, download, limit);
          timeout.throwIfAborted();
          format.detected_type = mime;
          content.push({type:'text', text:'图' + number}, {type:'image_url', image_url:{url}});
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ImageSizeError) oversized.push(number);
          else if (error instanceof ImageFormatError) unknownFormats.push('图' + number);
          else if (timeout.aborted || error?.name === 'TimeoutError') failedDownloads.push(stage + '超时');
          else failedDownloads.push(stage + '失败');
        }
      }
      if (content.length === 1) {
        if (failedDownloads.length) note = failedDownloads.join('；') + '，请重新发送。';
        else state = 'skipped';
      } else {
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
      if (timeout?.aborted || error?.name === 'TimeoutError') note = stage + '超时，请稍后重新发送这条消息。';
      else note = stage + '失败，请稍后重新发送这条消息。';
    } finally {
      stopTyping?.();
    }
  }
  const notices = [];
  const unavailable = [];
  if (oversized.length) {
    const labels = oversized.sort((a,b) => a-b).map(n => '图' + n).join('、');
    notices.push(labels + '超过 ' + limitMiB + ' MiB（当前模型的单图上限），已跳过。请压缩后单独重发。');
    unavailable.push(labels + '超过 ' + limitMiB + ' MiB，未送入识图模型，内容未知。');
  }
  if (unknownFormats.length) {
    const detail = unknownFormats.join('、') + '的文件头未识别为 PNG、JPEG 或 WebP';
    notices.push(detail + '，请转成 PNG、JPEG 或 WebP 后重发。');
    unavailable.push(detail + '，内容未知。');
  }
  if (unavailable.length) {
    const summary = '【附件状态】' + unavailable.join('');
    if (state === 'done') note += '\n' + summary;
    if (state === 'skipped') note = summary + '本次没有图片识别结果。';
  }
  if (failedDownloads.length && state === 'done') {
    const detail = failedDownloads.join('；');
    note += '\n【附件状态】' + detail + '。这些图片未送入识图模型，内容未知。';
    notices.push(detail + '。请单独重发相应的图片。');
  }
  if (images.length > 3) note += '（共 ' + images.length + ' 张图片附件，本次取前 3 张。）';
  signal.throwIfAborted();
  const record = {state, finish_reason:finishReason, note, attachments:formats};
  if (notices.length) {
    record.attachmentNotice = notices.join('\n');
    record.noticeSent = (previous.attachmentNotice ?? previous.sizeNotice) === record.attachmentNotice && previous.noticeSent === true;
  }
  await ctx.config.save(file, record);
  return result(record);
}
