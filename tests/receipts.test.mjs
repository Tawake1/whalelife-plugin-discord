import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expiredImage, pruneReceipts } from '../receipts.mjs';
import { allowedChannel } from '../transport.mjs';

test('清理只删除超过 30 天的规范图片收据，并与旧图重投截止时间一致', async t => {
  const data = await mkdtemp(join(tmpdir(),'discord-receipts-'));
  t.after(()=>rm(data,{recursive:true,force:true}));
  const now = Date.now();
  const id = days => (BigInt(now - days*86400000 - 1420070400000) << 22n).toString();
  const dir = join(data,'image-receipts',id(1),id(2));
  await mkdir(dir,{recursive:true});
  for (const name of [id(31)+'.json',id(30)+'.json','config.json']) await writeFile(join(dir,name),'{}');
  assert.ok(expiredImage(id(31),now));
  assert.equal(expiredImage(id(30),now),false);
  await pruneReceipts(data,new AbortController().signal,now);
  assert.deepEqual((await readdir(dir)).sort(),[id(30)+'.json','config.json'].sort());
});
test('讨论串继承只认可同服的已允许父频道和真实讨论串类型', async () => {
  const [guild,id,parent,other] = ['100000000000000001','100000000000000002','100000000000000003','100000000000000004'];
  const config = {channels:[parent],inheritThreads:true};
  const channel = {id,guildId:guild,parentId:parent,isThread:()=>true};
  const manager = {cache:new Map(),fetch:async ()=>channel};
  assert.ok(await allowedChannel(config,guild,id,manager));
  assert.equal(await allowedChannel({...config,inheritThreads:false},guild,id,manager),false);
  for (const item of [{...channel,guildId:other},{...channel,parentId:other},{...channel,isThread:()=>false}]) {
    manager.cache.set(id,item);
    assert.equal(await allowedChannel(config,guild,id,manager),false);
  }
});
