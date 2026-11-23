/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { snowflake } from './transport.mjs';

const day = 86400000;
export function expiredImage(id, now = Date.now()) {
  return snowflake(id) && Number(BigInt(id) >> 22n) + 1420070400000 < now - 30 * day;
}

// Only visit the plugin-owned, numeric account/channel/message receipt layout.
export async function pruneReceipts(data, signal, now = Date.now()) {
  const root = join(data, 'image-receipts');
  for (const dir of [data, root]) {
    const info = await lstat(dir).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!info?.isDirectory()) return;
  }
  async function visit(dir, depth) {
    for (const entry of await readdir(dir, {withFileTypes:true})) {
      signal.throwIfAborted();
      const file = join(dir, entry.name);
      if (depth < 2 && entry.isDirectory() && snowflake(entry.name)) await visit(file, depth + 1);
      if (depth === 2 && entry.isFile() && entry.name.endsWith('.json') && expiredImage(entry.name.slice(0, -5), now))
        await unlink(file);
    }
  }
  await visit(root, 0);
}

export function scheduleReceiptCleanup(ctx) {
  let running = false;
  async function sweep() {
    if (running || ctx.signal.aborted) return;
    running = true;
    try { await pruneReceipts(fileURLToPath(new URL('./data/', import.meta.url)), ctx.signal); }
    catch { if (!ctx.signal.aborted) ctx.logger.warn('Discord 图片收据清理未完成'); }
    finally { running = false; }
  }
  void sweep();
  const timer = setInterval(sweep, day).unref();
  return () => clearInterval(timer);
}
