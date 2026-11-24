import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayIntentBits } from 'discord.js';
import { makeClient } from '../index.ts';
import { startPlugin } from '../plugin.mjs';

test('真实 SDK 在本机 Gateway 登录、REST 投递并恢复断线会话', { timeout: 25000 }, async t => {
  const account = '100000000000000001', owner = '100000000000000002', dmId = '100000000000000003';
  const message = { type:0, id:'100000000000000004', channel_id:dmId, content:'你好',
    author:{id:owner, username:'用户', discriminator:'0'}, mentions:[], attachments:[], embeds:[] };
  let url, socket, intents, resumed = false, posted, dispose;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const reply = value => res.end(JSON.stringify(value));
    if (req.url.endsWith('/gateway/bot')) return reply({ url, shards:1,
      session_start_limit:{total:1000, remaining:1000, reset_after:60000, max_concurrency:1} });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url.endsWith('/users/@me/channels')) return reply({ id:dmId, type:1, recipients:[{id:owner}] });
    if (req.url.endsWith('/channels/'+dmId+'/messages')) {
      posted = JSON.parse(Buffer.concat(chunks));
      return reply({id:'100000000000000005', channel_id:dmId});
    }
    res.statusCode = 404; reply({});
  });
  const ws = new WebSocketServer({ server });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    for (const conn of ws.clients) conn.terminate();
    await dispose?.();
    ws.close(); server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  url = 'ws://127.0.0.1:'+port;
  ws.on('connection', conn => {
    socket = conn;
    const send = obj => conn.send(JSON.stringify(obj));
    send({ op:10, d:{ heartbeat_interval:30000 } });
    conn.on('message', raw => {
      const packet = JSON.parse(raw);
      if (packet.op === 1) return send({op:11, d:null});
      if (packet.op === 2) {
        intents = packet.d.intents;
        send({op:0,t:'READY',s:1,d:{v:10,user:{id:account, bot:true,username:'鲸鲸',discriminator:'0000'},
          guilds:[],session_id:'local-session',resume_gateway_url:url,application:{id:account,flags:0}}});
        send({op:0,t:'MESSAGE_CREATE',s:2,d:message});
      }
      if (packet.op === 6) {
        resumed = packet.d.session_id === 'local-session' && packet.d.seq === 2;
        send({op:0,t:'RESUMED',s:3,d:{}});
      }
    });
  });
  const config = { token:'local-only-mock', enabled:true, persona:'whale', owner, channels:[] };
  let received;
  const ctx = { signal:controller.signal, config:{read: async () => config}, effect(fn) { dispose = fn(); },
    web:{page(){},api(){}}, logger:{warn(){}}, channels:{register(adapter) {
      return {dispose(){}, async receive(input) {
        received = input;
        await adapter.send({ account, peer:input.peer, replyTo:input.messageId, deliveryId:'local', text:'收到' }, {signal:controller.signal});
        return {status:'sent'};
      }};
    }}};
  await startPlugin(ctx, () => {
    const client = makeClient();
    client.rest.options.api = 'http://127.0.0.1:'+port+'/api';
    return client;
  });
  async function waitFor(predicate) {
    for (let i=0; i<300; i++) { if (predicate()) return; await delay(25); }
    assert.fail('本机 Discord 模拟端点超时');
  }
  await waitFor(() => posted);
  assert.equal(received.text,'你好');
  assert.equal(posted.content,'收到');
  assert.equal(posted.message_reference.message_id,message.id);
  assert.equal(intents, GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.DirectMessages);
  socket.close(4000, 'reconnect test');
  await waitFor(() => resumed);
});

test('登录失败依次等待5/15/45秒，新客户端重试，手动重连可打断等待', async t => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const flush = () => new Promise(resolve => setImmediate(resolve));
  t.mock.timers.enable({apis:['setTimeout']});
  const controller = new AbortController();
  const routes = new Map(), clients = [], cleanups = [];
  const config = {enabled:true, token:'fixture-secret', revision:'r', persona:'whale', owner:'100000000000000002', channels:[]};
  let writes = 0, succeed = false;
  await startPlugin({
    signal:controller.signal, config:{read:async () => config, save:async () => {writes++;}},
    web:{page:(p,h)=>routes.set(p,h),api:(p,h)=>routes.set(p,h)}, logger:{warn(){}},
    personas:{list:()=>[{id:'whale'}]}, models:{list:()=>[]}, channels:{register:()=>({dispose(){}})},
    effect:fn=>cleanups.push(fn())
  }, () => {
    const client = new EventEmitter();
    clients.push(client);
    client.destroy = async () => { client.disposed = true; };
    client.login = async () => {
      if (succeed) { client.emit('raw',{t:'READY',d:{user:{bot:true,id:config.owner}}}); return; }
      if (clients.length === 2) {
        client.emit('shardDisconnect', {code:4014});
        throw Error('SDK wrapper without code');
      }
      throw Object.assign(Error(config.token),{cause:{code:'ECONNRESET'}});
    };
    return client;
  });
  t.after(async () => { controller.abort(); for (const fn of cleanups.reverse()) await fn(); });
  async function request(route, form) {
    const req = Readable.from([Buffer.from(new URLSearchParams(form).toString())]);
    req.method = 'POST'; req.headers = {'content-type':'application/x-www-form-urlencoded'};
    const res = {writeHead(code){this.code=code;},end(body){this.body=body;}};
    await routes.get('/plugins/discord/'+route)(req,res);
    return res;
  }
  async function state(expected) {
    const page = await request('settings');
    assert.match(page.body,expected); assert.ok(!page.body.includes(config.token));
  }
  async function tick(ms) { t.mock.timers.tick(ms); await flush(); }
  await flush();
  for (const [index,seconds] of [5,15,45].entries()) {
    await state(new RegExp(seconds + ' 秒后进行第 ' + (index+1) + ' 次'));
    await state(index === 1 ? /错误码 4014/ : /错误码 ECONNRESET/);
    assert.equal(clients[index].disposed,true);
    await tick(seconds*1000-1); assert.equal(clients.length,index+1);
    await tick(1); assert.equal(clients.length,index+2);
  }
  await state(/3 次自动重试已用完/); await tick(120000); assert.equal(clients.length,4);
  assert.equal((await request('reconnect',{revision:'r'})).code,303);
  await flush(); await state(/5 秒后进行第 1 次/);
  await tick(4000); succeed = true;
  assert.equal((await request('reconnect',{revision:'r'})).code,303);
  await flush(); await state(/已连接/);
  await tick(60000); assert.equal(clients.length,6);
  clients[0].emit('shardError',{code:'OBSOLETE'}); await state(/错误码 ECONNRESET/);
  assert.equal(writes,0);
  succeed = false;
  await request('reconnect',{revision:'r'}); await flush();
  const saved = await request('save',{revision:'r',persona:'whale',owner:config.owner,enabled:'off'});
  assert.equal(saved.code,303); await state(/连接已关闭/);
  await tick(60000); assert.equal(clients.length,7); assert.equal(writes,1);
});
