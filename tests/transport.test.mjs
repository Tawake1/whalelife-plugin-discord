import test from 'node:test';
import assert from 'node:assert/strict';
import { deliver, incoming, splitText } from '../transport.mjs';
import { validate } from '../plugin.mjs';

const bot = '100000000000000001', owner = '100000000000000002', room = '100000000000000003';
const server = '100000000000000004', other = '100000000000000005', mid = '100000000000000006';
const config = { enabled: true, token: 'fake', owner, channels: [room], persona: 'whale' };
const dm = { type: 0, author: { id: owner, username: '青' }, mentions: [], content: '晚上好', id: mid, channel_id: room };
const guild = { ...dm, guild_id: server, mentions: [{ id: bot }], content: '<@!' + bot + '> 你好' };
const signal = new AbortController().signal;

test('私信用户、频道、真实提及与发件人过滤', () => {
  assert.equal(incoming(dm, bot, config).peer, 'dm:' + owner);
  assert.deepEqual(incoming(guild, bot, config), { peer: 'guild:' + server + ':' + room, sender: owner, messageId: mid,
    text: '你好', senderProfile: { nickname: '青' } });
  for (const event of [{ ...dm, author: { id: other } }, { ...dm, author: { id: bot } },
    { ...dm, author: { id: owner, bot: true } }, { ...dm, webhook_id: mid }, { ...dm, type: 7 },
    { ...guild, channel_id: other }, { ...guild, mentions: [] }, { ...guild, content: '随便聊聊' },
    { ...guild, content: '<@' + bot + '>' }, { ...guild, guild_id: null }]) assert.equal(incoming(event, bot, config), undefined);
});

test('限制空配置与非字符串 ID', () => {
  for (const fields of [{ token: '' }, { owner: '', channels: [] }, { channels: [123] }, { owner: 'abc' }])
    assert.throws(() => validate({ ...config, ...fields }));
  assert.equal(validate(config), config);
});

test('长消息准确分段并保持 emoji 完整', () => {
  const text = '鲸'.repeat(1999) + '🐋' + '星 星\n'.repeat(1200) + '。';
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => p.length <= 2000 && p.isWellFormed()));
  assert.deepEqual(splitText('   '), []);
});

test('分段确认、稳定 nonce、禁止群体提及、失败后停止', async () => {
  const sent = [];
  const msg = { account: bot, peer: 'guild:' + server + ':' + room, text: '鲸'.repeat(4900), deliveryId: 'delivery', replyTo: mid };
  const rest = { async post(path, { body }) {
    assert.equal(path, '/channels/' + room + '/messages');
    sent.push(body);
    return { id: mid, channel_id: room };
  } };
  await deliver(rest, msg, config, bot, signal);
  assert.equal(sent.length, 3);
  const first = sent.splice(0);
  assert.equal(new Set(first.map(p => p.nonce)).size, 3);
  assert.ok(first.every(p => p.enforce_nonce && !p.allowed_mentions.parse.length));
  assert.ok(first[0].message_reference);
  assert.equal(first[1].message_reference, undefined);
  await deliver(rest, msg, config, bot, signal);
  assert.deepEqual(sent, first);
  let calls = 0;
  await assert.rejects(deliver({ post: async () => {
    if (++calls === 2) throw Error('network');
    return { id: mid, channel_id: room };
  } }, msg, config, bot, signal), /已确认 1 段/);
  assert.equal(calls, 2);
  await assert.rejects(deliver(rest, msg, { ...config, channels: [] }, bot, signal), /允许范围/);
  await assert.rejects(deliver(rest, msg, config, bot, AbortSignal.abort()));
});

test('确认私信收件人后才投递', async () => {
  const msg = { account: bot, peer: 'dm:' + owner, text: '你好', deliveryId: '1' };
  let calls = 0;
  await assert.rejects(deliver({ post: async () => {
    calls++; return { id: room, type: 1, recipients: [{ id: other }] };
  } }, msg, config, bot, signal), /收件人/);
  assert.equal(calls, 1);
});

const reference = { type: 0, message_id: other, channel_id: room };
const original = { id: other, channel_id: room, author: { id: bot, username: '鲸鲸' }, content: '原句：天快亮了。' };
const reply = { ...guild, type: 19, message_reference: reference, referenced_message: original };

test('同一位置回复当前机器人可省略提及，其他引用仍需提及', () => {
  const result = incoming(reply, bot, config);
  assert.equal(result.sender, owner);
  assert.ok(result.text.includes(original.content));
  assert.ok(result.text.includes('"作者ID":"' + bot + '"'));
  assert.ok(result.text.endsWith('【当前发言】你好'));
  assert.ok(incoming({ ...reply, mentions:[], content:'这句什么意思？' }, bot, config));
  for (const change of [{referenced_message:null},{referenced_message:{...original, author:{id:other}}},
      {message_reference:{...reference,type:1}}, {message_reference:{...reference,channel_id:other}}])
    assert.equal(incoming({...reply, ...change, mentions:[], content:'这句什么意思？'}, bot, config), undefined);
  assert.equal(incoming({ ...reply, channel_id: other }, bot, config), undefined);
  const dmReply = { ...dm, type: 19, message_reference: reference, referenced_message: original };
  assert.ok(incoming(dmReply, bot, config).text.includes(original.content));
  assert.ok(!incoming({ ...dmReply, referenced_message: { ...original, author: {id: other} } }, bot, config).text.includes(original.content));
});

test('缺失原文、跨频道、错误引用 ID、转发均不会带入引用文字', () => {
  for (const change of [{ referenced_message: null }, { referenced_message: undefined },
    { referenced_message: { ...original, content: '' } }, { referenced_message: { ...original, channel_id: other } },
    { referenced_message: { ...original, guild_id: other } }, { message_reference: { ...reference, channel_id: other } },
    { message_reference: { ...reference, type: 1 } }, { message_reference: { ...reference, message_id: mid } }]) {
    const result = incoming({ ...reply, ...change }, bot, config);
    assert.match(result.text, /原消息文字不可用/);
    assert.ok(result.text.endsWith('你好'));
    assert.ok(!result.text.includes(original.content));
  }
});

test('引用只读取一层，长文本在完整 Unicode 字符处截断', () => {
  const long = { ...original, content: '🐋'.repeat(1501), referenced_message: { content: 'nested-secret' } };
  const result = incoming({ ...reply, referenced_message: long }, bot, config);
  assert.equal(result.text.match(/🐋/gu).length, 1500);
  assert.match(result.text, /已截断/);
  assert.doesNotMatch(result.text, /nested-secret/);
});
