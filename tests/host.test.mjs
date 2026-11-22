import test from 'node:test';
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
  for (const name of ['plugin.yaml', 'package.json', 'index.ts', 'plugin.mjs', 'commands.mjs', 'transport.mjs', 'settings.mjs'])
    await copyFile(join(source, name), join(folder, name));
  await cp(join(source, 'node_modules'), join(folder, 'node_modules'), { recursive: true });
  const config = JSON.parse(await readFile(join(host, 'config.example.json'), 'utf8'));
  Object.assign(config, {
    web: { port: 0 }, log: { level: 'error' },
    providers: [{ id: 'test', base_url: 'https://unused.invalid/v1', api_key: 'synthetic' }],
    models: [{ id: 'chat', name: 'Test', provider: 'test', model: 'test', type: 'chat', enabled: true, context_window: 32000 }],
    model_bindings: { chat: 'chat' }
  });
  await writeFile(join(root, 'config/config.json'), JSON.stringify(config));
  let app, cookie, url;
  const calls = [];
  async function open() {
    app = await boot(root);
    assert.equal(app.runtime.records.get('discord')?.status, 'active', app.runtime.records.get('discord')?.error);
    app.llm.chat = async input => {
      calls.push(input.messages.map(m => m.content).join('\n'));
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
  assert.match(await (await request(settings)).text(), /连接已关闭/);
  assert.equal((await request('/plugins/discord/save', { revision:'', enabled:'on', persona:'whale', owner:'123' })).status, 400);
  await app.close();
  // Swap only the client factory for an in-process Gateway/REST double in the isolated fixture.
  await writeFile(join(folder, 'index.ts'), `
    import { EventEmitter } from 'node:events';
    import { startPlugin } from './plugin.mjs';
    export async function apply(ctx) {
      let client;
      const sent = [], commandReplies = [];
      ctx.provide('discord-test', { emit(packet) { client.emit('raw', packet); }, sent: () => sent, commandReplies: () => commandReplies });
      await startPlugin(ctx, () => {
        client = new EventEmitter();
        client.login = async () => client.emit('raw', { t:'READY', d:{ user:{ bot:true, id:'${bot}' } } });
        client.destroy = async () => {};
        client.rest = { async get() { return []; },
          async patch(path, {body}) { commandReplies.push(body.content); },
          async post(path, {body}) {
          if (path === '/applications/${bot}/commands') return {id:'${commandId}'};
          if (path.startsWith('/interactions/')) return;
          if (path === '/users/@me/channels') return { type:1, id:'${dmChannel}', recipients:[{id:body.recipient_id}] };
          sent.push({path, body});
          return { id:'${dmChannel}', channel_id:path.split('/')[2] };
        } };
        return client;
      });
    }`);
  await open();
  const save = { revision: '', enabled:'on', token:'offline-only-synthetic-token', persona:'whale', owner, channels:channel+'\n'+thread };
  const saved = await request('/plugins/discord/save', save);
  assert.equal(saved.status, 303, await saved.text());
  const html = await (await request(settings)).text();
  assert.match(html, /已连接/);
  assert.ok(!html.includes(save.token));
  assert.equal((await request('/plugins/discord/save', save)).status, 400);
  const binding = { revision:hidden(html, 'revision'), account:bot };
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
  const confirmed = await (await request('/plugins/discord/binding', { ...binding, action:'preview' })).text();
  assert.equal(hidden(confirmed, 'old'), web);
  const reset = await request('/plugins/discord/binding', { ...binding, old:web, action:'independent' });
  assert.equal(reset.status, 200, await reset.text());
});
