/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { defaultImageLimitMiB, hostImageLimitMiB, imageLimitFor, maxImageLimitMiB } from './images.mjs';

import { appearanceScript, scriptHash, themeStyles } from './settings-theme.mjs';

const base = '/plugins/discord';
import { defaultQuietMs, minQuietMs, maxQuietMs } from './incoming-turns.mjs';
const sections = [
  ['connection', 'Bot 连接', '<rect x="4" y="6" width="16" height="13" rx="4"/><path d="M12 6V3M8 12h.01M16 12h.01M9 15h6"/>'],
  ['access', '消息接收', '<path d="M20 11a8 8 0 0 1-8 8H8l-5 2 1.5-5A8 8 0 1 1 20 11Z"/>'],
  ['vision', '图片识别', '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.4"/><path d="m4 17 5-5 4 4 3-3 4 4"/>'],
  ['image-limits', '各模型单图上限', '<path d="M4 7h16M4 17h16"/><rect x="8" y="4" width="3" height="6" rx="1"/><rect x="14" y="14" width="3" height="6" rx="1"/>'],
  ['binding', '私信会话绑定', '<path d="m10 14 4-4m-5 6-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m0 8a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1"/>'],
];
function icon(path) {
  return '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
}
function heading(id) {
  const [, label, path] = sections.find(section => section[0] === id);
  return '<h2 tabindex="-1">' + icon(path) + label + '</h2>';
}
function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function hidden(name, value) {
  return '<input type="hidden" name="' + name + '" value="' + escape(value) + '">';
}
function page(res, content, status = 200, detail = true, start = 'connection') {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'` });
  res.end(`<!DOCTYPE html><html lang="zh-CN" data-theme="discord"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord 设置</title><script>${appearanceScript}</script><style>
:root {
  color-scheme: light dark;
  --paper:#faf9f6; --ink:#191a18; --muted:#51534e; --line:#c5c7bf; --field:#fff;
  --edge:#777a72; --accent:#ae291a; --red:#e6432c; --on:#17633a;
  font: 16px/1.6 Inter, "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif;
}
@media (prefers-color-scheme:dark) {
  :root { --paper:#181a19; --ink:#f4f3ed; --muted:#c1c4ba; --line:#454a45;
    --field:#232623; --edge:#858b80; --accent:#ff9280; --red:#ed5740; --on:#84d6a0; }
}
* { box-sizing:border-box }
body { margin:0; background:var(--paper); color:var(--ink); overflow-wrap:anywhere }
main { max-width:72rem; margin:auto; padding:clamp(1.15rem,4vw,3.5rem); }
h1,h2,p,dl,dd { margin:0 }
h1,h2 { line-height:1.18; letter-spacing:-.045em; text-wrap:balance }
h1 { font-size:clamp(2.45rem,6.4vw,5.1rem); font-weight:800 }
h2 { font-size:clamp(1.45rem,3vw,2rem); margin-bottom:1.2rem }
a { color:var(--accent); text-underline-offset:.22em }
a:hover { text-decoration-thickness:2px }
:focus-visible { outline:3px solid var(--accent); outline-offset:3px }
header { border-top:5px solid var(--ink); }
.hero { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1.65rem 0 }
.context,dt,.nav-title,small,.help { color:var(--muted); font-size:.9rem }
.context { margin-bottom:.6rem; font-weight:650 }
.mark { flex:none; width:clamp(3.7rem,9vw,7rem); aspect-ratio:1; position:relative; overflow:hidden; background:var(--red) }
.mark::after { content:""; position:absolute; inset:0;
  background:repeating-radial-gradient(circle at 0 100%, transparent 0 12%, #211e1b 12.4% 15%, transparent 15.4% 22%) }
.summary { border-block:1px solid var(--ink); display:grid; grid-template-columns:1.3fr 1fr .65fr; }
.summary>div { padding:1rem 1.2rem; min-width:0; border-inline-start:1px solid var(--line) }
.summary>div:first-child { border:0; padding-inline-start:0 }
.summary dd { font-size:1.12rem; font-weight:700; margin-top:.18rem }
.online { color:var(--on) }
.layout { display:grid; grid-template-columns:minmax(8.5rem,1fr) minmax(0,3.4fr); gap:clamp(1.5rem,5vw,4rem); margin-top:2rem }
nav { align-self:start; position:sticky; top:1rem }
.nav-title { font-weight:650; margin-bottom:.55rem }
nav a { display:block; width:fit-content; padding:.32rem 0; color:var(--ink); text-decoration:none }
nav a:hover { color:var(--accent); text-decoration:underline }
section { border-top:2px solid var(--ink); padding:1.35rem 0 2rem; scroll-margin-top:1rem }
:target>h2 { color:var(--accent) }
.field { display:grid; grid-template-columns:minmax(8rem,1fr) minmax(0,2fr); gap:.35rem 1.25rem; margin:1rem 0 }
.field>label { font-weight:600; padding-top:.48rem }
.field small { display:block; margin-top:.4rem }
input:not([type=checkbox],[type=hidden]),select,textarea { display:block; width:100%; min-width:0; min-height:2.8rem;
  font:inherit; color:var(--ink); background:var(--field); border:1px solid var(--edge); border-radius:2px; padding:.45rem .65rem }
input::placeholder { color:var(--muted); opacity:1 }
textarea { resize:vertical }
.check { display:flex; gap:.65rem; align-items:flex-start; width:fit-content; padding:.4rem 0; cursor:pointer }
.check input { width:1.15rem; height:1.15rem; margin:.22rem 0 0; flex:none; accent-color:var(--accent) }
button { font:inherit; font-weight:650; min-height:2.75rem; border:1px solid var(--ink); background:transparent; color:var(--ink); padding:.45rem 1rem; cursor:pointer; border-radius:2px }
button:hover:enabled { background:var(--ink); color:var(--paper) }
button.primary { color:var(--paper); background:var(--ink) }
button.primary:hover { background:var(--accent); border-color:var(--accent) }
button:disabled { color:var(--muted); border-color:var(--line); cursor:default }
.actions { display:flex; align-items:center; flex-wrap:wrap; gap:.7rem 1rem; margin:1rem 0 .25rem }
#limits-info { margin-bottom:.7rem }
.limit { display:grid; grid-template-columns:minmax(0,1fr) 7rem auto; align-items:center; gap:.65rem 1rem; border-top:1px solid var(--line); padding:.8rem 0 }
.limit small,.limit code { display:block; font-size:.85rem }
code { font-family:"IBM Plex Mono",ui-monospace,monospace; overflow-wrap:anywhere }
.limit small { color:var(--accent); font-weight:650 }
.unit { display:flex; align-items:center; gap:.4rem; font-size:.9rem }
.detail { max-width:46rem; border-top:4px solid var(--ink); padding-top:1.6rem }
.detail h1 { font-size:clamp(2rem,4vw,3rem); margin-bottom:1rem }
.detail p+p { margin-top:1rem }
@media (max-width:48rem) {
  .layout { grid-template-columns:minmax(0,1fr); gap:1.2rem; margin-top:1rem }
  nav { position:static; display:flex; align-items:center; flex-wrap:wrap; gap:.2rem 1.1rem }
  .nav-title { width:100%; margin:0 }
  nav a { text-decoration:underline; text-underline-offset:.2em }
}
@media (max-width:35rem) {
  .hero { padding:1.25rem 0 }
  .summary { grid-template-columns:1fr 1fr }
  .summary>div { padding:.6rem .7rem }
  .summary>div:first-child { grid-column:1/-1; border-bottom:1px solid var(--line) }
  .summary>div:nth-child(2) { border-left:0; padding-left:0 }
  .field { grid-template-columns:minmax(0,1fr) }
  .field>label { padding:0 }
  .limit { grid-template-columns:minmax(0,1fr) auto }
  .limit label { grid-column:1/-1 }
  .unit { max-width:9rem }
}
${themeStyles}
.summary .reconnect { font-size:.85rem; min-height:2rem; margin-top:.3rem; padding:.2rem .55rem }
.summary .diagnostic { font-weight:400; line-height:1.35; margin-top:.3rem }
</style><main><div data-start="${start}" class="${detail ? 'detail' : 'settings'}">` + content + '</div></main></html>');
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

function json(res, payload, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(payload));
}

export function setupPage(ctx, api) {
  ctx.web.page(base + '/status', (_req, res) => json(res, api.connectionState()));
  ctx.web.page(base + '/settings', (_req, res) => {
    const { config: c, status, lastError, online, personas, account, imageModels } = api.state();
    const options = personas.map(p => '<option value="' + escape(p.id) + '"' +
      (p.id === c.persona ? ' selected' : '') + '>' + escape(p.name) + '</option>').join('');
    const imageOptions = imageModels.map(m => '<option value="' + escape(m.id) + '"' +
      (m.id === c.imageModel ? ' selected' : '') + '>' + escape(m.name) + '</option>').join('');
    const stamp = hidden('revision', c.revision) + hidden('account', account);
    const activeModel = imageModels.find(m => m.id === c.imageModel);
    const models = activeModel ? [activeModel, ...imageModels.filter(m => m !== activeModel)] : imageModels;
    const limitForms = models.map((m, i) => `<form class="limit" method="post" action="${base}/image-limit">
      ${stamp}${hidden('model', m.id)}
      <label for="limit-${i}">${m === activeModel ? '<small>当前识图模型</small>' : ''}<strong>${escape(m.name)}</strong>
        <code>${escape(m.id)}</code></label>
      <div class="unit"><input id="limit-${i}" aria-describedby="limit-unit-${i}" type="number" name="limitMiB" min="0.1" max="${maxImageLimitMiB}" step="0.1" required value="${imageLimitFor(c.imageLimitsMiB, m.id)}"><span id="limit-unit-${i}">MiB</span></div>
      <button aria-label="保存 ${escape(m.name)} 的单图上限">保存上限</button></form>`).join('');
    page(res, `<div class="topbar"><button class="menu" type="button" aria-expanded="false" aria-controls="settings-nav">导航</button>
    <span class="crumb">插件管理 › Discord</span>
    <div class="chooser" role="group" aria-label="外观"><button type="button" data-choice="swiss">瑞士风</button><button type="button" data-choice="discord">Discord 风</button></div></div><header><div class="hero"><div><p class="context">WhaleLife / 插件管理</p><h1>Discord 设置</h1></div><div class="mark" aria-hidden="true"></div></div>
    <dl class="summary"><div><dt>连接状态 · <a href="${base}/settings">刷新</a></dt><dd id="connection-status" role="status" class="${online ? 'online' : ''}">${escape(status)}</dd>
    <dd class="diagnostic" id="connection-diagnostic" ${lastError ? '' : 'hidden'}><small>${lastError ? '最近一次 · ' + escape(lastError) : ''}</small></dd>
    <dd class="diagnostic" id="connection-feedback" role="status" hidden></dd>
    <dd><form id="reconnect-form" data-status-url="${base}/status" method="post" action="${base}/reconnect">${hidden('revision', c.revision)}
    <button type="submit" class="reconnect" title="使用已保存的设置重新登录 Discord" ${c.enabled ? '' : 'disabled'}>重新连接</button></form></dd></div>
    <div><dt>图片处理</dt><dd>${c.imageMode === 'auto' ? '自动（优先直看）' : c.imageMode === 'off' ? '已关闭' : '始终转述'}</dd>
    ${activeModel && c.imageMode !== 'off' ? '<dd><small>辅助模型 · '+escape(activeModel.name)+'</small></dd>' : ''}</div>
    <div><dt>单图上限</dt><dd>${c.imageMode === 'off' ? '未启用' : activeModel ? imageLimitFor(c.imageLimitsMiB, activeModel.id) + ' MiB' : hostImageLimitMiB + ' MiB'}</dd></div></dl></header>
    <div class="layout"><nav id="settings-nav" aria-label="本页设置"><div class="brand"><svg viewBox="0 0 40 40" aria-hidden="true"><path fill="currentColor" d="M6 18c1 1 2 2 5 2 2-5 6-8 12-8 7 0 11 5 11 11 0 5-5 9-13 9-7 0-13-4-13-9-4-1-5-4-5-7l3 2Z"/><circle cx="27" cy="20" r="1.5" fill="#4b48ad"/><path d="M21 9c0-3 2-4 3-5m-4 5c-1-2-2-3-4-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><div><b>WhaleLife</b><small>插件设置</small></div></div><p class="nav-title">本页设置</p>
      ${sections.map(([id,label,path]) => '<a href="#' + id + '">' + icon(path) + label + '</a>').join('')}</nav>
    <div class="panels"><form method="post" action="${base}/save">${stamp}
    <section id="connection">${heading('connection')}<div class="card">
    <label class="check"><input name="enabled" type="checkbox" ${c.enabled ? 'checked' : ''}>启用 Discord 连接</label>
    <p class="help" id="bot-account" ${account ? '' : 'hidden'}>Bot ID · <code>${escape(account)}</code></p>
    <div class="field"><label for="token">Bot Token</label><div><input id="token" type="password" name="token" maxlength="512" autocomplete="new-password" aria-describedby="token-help">
    <small id="token-help">${c.token ? '已保存 Token。留空可继续使用，填写新值会替换。' : '从 Discord Developer Portal 的 Bot 页面复制 Token。'}</small></div></div>
    <div class="field"><label for="persona">聊天人格</label><select id="persona" name="persona">${options}</select></div></div></section>
    <section id="access">${heading('access')}<div class="card"><p class="help">启用连接时，至少填写一个私信用户或频道 ID。</p>
    <div class="field"><label for="owner">允许私信的用户 ID</label><div><input id="owner" name="owner" value="${escape(c.owner)}" inputmode="numeric" aria-describedby="owner-help">
    <small id="owner-help">留空关闭私信。在 Discord 开启开发者模式后，右键用户头像即可复制 ID。</small></div></div>
    <div class="field"><label for="channels">频道或讨论串 ID</label><div><textarea id="channels" name="channels" rows="3" aria-describedby="channels-help">${escape(Array.isArray(c.channels) ? c.channels.join('\n') : '')}</textarea>
    <small id="channels-help">每行一个 ID。在允许的频道中，@ Bot 或回复它的消息即可对话。</small></div></div>
    <label class="check"><input name="dmDebounce" type="checkbox" ${c.dmDebounce ? 'checked':''}>私信：等我说完再回</label>
    <div class="field"><label for="dmQuietMs">私信等待时间（毫秒）</label><div><input id="dmQuietMs" name="dmQuietMs" type="number" required min="${minQuietMs}" max="${maxQuietMs}" step="1" value="${escape(c.dmQuietMs)}" aria-describedby="quiet-help">
    <small id="quiet-help">默认 ${defaultQuietMs} 毫秒。每条新私信都会重新计时，关闭后逐条回复。</small></div></div>
    <label class="check"><input name="channelMerge" type="checkbox" ${c.channelMerge ? 'checked':''}>频道与讨论串：合并同一人的追发</label>
    <small>首条立即处理；后续消息仍须 @ Bot 或回复 Bot。</small>
    <label class="check"><input name="inheritThreads" type="checkbox" ${c.inheritThreads ? 'checked':''}>允许上述频道下的讨论串</label>
    <label class="check"><input name="replyIntent" type="checkbox" aria-describedby="reply-help" ${c.replyIntent ? 'checked':''}>接收回复 Bot 时未 @ 它的消息</label>
    <p class="help" id="reply-help">使用此选项前，请在 Discord Developer Portal → Bot 开启 Message Content Intent。</p></div></section>
    <section id="vision">${heading('vision')}<div class="card">
    <div class="field"><label for="imageMode">图片处理方式</label><select id="imageMode" name="imageMode">
    ${[['auto','自动（优先直看）'],['describe','始终转述'],['off','关闭']].map(([v,label]) => '<option value="'+v+'" '+(c.imageMode === v ? 'selected':'')+'>'+label+'</option>').join('')}</select></div>
    <div class="field"><label for="imageModel">辅助识图模型</label><div><select id="imageModel" name="imageModel" aria-describedby="vision-help"><option value="">不使用辅助模型</option>${imageOptions}</select>
    <small id="vision-help">每条最多处理 10 张 PNG、JPEG 或 WebP。自动模式在 WhaleLife v0.1.5 起优先把原图交给主模型，直传每张最多 4 MiB、合计最多 16 MiB。旧宿主、直传超限或主模型明确拒绝图片时，可用所选辅助模型转述。</small></div></div>
    <div class="field"><label for="imageReasoning">识图思考模式</label><select id="imageReasoning" name="imageReasoning">
    ${[['auto','自动（DeepSeek Flash 尝试关闭）'],['none','尝试关闭'],['model','跟随模型设置']].map(([value,label]) => '<option value="'+value+'" '+(c.imageReasoning === value ? 'selected':'')+'>'+label+'</option>').join('')}</select></div>
    <div class="field"><label for="imageTimeout">每轮超时（秒）</label><input id="imageTimeout" name="imageTimeout" type="number" min="30" max="300" required value="${escape(c.imageTimeout)}"></div>
    </div></section><div class="actions connection-actions"><button class="primary">保存连接设置</button><small>保存连接、消息接收和识图设置。单独调整连发策略或等待时间会直接生效。</small></div></form>
    <section id="image-limits">${heading('image-limits')}
    <p class="help" id="limits-info">选择辅助模型后，此上限也适用于直传。每个模型单独保存，立即对新消息生效。默认 ${defaultImageLimitMiB} MiB，可设 0.1 至 ${maxImageLimitMiB} MiB。</p>
    ${limitForms || '<p>请先在 WhaleLife 添加并启用识图模型。</p>'}</section>
    <section id="binding">${heading('binding')}<div class="card">
    <p>可将获准用户的私信接到当前网页会话，或为私信新建独立会话。绑定网页会话后，对方可以和鲸鲸聊到这段会话里的内容。</p>
    <form method="post" action="${base}/binding">${stamp}${hidden('action','preview')}
    <div class="actions"><button id="binding-preview" ${!account || !c.owner ? 'disabled' : ''}>查看当前绑定</button>
    <small id="binding-help">${!account || !c.owner ? '先连接 Bot，并保存允许私信的用户 ID。' : '查看后可确认更改。'}</small></div></form></div></section></div></div>`, 200, false, activeModel && c.enabled ? 'vision' : 'connection');
  }, { title: 'Discord 设置', settings: true, navigation: true });

  ctx.web.api(base + '/reconnect', async (req, res) => {
    try {
      if (req.method !== 'POST') throw Error('请使用设置页上的重新连接按钮。');
      const f = await fields(req);
      await api.reconnect(f.revision);
      if (req.headers.accept === 'application/json') return json(res, api.connectionState());
      res.writeHead(303, { Location: base + '/settings', 'Cache-Control': 'no-store' }); res.end();
    } catch (error) {
      if (req.headers.accept === 'application/json') return json(res, {error:error.message}, 409);
      page(res, '<h1>重新连接失败</h1><p>' + escape(error.message) + '</p>' + back, 409); }
  });
  ctx.web.api(base + '/save', async (req, res) => {
    try {
      const f = await fields(req);
      await api.save(f.revision, { enabled: f.enabled === 'on', persona: f.persona, imageModel: f.imageModel || '',
        imageMode: f.imageMode ?? (f.imageModel ? 'describe' : 'off'),
        imageTimeout: Number(f.imageTimeout ?? 120), imageReasoning: f.imageReasoning || 'auto',
        dmQuietMs: Number(f.dmQuietMs ?? api.state().config.dmQuietMs ?? defaultQuietMs),
        dmDebounce: f.dmQuietMs === undefined ? api.state().config.dmDebounce : f.dmDebounce === 'on',
        channelMerge: f.dmQuietMs === undefined ? api.state().config.channelMerge : f.channelMerge === 'on',
        replyIntent: f.replyIntent === 'on', inheritThreads: f.inheritThreads === 'on',
        owner: (f.owner || '').trim(), channels: [...new Set((f.channels || '').trim().split(/[\s,，]+/).filter(Boolean))],
        token: (f.token || '').trim() });
      res.writeHead(303, { Location: base + '/settings', 'Cache-Control': 'no-store' }); res.end();
    } catch (error) { page(res, '<h1>保存失败</h1><p>' + escape(error.message) + '</p>' + back, 400); }
  });
  ctx.web.api(base + '/image-limit', async (req, res) => {
    try {
      const f = await fields(req);
      await api.saveImageLimit(f.revision, f.model, Number(f.limitMiB));
      res.writeHead(303, { Location: base + '/settings#image-limits', 'Cache-Control': 'no-store' }); res.end();
    } catch (error) { page(res, '<h1>保存上限失败</h1><p>' + escape(error.message) + '</p>' + back, 400); }
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
