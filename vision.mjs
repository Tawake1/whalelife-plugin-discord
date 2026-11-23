/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { ProxyAgent } from 'undici';

// The v0.1.1 host chat API has no per-request reasoning override. Only this
// observation uses the connection selected in the plugin settings.
export function observationClient(ctx, model, mode) {
  const chat = options => ctx.llm.chat({model, ...options});
  if (mode === 'model') return chat;
  if (mode === 'auto' && !ctx.models.list('chat').some(item => item.id === model && /deepseek.*flash/i.test(item.model))) return chat;
  const connection = ctx.models.connection(model);
  if (connection.protocol !== 'openai-compatible') return chat;
  const base = new URL(connection.base_url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw Error('识图模型地址无效');
  const endpoint = connection.base_url.replace(/\/+$/, '') + '/chat/completions';
  let unsupported = false;
  return async options => {
    if (unsupported) return chat(options);
    options.signal.throwIfAborted();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout((connection.timeout_seconds || 120) * 1000)]);
    const dispatcher = connection.proxy_url ? new ProxyAgent({uri:connection.proxy_url}) : undefined;
    const headers = {'Content-Type':'application/json'};
    if (connection.api_key) headers.Authorization = 'Bearer ' + connection.api_key;
    try {
      const parameters = {...connection.parameters};
      delete parameters.thinking;
      delete parameters.stream_options;
      const response = await fetch(endpoint, {
        method:'POST', headers, dispatcher, redirect:'error', signal,
        body: JSON.stringify({...parameters, model:connection.model, messages:options.messages,
          max_tokens:options.max_tokens, reasoning_effort:'none', stream:false})
      });
      if (!response.ok) {
        if ([400, 422].includes(response.status)) {
          const detail = await response.text();
          if (/reasoning[_ ]effort|thinking.{0,40}(unsupported|not supported)/i.test(detail)) {
            unsupported = true;
            return chat(options);
          }
        } else await response.body?.cancel();
        throw Error('识图服务拒绝请求');
      }
      const {choices} = await response.json();
      return {text:choices?.[0]?.message?.content, finish_reason:choices?.[0]?.finish_reason};
    } finally { await dispatcher?.close(); }
  };
}
