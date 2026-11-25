import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settled} from 'node:timers/promises';
import {incomingTurns} from '../incoming-turns.mjs';

function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const controller = new AbortController();
  const groups = [], questions = [], errors = [];
  const host = {
    async openTurn(input) {
      const row = {inputs:[input.messageId]};
      groups.push(row);
      const receipt = Promise.withResolvers();
      row.finish = () => receipt.resolve({status:'sent'});
      return {
        result: () => receipt.promise,
        async append(value) {
          if (row.closed) return {status:'closed'};
          row.inputs.push(value.messageId);
          return {status:'accepted'};
        },
        async closeInput() { row.closed = true; }
      };
    }
  };
  const scheduler = incomingTurns(() => host, controller.signal, error => errors.push(error));
  function add(id, {mode='quiet', delay=600, peer='dm:owner', sender='owner', prepare}={}) {
    scheduler.add({input:{peer,sender,messageId:id,text:id}, question:id,
      prepare:async question => {questions.push(question); await prepare?.(); return true;},
      finished:() => {}, cleanup:() => {}}, mode, delay);
  }
  t.after(() => { controller.abort(); for (const row of groups) row.finish(); assert.deepEqual(errors,[]); });
  return {add,groups,questions,controller};
}

test('按到达时间重置私信窗口；重复包不延长等待，慢图不拆开追问', async t => {
  const f = fixture(t);
  const download = Promise.withResolvers();
  f.add('图片',{delay:1200, prepare:() => download.promise});
  t.mock.timers.tick(1150);
  f.add('只看右下角',{delay:1200});
  t.mock.timers.tick(1100);
  f.add('只看右下角',{delay:1200});
  await settled();
  assert.deepEqual(f.questions,[]);
  t.mock.timers.tick(100);
  await settled();
  assert.deepEqual(f.questions,['图片\n只看右下角']);
  f.add('之后的新问题',{delay:1200});
  t.mock.timers.tick(1200);
  await settled();
  assert.equal(f.groups.length,0);
  download.resolve();
  await settled();
  assert.deepEqual(f.groups.map(g => g.inputs),[['图片','只看右下角'],['之后的新问题']]);
});

test('频道立即接纳；不同发言人、不同讨论串和已关闭的轮次分别回复', async t => {
  const f = fixture(t);
  const channel = (id, sender='a', peer='guild:a') => f.add(id, {sender,peer,mode:'live'});
  channel('1'); channel('2'); channel('3','b'); channel('4','a'); channel('5','a','guild:thread');
  await settled();
  assert.deepEqual(f.groups.map(g => g.inputs),[['1','2'],['5'],['3'],['4']]);
  f.groups.at(-1).closed = true;
  channel('6');
  await settled();
  assert.deepEqual(f.groups.at(-1).inputs,['6']);
});

test('停用连接取消尚未到期的私信定时器',async t => {
  const f = fixture(t);
  f.add('等待');
  f.controller.abort();
  t.mock.timers.tick(5000);
  await settled();
  assert.deepEqual(f.questions,[]);
  assert.deepEqual(f.groups,[]);
});
