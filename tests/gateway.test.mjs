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
