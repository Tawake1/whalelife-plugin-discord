import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentHint, imageAttachments, imageNote } from '../images.mjs';
import { incoming } from '../transport.mjs';

const channel = '100000000000000001', account = '100000000000000002', id = '100000000000000003';
const owner = '100000000000000004';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/96kAAAAASUVORK5CYII=', 'base64');
const prefix = 'https://cdn.discordapp.com/attachments/' + channel + '/' + id + '/';
const attachment = {id, content_type:'image/png', size:png.length, url:prefix+'p.png?ex=test'};
function fixture() {
  const state = new Map(), calls = [], requests = [];
  return {
    state, calls, requests,
    args: {
      ctx: {
        config: {read: async name => state.get(name) || {}, save: async (name, value) => state.set(name, value)},
        llm: {chat: async input => { calls.push(input); return {text:'真实见到的文字'}; }}
      },
      account, channel, model:'chosen-model', input:{text:'图片上写了什么？', messageId:id}, images:[attachment],
      signal:new AbortController().signal,
      download:async (url, options) => { requests.push({url, options}); return new Response(png); }
    }
  };
}
test('图片问题送到所选模型，识别结果可重用，按顺序发送前三张', async () => {
  const f = fixture();
  f.args.images = ['a','b','c','d'].map(name=>({...attachment, url:prefix+name+'.png'}));
  const {note} = await imageNote(f.args);
  assert.match(note, /真实见到的文字/); assert.match(note, /前 3 张/);
  assert.deepEqual(f.calls[0].messages[1].content.filter(p=>p.type==='text').slice(1).map(p=>p.text), ['图1','图2','图3']);
  assert.deepEqual(f.requests.map(r=>r.url.pathname.split('/').pop()), ['a.png','b.png','c.png']);
  assert.equal(f.calls[0].model, 'chosen-model');
  assert.match(f.calls[0].messages[1].content[0].text, /图片上写了什么/);
  assert.equal(f.calls[0].messages[1].content[2].image_url.url, 'data:image/png;base64,'+png.toString('base64'));
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal((await imageNote(f.args)).note, note);
  assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 3);
  assert.doesNotMatch(JSON.stringify([...f.state.values()]), /cdn\.discordapp|base64|iVBOR/);
});
test('错误频道、外站、超限、伪装图片或数据不完整均不调用模型', async () => {
  for (const change of [
    {url:attachment.url.replace(channel, owner)}, {url:attachment.url.replace('cdn.discordapp.com', 'example.com')},
    {url:attachment.url.replace(id, owner)}, {size:0}, {size:3*1024*1024},
    {size:png.length+1}, {size:png.length-1}, {content_type:'image/jpeg'}
  ]) {
    const f = fixture(); f.args.images = [{...attachment, ...change}];
    assert.match((await imageNote(f.args)).note, /下载图1失败|格式不一致|超过/);
    assert.equal(f.calls.length, 0);
    if (change.url || change.size === 0 || change.size > 2*1024*1024) assert.equal(f.requests.length, 0);
  }
});
test('旧版收据保持入站文字一致，新版繁忙不占用成功收据', async () => {
  const f = fixture();
  const key = 'image-receipts/'+account+'/'+channel+'/'+id+'.json';
  f.state.set(key, {state:'pending'});
  assert.match((await imageNote(f.args)).note, /未能识别/);
  f.state.set(key, {state:'done', note:'原有观察'});
  assert.equal((await imageNote(f.args)).note, '原有观察');
  f.state.clear();
  assert.equal((await imageNote({...f.args, busy:true})).retryable, true);
  assert.equal(f.state.get(key).state, 'failed');
  assert.equal(f.requests.length, 0);
  assert.match((await imageNote(f.args)).note, /真实见到/);
  await assert.rejects(imageNote({...f.args, signal:AbortSignal.abort()}));
});

test('截断时加大预算，下载一次；失败和空正文可用原消息重试', async () => {
  const f = fixture();
  const budgets = [];
  const replies = [
    {text:'主体特征：', finish_reason:'length'}, {text:'半截', finish_reason:'length'},
    {text:' ', finish_reason:'stop'}, {text:'残留文字', finish_reason:'content_filter'},
    {text:'', finish_reason:'length'}, {text:'红色的鲸', finish_reason:'stop'}
  ];
  f.args.ctx.llm.chat = async req => { budgets.push(req.max_tokens); return replies.shift(); };
  const key = 'image-receipts/'+account+'/'+channel+'/'+id+'.json';
  const truncated = await imageNote(f.args);
  assert.equal(truncated.retryable, true);
  assert.match(truncated.note, /截断/);
  assert.deepEqual(f.state.get(key), {state:'failed', finish_reason:'length', note:truncated.note});
  assert.equal(f.requests.length, 1);
  for (const reason of ['stop','content_filter']) {
    assert.equal((await imageNote(f.args)).retryable, true);
    assert.equal(f.state.get(key).state, 'failed');
    assert.equal(f.state.get(key).finish_reason, reason);
  }
  assert.match((await imageNote(f.args)).note, /红色的鲸/);
  assert.match((await imageNote(f.args)).note, /红色的鲸/);
  assert.deepEqual(budgets, [2000,4000,2000,2000,2000,4000]);
  assert.equal(f.state.get(key).state, 'done');
  assert.equal(f.state.get(key).finish_reason, 'stop');
});
test('只有允许的私信或明确 @ 的频道接纳单独图片', () => {
  const dm = {type:0, channel_id:channel, author:{id:owner}, id, content:'', attachments:[attachment]};
  const cfg = {owner, channels:[channel]};
  assert.equal(incoming(dm, account, cfg), undefined);
  assert.equal(incoming(dm, account, cfg, '请看图').text, '请看图');
  assert.equal(incoming({...dm, author:{id:channel}}, account, cfg, '请看图'), undefined);
  const guild = {...dm, guild_id:id, mentions:[{id:account}]};
  assert.equal(incoming(guild, account, cfg, '请看图'), undefined);
  assert.equal(incoming({...guild, content:'<@'+account+'>'}, account, cfg, '请看图').text, '请看图');
  assert.deepEqual(imageAttachments({attachments:[{}, {...attachment, content_type:'text/html'},attachment]}), [attachment]);
});

test('区分格式未知、图片格式不支持、识图关闭，以及普通文件', () => {
  const hint = (files, model) => attachmentHint(files, imageAttachments({attachments: files}), model);
  assert.match(hint([attachment], ''), /图片识别已关闭.*图片识别模型/);
  assert.equal(hint([attachment], 'vision'), '');
  for (const mime of ['image/gif', 'image/avif']) assert.match(hint([{content_type:mime}], 'vision'), /转成 PNG/);
  assert.match(hint([{filename:'photo.png'}], 'vision'), /确认这个附件/);
  assert.equal(hint([{content_type:'application/pdf'}], 'vision'), '');
});

test('实际识图时开启提示，结束后停止，复用结果时不用再提示', async () => {
  const f = fixture();
  const events = [];
  f.args.startTyping = () => { events.push('start'); return () => events.push('end'); };
  f.args.download = async () => { events.push('download'); throw Error(); };
  assert.match((await imageNote(f.args)).note, /下载图1失败/);
  f.args.download = async () => { events.push('download'); return new Response(png); };
  await imageNote(f.args);
  await imageNote(f.args);
  assert.deepEqual(events, ['start','download','end','start','download','end']);
});

test('超限图逐张提示，合规图保留原序号并一起识别，重投复用提示和观察', async () => {
  for (const skipped of [[3], [2], [1, 3], [1, 2, 3]]) {
    const f = fixture();
    f.args.images = [1, 2, 3].map(n => ({...attachment, size:skipped.includes(n) ? 2097153 : png.length, url:prefix+n+'.png'}));
    const notices = [];
    f.args.sendSizeNotice = async note => notices.push(note);
    const result = await imageNote(f.args);
    const seen = [1, 2, 3].filter(n=>!skipped.includes(n));
    assert.equal(result.skippedAll,!seen.length);
    assert.equal(result.retryable,false);
    assert.deepEqual(f.requests.map(r=>r.url.pathname.split('/').pop()),seen.map(n=>n+'.png'));
    if (seen.length) {
      const parts = f.calls[0].messages[1].content;
      assert.deepEqual(parts.filter(p=>p.type==='text').slice(1).map(p=>p.text),seen.map(n=>'图'+n));
      assert.match(result.note,/【图片转述】真实见到的文字/);
    } else assert.match(result.note,/本次没有图片识别结果/);
    assert.equal(f.calls.length,seen.length ? 1 : 0);
    assert.equal((await imageNote(f.args)).note,result.note);
    assert.equal(notices.length,1);
    assert.ok(notices[0].includes(skipped.map(n=>'图'+n).join('、')+'超过'));
  }
});

test('响应体或响应头实际超限时也只跳过对应图片', async () => {
  for (const oversized of [()=>new Response('x',{headers:{'Content-Length':'2097153'}}),()=>new Response(new Uint8Array(2097153))]) {
    const f = fixture();
    f.args.images = ['1','2'].map(n=>({...attachment,url:prefix+n+'.png'}));
    f.args.download = async url => url.pathname.endsWith('1.png') ? oversized() : new Response(png);
    const result = await imageNote(f.args);
    assert.match(result.note,/图1超过/);
    assert.match(result.note,/【图片转述】/);
    assert.deepEqual(f.calls[0].messages[1].content.filter(p=>p.type==='text').slice(1).map(p=>p.text),['图2']);
  }
});
