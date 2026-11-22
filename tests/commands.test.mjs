import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCommand, handleCommand } from '../commands.mjs';

const bot = '100000000000000001', commandId = '100000000000000002';
const channel = '100000000000000003', member = '100000000000000004';
const signal = new AbortController().signal;

test('注册只创建自己的命令，重连复用同一 ID，同名冲突保持原样', async () => {
  const entries = [{ name:'other', type:1 }], posts = [];
  const rest = { get:async () => entries, post:async (path, {body}) => {
    assert.equal(path, '/applications/'+bot+'/commands');
    posts.push(body);
    const record = { ...body, id:commandId };
    entries.push(record); return record;
  } };
  assert.equal(await registerCommand(rest, bot, signal), commandId);
  assert.equal(await registerCommand(rest, bot, signal), commandId);
  assert.equal(posts.length, 1);
  entries[1].description = '不同用途';
  await assert.rejects(registerCommand(rest, bot, signal), /其他用途/);
  assert.equal(posts.length, 1);
});

test('命令先私下确认，确认失败或命令不匹配不会写入；写入失败有明确反馈', async () => {
  let rejectAck = false, writes = 0;
  const feedback = [], ackBodies = [];
  const rest = {
    async post(path, options) {
      assert.equal(options.auth, false); assert.equal(options.body.data.flags, 64);
      ackBodies.push(options.body.type);
      if (rejectAck) throw Error('interaction already acknowledged');
    },
    async patch(path, options) { assert.match(path, /@original$/); feedback.push(options.body.content); }
  };
  const event = {id:member, application_id:bot, guild_id:member, channel_id:channel, token:'test',
    type:2, data:{name:'whale', type:1, id:commandId, options:[{name:'pause',type:1}]},
    member:{permissions:'16',user:{id:member}}};
  const deps = { rest, commandId, account:bot, signal, serial:fn => fn(),
    getConfig:() => ({channels:[channel],pausedRoutes:[]}),
    savePaused:async () => { writes++; throw Error('disk unavailable'); } };
  await handleCommand({...event, application_id:member}, deps);
  assert.deepEqual(ackBodies, []);
  rejectAck = true;
  await handleCommand(event, deps);
  assert.equal(writes, 0); assert.deepEqual(feedback, []);
  rejectAck = false;
  await handleCommand(event, deps);
  assert.equal(writes, 1); assert.match(feedback[0], /保存失败/);
});
