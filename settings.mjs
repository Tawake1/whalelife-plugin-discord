/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
const base = '/plugins/discord';
function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function hidden(name, value) {
  return '<input type="hidden" name="' + name + '" value="' + escape(value) + '">';
}
function page(res, content, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
  res.end(`<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord 设置</title><style>
:root{color-scheme:light dark;font:16px/1.6 "Source Sans 3",system-ui,sans-serif}
body{margin:auto;padding:1.4rem;max-width:44rem}h1,h2{line-height:1.25}
section{border-top:1px solid #8888;margin-top:1.6rem;padding-top:.5rem}
label{display:block;margin:1rem 0 .3rem}input:not([type=checkbox]),select,textarea{box-sizing:border-box;width:100%;padding:.5rem;font:inherit}
button,a{font:inherit}button{padding:.45rem 1rem;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #647eff}
small{display:block;opacity:.85}code{overflow-wrap:anywhere}.actions{display:flex;gap:.7rem;flex-wrap:wrap;align-items:center;margin:1rem 0}
</style><main>` + content + '</main></html>');
}
async function fields(req) {
  const type = req.headers['content-type']?.split(';')[0];
  if (type !== 'application/x-www-form-urlencoded') throw Error('不支持的表单格式。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw Error('表单太大。');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}
const back = '<p><a href="' + base + '/settings">返回 Discord 设置</a></p>';

export function setupPage(ctx, api) {
  ctx.web.page(base + '/settings', (_req, res) => {
    const { config: c, status, personas, account, imageModels } = api.state();
    const options = personas.map(p => '<option value="' + escape(p.id) + '"' +
      (p.id === c.persona ? ' selected' : '') + '>' + escape(p.name) + '</option>').join('');
    const imageOptions = imageModels.map(m => '<option value="' + escape(m.id) + '"' +
      (m.id === c.imageModel ? ' selected' : '') + '>' + escape(m.name) + '</option>').join('');
    const stamp = hidden('revision', c.revision) + hidden('account', account);
    page(res, `<h1>Discord 设置</h1><p role="status">${escape(status)} ${account ? ' · Bot ' + escape(account) : ''}
    · <a href="${base}/settings">刷新状态</a></p>
    <form method="post" action="${base}/save">${stamp}
    <label><input name="enabled" type="checkbox" ${c.enabled ? 'checked' : ''}> 连接 Discord</label>
    <label for="token">Bot Token</label><input id="token" type="password" name="token" maxlength="512" autocomplete="new-password"
      placeholder="${c.token ? '已保存；留空沿用' : '从 Discord Developer Portal 的 Bot 页复制'}">
    <label for="persona">聊天人格</label><select id="persona" name="persona">${options}</select>
    <label for="imageModel">图片识别模型</label><select id="imageModel" name="imageModel"><option value="">关闭图片识别</option>${imageOptions}</select>
    <small>请选择能看图的对话模型。开启后，本条消息的前 3 张 PNG、JPEG 或 WebP（每张最多 2 MiB）和问题会发给所选模型。鲸鲸在会话里看到的是识图模型的文字转述。</small>
    <label for="imageReasoning">识图思考模式</label><select id="imageReasoning" name="imageReasoning">
    ${[['auto','自动（DeepSeek Flash 尝试关闭）'],['none','尝试关闭'],['model','跟随模型设置']].map(([value,label]) => '<option value="'+value+'" '+(c.imageReasoning === value ? 'selected':'')+'>'+label+'</option>').join('')}</select>
    <label for="imageTimeout">每轮识图超时（秒）</label><input id="imageTimeout" name="imageTimeout" type="number" min="30" max="300" required value="${escape(c.imageTimeout)}">
    <label for="owner">允许私信的 Discord 用户 ID</label>
    <input id="owner" name="owner" value="${escape(c.owner)}" inputmode="numeric"><small>留空关闭私信。右键用户头像可复制 ID，需先在 Discord 开启开发者模式。</small>
    <label for="channels">允许回应的频道或讨论串 ID</label>
    <textarea id="channels" name="channels" rows="4">${escape(Array.isArray(c.channels) ? c.channels.join('\n') : '')}</textarea>
    <small>每行一个 ID。可以直接 @ Bot，也可以回复这个 Bot 的消息。</small>
    <label><input name="inheritThreads" type="checkbox" ${c.inheritThreads ? 'checked':''}> 允许列表中父频道下的讨论串</label>
    <label><input name="replyIntent" type="checkbox" ${c.replyIntent ? 'checked':''}> 读取频道里未 @ Bot 的回复内容</label>
    <small>如需稳定接收关闭提醒的回复，先在 Discord Developer Portal → Bot 打开 Message Content Intent，再勾选并保存。</small>
    <div class="actions"><button>保存连接设置</button></div></form>
    <section><h2>私信会话绑定</h2>
    <p>将上述用户的私信接到当前网页会话，或切回新的独立会话。绑定后，该用户能和鲸鲸聊到目标会话中的内容。</p>
    <form method="post" action="${base}/binding">${stamp}${hidden('action','preview')}
    <button ${!account || !c.owner ? 'disabled' : ''}>查看当前绑定</button></form></section>`);
  }, { title: 'Discord 设置', settings: true, navigation: true });

  ctx.web.api(base + '/save', async (req, res) => {
    try {
      const f = await fields(req);
      await api.save(f.revision, { enabled: f.enabled === 'on', persona: f.persona, imageModel: f.imageModel || '',
        imageTimeout: Number(f.imageTimeout ?? 120), imageReasoning: f.imageReasoning || 'auto',
        replyIntent: f.replyIntent === 'on', inheritThreads: f.inheritThreads === 'on',
        owner: (f.owner || '').trim(), channels: [...new Set((f.channels || '').trim().split(/[\s,，]+/).filter(Boolean))],
        token: (f.token || '').trim() });
      res.writeHead(303, { Location: base + '/settings', 'Cache-Control': 'no-store' }); res.end();
    } catch (error) { page(res, '<h1>保存失败</h1><p>' + escape(error.message) + '</p>' + back, 400); }
  });
  ctx.web.api(base + '/binding', async (req, res) => {
    try {
      const f = await fields(req);
      if (!['preview','bind','independent'].includes(f.action)) throw Error('未知的绑定操作。');
      const result = await api.binding(f.action, f);
      if (f.action !== 'preview') {
        page(res, '<h1>私信绑定已更新</h1><p>后续私信使用会话 <code>' + escape(result) + '</code>。</p>' + back);
        return;
      }
      page(res, `<h1>确认私信会话</h1><p>Discord 用户 <code>${escape(api.state().config.owner)}</code></p>
        <p>当前绑定 <code>${escape(result.old)}</code><br>网页选中的会话 <code>${escape(result.target)}</code></p>
        <form method="post" action="${base}/binding">${hidden('account',f.account)}${hidden('revision',f.revision)}${hidden('old', result.old)}${hidden('target', result.target)}
        <div class="actions"><button name="action" value="bind">绑定此网页会话</button>
        <button name="action" value="independent">新建独立私信会话</button></div></form>${back}`);
    } catch (error) { page(res, '<h1>绑定未完成</h1><p>' + escape(error.message) + '</p>' + back, 409); }
  });
}
