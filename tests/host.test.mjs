import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile, cp, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../', import.meta.url));
const host = resolve(process.env.WHALELIFE_TEST_HOST || join(source, '../whalelife'));
const { boot } = await import(pathToFileURL(join(host, 'core/index.ts')));
const { temporaryDirectory } = await import(pathToFileURL(join(host, 'tests/temporary-directory.ts')));
const bot = '100000000000000001', owner = '100000000000000002', channel = '100000000000000003';
const thread = '100000000000000004', server = '100000000000000005', friend = '100000000000000006';
const dmChannel = '100000000000000007';
const commandId = '100000000000000022';
const settings = '/plugins/discord/settings';
const hidden = (html, key) => {
  const match = html.match(new RegExp('name="' + key + '" value="([^"]*)"'));
  assert.ok(match, 'missing field ' + key + ' in ' + html);
  return match[1];
};
async function until(check) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  assert.fail('等待模拟消息处理超时');
}

test('独立宿主进程：配置、网页续聊、频道/讨论串隔离、多人、重复投递及重启', async t => {
  const root = await temporaryDirectory('whale-discord-');
  const folder = join(root, 'plugins/discord');
  await mkdir(folder, { recursive: true });
  await mkdir(join(root, 'config'));
  for (const name of ['plugin.yaml', 'package.json', 'index.ts', 'plugin.mjs', 'incoming-turns.mjs', 'images.mjs', 'commands.mjs', 'vision.mjs', 'receipts.mjs', 'transport.mjs', 'settings.mjs', 'settings-theme.mjs'])
    await copyFile(join(source, name), join(folder, name));
  await cp(join(source, 'node_modules'), join(folder, 'node_modules'), { recursive: true });
  const config = JSON.parse(await readFile(join(host, 'config.example.json'), 'utf8'));
  const observed = [];
  const endpoint = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed.push(JSON.parse(Buffer.concat(chunks)));
    res.setHeader('Content-Type','application/json');
    if (observed.length === 2) {
      res.statusCode = 422;
      return res.end(JSON.stringify({error:{message:'unsupported reasoning_effort'}}));
    }
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'图1是蓝色，图2是红色。'}}]}));
  });
  await new Promise(resolve => endpoint.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => endpoint.close(resolve)));
  Object.assign(config, {
    web: { port: 0 }, log: { level: 'error' },
    providers: [{ id: 'test', base_url: 'http://127.0.0.1:'+endpoint.address().port+'/v1', api_key: 'synthetic' }],
    models: [{ id: 'chat', name: 'Test', provider: 'test', model: 'test', type: 'chat', enabled: true, context_window: 32000 },
      {id:'vision',name:'Vision',provider:'test',model:'deepseek-flash',type:'chat',enabled:true,context_window:32000}],
    model_bindings: { chat: 'chat' }
  });
  await writeFile(join(root, 'config/config.json'), JSON.stringify(config));
  let app, cookie, url;
  const calls = [], visionRequests = [], nativeCalls = [];
  const modelHttp = await import(pathToFileURL(join(host, 'core/model-http.ts')));
  let nativeError, blockNextChat;
  async function open() {
    app = await boot(root);
    assert.equal(app.runtime.records.get('discord')?.status, 'active', app.runtime.records.get('discord')?.error);
    app.llm.chat = async input => {
      if (input.messages.some(message => Array.isArray(message.content))) {
        if (input.privateChannelImages && !input.model) {
          nativeCalls.push(input);
          if (nativeError) throw nativeError;
          return {text:'模拟直接看到了图', toolCalls:[], usage:{}};
        }
        visionRequests.push(input);
        if (visionRequests.length <= 2) return {text:'主体特征：', finish_reason:'length', toolCalls:[], usage:{}};
        return { text:'模拟图像观察：红色标记', toolCalls:[], usage:{} };
      }
      calls.push(input.messages.map(m => m.content).join('\n'));
      if (blockNextChat) {
        const gate = blockNextChat;
        blockNextChat = undefined;
        await gate;
      }
      return { text: '模拟回复', toolCalls: [], usage: { prompt_tokens: 15, completion_tokens: 4 } };
    };
    url = 'http://127.0.0.1:' + app.web.server.address().port;
    cookie = (await fetch(url + '/api/login', { method:'POST', body:'{}' })).headers.get('set-cookie').split(';')[0];
  }
  t.after(async () => { await app?.close(); });
  const request = (path, form) => fetch(url + path, { headers: { Cookie: cookie }, redirect: 'manual',
    ...(form && { method: 'POST', body: new URLSearchParams(form) }) });
  await open(); // Load the unmodified production entry first, with networking disabled by default.
  assert.equal((await fetch(url + settings)).status, 401);
  const freshSettings = await (await request(settings)).text();
  assert.match(freshSettings, /连接已关闭/);
  assert.match(freshSettings, /name="dmDebounce" type="checkbox" checked/);
  assert.match(freshSettings, /name="channelMerge" type="checkbox" checked/);
  assert.match(freshSettings, /name="dmQuietMs"[^>]+value="600"/);
  assert.match(freshSettings, /value="auto" selected>自动（优先直看）/);
  assert.equal((await request('/plugins/discord/save', { revision:'', enabled:'on', persona:'whale', owner:'123' })).status, 400);
  await app.close();
  // Swap only the client factory for an in-process Gateway/REST double in the isolated fixture.
  await writeFile(join(folder, 'index.ts'), `
    import { EventEmitter } from 'node:events';
    import { startPlugin } from './plugin.mjs';
    export async function apply(ctx) {
      let client;
      const sent = [], commandReplies = [], typing = [];
      ctx.provide('discord-test', { emit(packet) { client.emit('raw', packet); }, sent: () => sent, typing: () => typing, commandReplies: () => commandReplies });
      await startPlugin(ctx, () => {
        client = new EventEmitter();
        client.login = async () => client.emit('raw', { t:'READY', d:{ user:{ bot:true, id:'${bot}' } } });
        client.destroy = async () => {};
        let firstLookup = true;
        client.channels = {cache:new Map(), async fetch(id) {
          if (firstLookup) { firstLookup = false; await new Promise(resolve => setTimeout(resolve,100)); }
          return {id, guildId:'${server}',parentId:'${channel}',isThread:()=>id==='${thread}'}; }};
        client.rest = { async get() { return []; },
          async patch(path, {body}) { commandReplies.push(body.content); },
          async post(path, {body}) {
          if (path === '/applications/${bot}/commands') return {id:'${commandId}'};
          if (path.startsWith('/interactions/')) return;
          if (path.endsWith('/typing')) { typing.push(path); return; }
          if (path === '/users/@me/channels') return { type:1, id:'${dmChannel}', recipients:[{id:body.recipient_id}] };
          sent.push({path, body});
          return { id:'${dmChannel}', channel_id:path.split('/')[2] };
        } };
        return client;
      }, async url => url.pathname.endsWith("large.png") ? new Response(Buffer.concat([Buffer.from("89504e470d0a1a0a","hex")], 5 * 1024 * 1024)) : url.pathname.endsWith(".gif") ? new Response("GIF89a") : new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/96kAAAAASUVORK5CYII=", "base64")));
    }`);
  // Migrate a saved pre-mode configuration without changing the owner's image preference.
  await mkdir(join(folder, 'data'), {recursive:true});
  const configFile = join(folder, 'data/config.json');
  await writeFile(configFile, JSON.stringify({imageModel:''}));
  await open();
  assert.match(await (await request(settings)).text(), /value="off" selected>关闭/);
  await app.close();
  await writeFile(configFile, JSON.stringify({imageModel:'chat'}));
  await open();
  assert.match(await (await request(settings)).text(), /value="describe" selected>始终转述/);
  const save = { dmQuietMs:'600', revision: '', enabled:'on', token:'offline-only-synthetic-token', persona:'whale', imageModel:'chat', owner, channels:channel+'\n'+thread };
  const saved = await request('/plugins/discord/save', save);
  assert.equal(saved.status, 303, await saved.text());
  const html = await (await request(settings)).text();
  assert.match(html, /已连接/);
  assert.ok(!html.includes(save.token));
  assert.equal((await request('/plugins/discord/save', save)).status, 400);
  const binding = { revision:hidden(html, 'revision'), account:bot };
  const statusPath = '/plugins/discord/status';
  assert.equal((await fetch(url + statusPath)).status, 401);
  const stateResponse = await request(statusPath);
  assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  const state = await stateResponse.json();
  assert.deepEqual(state, {status:'已连接', lastError:'', online:true, enabled:true, account:bot, canBind:true});
  const reconnectPath = '/plugins/discord/reconnect';
  const jsonReconnect = await fetch(url + reconnectPath, {method:'POST', redirect:'manual',
    headers:{Cookie:cookie, Accept:'application/json'}, body:new URLSearchParams({revision:binding.revision})});
  assert.equal(jsonReconnect.status, 200);
  assert.equal((await jsonReconnect.json()).enabled, true);
  assert.equal((await request(reconnectPath, {revision:'stale'})).status, 409);
  assert.equal((await request(reconnectPath, {revision:binding.revision})).status, 303);
  assert.equal(hidden(await (await request(settings)).text(), 'revision'), binding.revision);
  const web = await app.sessions.current();
  await app.channels.web(web, '网页私信暗号', () => {});
  const preview = await (await request('/plugins/discord/binding', { ...binding, action:'preview' })).text();
  const form = { ...binding, old:hidden(preview, 'old'), target:hidden(preview, 'target'), action:'bind' };
  assert.equal(form.target, web);
  assert.equal((await request('/plugins/discord/binding', form)).status, 200);
  assert.equal((await request('/plugins/discord/binding', form)).status, 409);
  const service = () => app.runtime.services.get('discord-test').value;
  const dm = { id:'100000000000000008', type:0, channel_id:dmChannel, author:{id:owner, username:'一'}, content:'私信继续' };
  const send = data => service().emit({ t:'MESSAGE_CREATE', d:data });
  await Promise.all([send(dm),send(dm)]);
  await until(async () => (await service().sent()).length === 1);
  assert.equal(calls.length, 2);
  assert.match(calls.at(-1), /网页私信暗号/);
  const group = { ...dm, guild_id:server, channel_id:channel, mentions:[{ id:bot }], id:'100000000000000009',
    content:'<@'+bot+'> 频道第一句' };
  await send(group);
  await until(async () => (await service().sent()).length === 2);
  assert.doesNotMatch(calls.at(-1), /网页私信暗号|私信继续/);
  const followup = { ...group, type:19, id:'100000000000000010', author:{id:friend, username:'二'},
    content:'<@'+bot+'> 频道第二句', message_reference:{message_id:group.id, channel_id:channel},
    referenced_message:{...group, content:'被引用的专属句子'} };
  await Promise.all([send(followup), send(followup)]);
  await until(async () => (await service().sent()).length === 3);
  assert.match(calls.at(-1), /频道第一句/);
  assert.match(calls.at(-1), new RegExp(friend));
  assert.match(calls.at(-1), /被引用的专属句子/);
  await send({ ...group, id:'100000000000000011', channel_id:thread, content:'<@'+bot+'> 讨论串第一句' });
  await until(async () => (await service().sent()).length === 4);
  assert.doesNotMatch(calls.at(-1), /频道第一句|频道第二句|网页私信暗号|被引用的专属句子/);
  const invoke = async (action, channelId, permissions, expected) => {
    const before = (await service().commandReplies()).length;
    await service().emit({ t:'INTERACTION_CREATE', d:{
      id:'100000000000000030', type:2, application_id:bot, token:'synthetic-interaction',
      channel_id:channelId, guild_id:server, member:{user:{id:friend}, permissions},
      data:{type:1, id:commandId, name:'whale', options:[{type:1, name:action}]}
    }});
    const message = await until(async () => (await service().commandReplies())[before]);
    assert.match(message, expected);
  };
  await invoke('pause', channel, '0', /需要/);
  await invoke('status', channel, '0', /直接 @/);
  await invoke('pause', dmChannel, '16', /未在/);
  await invoke('pause', channel, '16', /已暂停/);
  await invoke('status', thread, '0', /直接 @/);
  await invoke('status', channel, '0', /已暂停/);
  await app.close();
  await open();
  await invoke('status', channel, '0', /已暂停/);
  await send({ ...group, id:'100000000000000031', content:'<@'+bot+'> 暂停期间' });
  const countBefore = calls.length;
  await send(dm);
  await send({ ...dm, id:'100000000000000012', content:'重启后继续' });
  await until(async () => (await service().sent()).length === 1);
  assert.equal(calls.length, countBefore + 1);
  assert.match(calls.at(-1), /私信继续/);
  await invoke('resume', channel, '8', /已恢复/);
  await send({ ...group, id:'100000000000000032', content:'<@'+bot+'> 恢复之后' });
  await until(async () => (await service().sent()).length === 2);
  assert.match(calls.at(-1), /恢复之后/);
  assert.doesNotMatch(calls.at(-1), /暂停期间/);
  const fresh = suffix => ((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(suffix)).toString();
  const imgId = fresh(39);
  const media = {type:0, channel_id:dmChannel, id:fresh(40), author:dm.author, content:'',
    attachments:[{id:imgId, content_type:'image/png', size:74, url:'https://cdn.discordapp.com/attachments/'+dmChannel+'/'+imgId+'/photo.png?ex=test'}]};
  media.attachments[0].size = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/96kAAAAASUVORK5CYII=', 'base64').length;
  const beforeImage = calls.length;
  await send(media);
  await until(async () => (await service().sent()).length === 3);
  assert.deepEqual(await service().typing(), ['/channels/'+dmChannel+'/typing']);
  assert.equal(calls.length, beforeImage);
  assert.deepEqual(visionRequests.map(call => call.max_tokens), [2000, 4000]);
  await Promise.all([send(media), send(media)]);
  await until(async () => (await service().sent()).length === 4);
  assert.equal(visionRequests.length, 3);
  assert.equal(calls.length, beforeImage + 1);
  assert.match(calls.at(-1), /红色标记/);
  assert.doesNotMatch(calls.at(-1), /主体特征/);
  assert.doesNotMatch(calls.at(-1), /base64|cdn\.discordapp/);
  await app.close(); await open();
  await send(media);
  await send({ ...dm, id:'100000000000000041', content:'再说说那张图' });
  await until(async () => (await service().sent()).length === 1);
  assert.equal(visionRequests.length, 3);
  assert.match(calls.at(-1), /红色标记/);
  const confirmed = await (await request('/plugins/discord/binding', { ...binding, action:'preview' })).text();
  assert.equal(hidden(confirmed, 'old'), web);
  const reset = await request('/plugins/discord/binding', { ...binding, old:web, action:'independent' });
  assert.equal(reset.status, 200, await reset.text());

  assert.deepEqual(await service().typing(), []);
  const file = attachments => ({...media, attachments});
  const gif = file([{...media.attachments[0],url:media.attachments[0].url.replace('photo.png','photo.gif'),content_type:'image/gif',size:6}]);
  const beforeHints = calls.length;
  await send({...gif, author:{id:friend}});
  await send({...group, content:'', attachments:gif.attachments});
  await send({...gif, id:fresh(42)});
  await until(async () => (await service().sent()).length === 2);
  assert.match((await service().sent()).at(-1).body.content, /转成 PNG/);
  assert.equal(calls.length, beforeHints);
  const currentForm = await (await request(settings)).text();
  assert.equal((await request('/plugins/discord/save', {...save, revision:hidden(currentForm,'revision'), imageModel:''})).status, 303);
  await send({...media, id:fresh(43)});
  await until(async () => (await service().sent()).length === 3);
  assert.match((await service().sent()).at(-1).body.content, /图片识别已关闭/);
  await send({...media, id:fresh(44), content:'这段文字照常处理'});
  await until(async () => (await service().sent()).length === 5);
  assert.match(calls.at(-1), /这段文字照常处理/);
  assert.equal(calls.length, beforeHints + 1);
  assert.equal(visionRequests.length, 3);
  assert.deepEqual(await service().typing(), ['/channels/'+dmChannel+'/typing']);

  const latest = await (await request(settings)).text();
  assert.equal((await request('/plugins/discord/save', {...save, revision:hidden(latest,'revision'),
    channels:channel, inheritThreads:'on', replyIntent:'on', imageTimeout:'180', imageReasoning:'model'})).status, 303);
  const after = (await service().sent()).length;
  const threadImage = {...media, id:fresh(45), guild_id:server, channel_id:thread, type:19,
    message_reference:{message_id:imgId,channel_id:thread}, referenced_message:{id:imgId,channel_id:thread,author:{id:bot},content:'对比一下？'},
    attachments:Array.from({length:9}).map(() => ({...media.attachments[0],filename:'image.png',content_type:'image/webp',url:media.attachments[0].url.replace(dmChannel,thread)}))};
  const secondThreadMessage = {...threadImage, id:fresh(47), content:'补充一下，先看第一张', attachments:[]};
  await send(threadImage);
  await send(secondThreadMessage);
  await until(async () => (await service().sent()).length === after + 2);
  const ordered = (await service().sent()).slice(after).map(item=>item.body.message_reference.message_id);
  assert.deepEqual(ordered,[threadImage.id,secondThreadMessage.id]);
  assert.equal((await service().sent()).at(-1).path, '/channels/'+thread+'/messages');
  assert.equal(visionRequests.at(-1).messages[1].content.filter(p=>p.type==='image_url').length, 9);
  assert.ok(visionRequests.at(-1).messages[1].content.filter(p=>p.type==='image_url').every(p=>p.image_url.url.startsWith('data:image/png;base64,')));
  assert.match(calls.at(-1), /【图片转述】/);
  await invoke('pause', thread, '16', /已暂停/);
  await send({...threadImage,id:fresh(46)});
  await invoke('status', thread, '0', /已暂停/);
  assert.equal((await service().sent()).length, after + 2);

  const finalForm = await (await request(settings)).text();
  await request('/plugins/discord/save', {...save, revision:hidden(finalForm,'revision'), imageModel:'vision'});
  const baseline = (await service().sent()).length;
  await send({...media,id:fresh(60)});
  await until(async () => (await service().sent()).length === baseline + 1);
  assert.match(calls.at(-1), /【图片转述】图1是蓝色/);
  assert.equal(observed[0].reasoning_effort, 'none');
  assert.equal(observed[0].max_tokens, 2000);
  await send({...media,id:fresh(61)});
  await until(async () => (await service().sent()).length === baseline + 2);
  assert.equal(observed.length, 2);
  assert.equal(visionRequests.at(-1).model, 'vision');
  assert.match(calls.at(-1), /红色标记/);

  const large = {...media.attachments[0], size:2097153};
  const mixed = {...media, id:fresh(70), attachments:[media.attachments[0],large,media.attachments[0]]};
  const chatCount = calls.length;
  await send(mixed);
  await until(async () => (await service().sent()).length === baseline + 4);
  assert.match((await service().sent())[baseline + 2].body.content, /图2超过 2 MiB/);
  assert.deepEqual(observed.at(-1).messages[1].content.filter(p=>p.type==='text').slice(1).map(p=>p.text), ['图1','图3']);
  assert.match(calls.at(-1), /图2超过 2 MiB，未送入识图模型/);
  await send(mixed);
  const allLarge = {...media,id:fresh(71),attachments:[large,large,large]};
  await send(allLarge);
  await until(async () => (await service().sent()).length === baseline + 5);
  assert.match((await service().sent()).at(-1).body.content, /图1、图2、图3超过/);
  assert.equal(calls.length, chatCount + 1);
  await send({...allLarge,id:fresh(72),content:'另一个文字问题'});
  await until(async () => (await service().sent()).length === baseline + 7);
  assert.match(calls.at(-1),/另一个文字问题/);
  assert.match(calls.at(-1),/本次没有图片识别结果/);
  const revision = async () => hidden(await (await request(settings)).text(), 'revision');
  const limitPath = '/plugins/discord/image-limit';
  const original = await revision();
  for (const limitMiB of ['', 'NaN', '-2', '0.01', '32.1']) {
    assert.equal((await request(limitPath, {revision:original, model:'vision', limitMiB})).status, 400);
  }
  assert.equal((await request(limitPath, {revision:original, model:'missing', limitMiB:'8'})).status, 400);
  assert.equal((await request(limitPath, {revision:original, model:'vision', limitMiB:'4'})).status, 303);
  assert.equal((await request(limitPath, {revision:original, model:'chat', limitMiB:'8'})).status, 400);
  assert.equal((await request(limitPath, {revision:await revision(), model:'chat', limitMiB:'8'})).status, 303);

  const fiveMiB = {...large, size:5 * 1024 * 1024, url:large.url.replace('photo.png','large.png')};
  const sendLarge = suffix => send({...media,id:fresh(suffix),attachments:[fiveMiB]});
  await sendLarge(73);
  await until(async () => (await service().sent()).length === baseline + 8);
  assert.match((await service().sent()).at(-1).body.content, /图1超过 4 MiB/);

  assert.equal((await request('/plugins/discord/save', {...save, revision:await revision(), imageModel:'chat'})).status, 303);
  await app.close(); await open();
  const reloaded = await (await request(settings)).text();
  for (const [model, limit] of [['chat',8], ['vision',4]]) {
    const form = reloaded.split('<form ').find(f => f.includes('name="model" value="'+model+'"'));
    assert.ok(form?.includes('required value="'+limit+'"'));
  }
  await sendLarge(74);
  await until(async () => (await service().sent()).length === 1);
  const visionCall = visionRequests.at(-1);
  assert.equal(visionCall.model, 'chat');
  const dataUrl = visionCall.messages[1].content.find(part => part.type === 'image_url').image_url.url;
  assert.equal(Buffer.from(dataUrl.split(',')[1], 'base64').length, fiveMiB.size);

  assert.equal((await request(limitPath, {revision:await revision(), model:'vision', limitMiB:'8'})).status, 303);
  const setAuto = async model => {
    const response = await request('/plugins/discord/save', {...save, revision:await revision(), imageModel:model, imageMode:'auto', imageReasoning:'model'});
    assert.equal(response.status, 303, await response.text());
    await until(async () => (await (await request(statusPath)).json()).online);
  };
  const sendAndRead = async packet => {
    const before = (await service().sent()).length;
    await send(packet);
    await until(async () => (await service().sent()).length > before);
    return (await service().sent()).at(-1).body.content;
  };
  await setAuto('vision');
  const beforeMixed = visionRequests.length;
  await sendAndRead({...media,id:fresh(81),content:'比较这两张照片',attachments:[media.attachments[0], fiveMiB]});
  const parts = visionRequests.at(-1).messages[1].content;
  assert.equal(visionRequests.length,beforeMixed + 1);
  const labels = parts.filter(p => p.type === 'text').slice(1).map(p => p.text);
  if (modelHttp.ModelImageInputUnsupportedError) {
    assert.deepEqual(labels, ['图2']);
    assert.equal(nativeCalls.length,1);
    const mixed = nativeCalls[0].messages.find(m => Array.isArray(m.content)).content;
    assert.equal(mixed.filter(p => p.type === 'image_url').length,1);
    assert.match(mixed[0].text, /比较这两张照片/);
    assert.match(mixed[0].text, /【图片转述】/);
    assert.match(mixed[0].text, /原图依次是图1/);

    nativeError = new modelHttp.ModelImageInputUnsupportedError('unsupported image input');
    assert.equal(await sendAndRead({...media,id:fresh(82),content:'这个是什么'}), '模拟回复');
    assert.equal(visionRequests.length,beforeMixed + 2);
    assert.equal(visionRequests.at(-1).messages[1].content[0].text, '这个是什么');
    assert.match(calls.at(-1), /渠道辅助识图/);
    nativeError = Error('429');
    assert.match(await sendAndRead({...media,id:fresh(83)}), /主模型未能完成看图/);
    assert.equal(visionRequests.length,beforeMixed + 2);
    nativeError = undefined;
    await setAuto('');
    assert.equal(await sendAndRead({...media,id:fresh(84)}), '模拟直接看到了图');
    const only = nativeCalls.at(-1).messages.find(m => Array.isArray(m.content)).content;
    assert.doesNotMatch(only[0].text,/请看看这张图/);
    assert.equal(visionRequests.length,beforeMixed + 2);
  } else {
    assert.deepEqual(labels,['图1','图2']);
    assert.equal(nativeCalls.length,0);
    await setAuto('');
    assert.match(await sendAndRead({...media,id:fresh(85)}), /宿主需要辅助模型/);
  }

  const policy = {...save, dmQuietMs:'300', dmDebounce:'on', channelMerge:'on', imageMode:'auto', imageModel:'vision', imageReasoning:'model'};
  for (const bad of ['', '99', '101.5', '5001', 'hello']) {
    assert.equal((await request('/plugins/discord/save', {...policy, revision:await revision(), dmQuietMs:bad})).status,400);
  }
  assert.equal((await request('/plugins/discord/save', {...policy, revision:await revision()})).status,303);
  await app.close(); await open();
  const preferences = await (await request(settings)).text();
  assert.match(preferences,/name="dmQuietMs"[^>]+value="300"/);
  let chatBefore = calls.length;
  const burst = ['分段甲','分段乙','分段丙'].map((content,i) => ({...dm,id:fresh(100+i),content}));
  for (const packet of burst) {
    await send(packet);
    await delay(115);
    assert.equal(calls.length,chatBefore);
  }
  await until(async () => (await service().sent()).length === 1);
  assert.equal(calls.length,chatBefore + 1);
  assert.match(calls.at(-1),/分段甲[\s\S]*分段乙[\s\S]*分段丙/);
  assert.equal((await service().sent())[0].body.message_reference.message_id,burst[0].id);

  // Replay a merged member by itself after restart, followed by a genuinely new message.
  await app.close(); await open();
  chatBefore = calls.length;
  await send(burst[1]);
  await send({...dm,id:fresh(104),content:'下一问'});
  await until(async () => (await service().sent()).length === 1);
  assert.equal(calls.length,chatBefore + 1);
  assert.match(calls.at(-1),/下一问/);

  const beforePhoto = (await service().sent()).length;
  const beforeAux = visionRequests.length;
  const beforeNative = nativeCalls.length;
  await send({...media,id:fresh(105),attachments:Array.from({length:9}, () => ({...media.attachments[0]}))});
  await delay(80);
  await send({...dm,id:fresh(106),content:'只看右下角'});
  await until(async () => (await service().sent()).length === beforePhoto+1);
  if (modelHttp.ModelImageInputUnsupportedError) {
    assert.equal(nativeCalls.length, beforeNative+1);
    assert.equal(nativeCalls.at(-1).messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length,9);
    assert.ok(nativeCalls.at(-1).messages.some(m => typeof m.content === 'string' && m.content.includes('只看右下角')));
  } else {
    assert.equal(visionRequests.length,beforeAux+1);
    assert.match(visionRequests.at(-1).messages[1].content[0].text,/只看右下角/);
  }

  // A channel starts without the private timer. Keep generation open while a supplement arrives.
  let releaseChat;
  blockNextChat = new Promise(resolve => { releaseChat = resolve; });
  const beforeChannel = (await service().sent()).length;
  chatBefore = calls.length;
  const head = {...group,id:fresh(110),content:'<@'+bot+'> 开始频道测试'};
  const follow = {...head,id:fresh(111),content:'<@'+bot+'> 再补一句'};
  await send(head);
  await until(() => calls.length > chatBefore);
  await send(follow);
  await delay(150);
  releaseChat();
  await until(async () => (await service().sent()).length === beforeChannel + 1);
  assert.match(calls.at(-1),/再补一句/);
  assert.equal((await service().sent()).at(-1).body.message_reference.message_id,head.id);

  // Saving only the duration must not tear down a waiting DM or reset the client.
  const beforeSave = (await service().sent()).length;
  chatBefore = calls.length;
  await send({...dm,id:fresh(114),content:'调时间之前'});
  assert.equal((await request('/plugins/discord/save', {...policy, revision:await revision(), dmQuietMs:'120'})).status,303);
  await send({...dm,id:fresh(115),content:'调时间之后'});
  await until(async () => (await service().sent()).length === beforeSave + 1);
  assert.equal(calls.length,chatBefore+1);
  assert.match(calls.at(-1),/调时间之前[\s\S]*调时间之后/);
  assert.match(await (await request(settings)).text(),/name="dmQuietMs"[^>]+value="120"/);

});
