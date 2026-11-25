/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
export const defaultQuietMs = 600;
export const minQuietMs = 100;
export const maxQuietMs = 5000;

// Each connection owns its timers and channel handles. Order admission per peer, never across peers.
export function incomingTurns(handle, signal, report) {
  const collecting = new Map();
  const admission = new Map();
  const live = new Map();
  const pendingIds = new Set();
  signal.addEventListener('abort', () => {
    for (const batch of collecting.values()) clearTimeout(batch.timer);
    collecting.clear();
    pendingIds.clear();
    live.clear();
  }, {once:true});

  function finish(item, result) {
    // Keep the image fallback context until the whole turn settles, including after an append.
    void Promise.resolve(result).then(receipt => item.finished(receipt))
      .catch(report).finally(() => {
        pendingIds.delete(item.input.messageId);
        item.cleanup();
      });
  }

  async function open(item, peer, remember) {
    const turn = await handle().openTurn(item.input, {signal});
    const result = turn.result();
    const current = {turn, result, sender:item.input.sender};
    if (remember && !turn.duplicate) live.set(peer, current);
    const clear = () => { if (live.get(peer) === current) live.delete(peer); };
    void result.then(clear, clear);
    finish(item, result);
    return turn.duplicate ? undefined : current;
  }

  async function append(current, item) {
    const {status} = await current.turn.append(item.input);
    if (status === 'accepted' || status === 'duplicate') {
      finish(item, current.result);
      return true;
    }
    if (status !== 'closed' && status !== 'full') throw Error('宿主取消了本轮输入');
    return false;
  }

  function discard(item, error) {
    pendingIds.delete(item.input.messageId);
    item.cleanup();
    if (error) report(error);
  }

  // Reserve all supplements in arrival order before waiting on any member's receipt.
  // A closed/full turn returns the remaining messages for admission in the next one.
  async function privateTurn(peer, items) {
    let remaining = items;
    while (remaining.length) {
      const [first, ...rest] = remaining;
      remaining = rest;
      let current;
      try { current = await open(first, peer, false); }
      catch (error) { discard(first, error); }
      if (!current) continue;
      const accepted = await Promise.all(rest.map(async item => {
        try { return await append(current, item); }
        catch (error) { discard(item, error); return true; }
      }));
      try { await current.turn.closeInput(); } catch (error) { report(error); }
      remaining = rest.filter((_, i) => !accepted[i]);
    }
  }

  async function submit(peer, items, mode) {
    const group = mode === 'quiet' && typeof handle().openTurn === 'function';
    const question = group ? items.map(item => item.question).filter(Boolean).join('\n').slice(-16000) : '';
    let ready = [];
    let bytes = 0, imageCount = 0, characters = 0;
    for (const item of items) {
      try {
        signal.throwIfAborted();
        if (!await item.prepare(question)) { discard(item); continue; }
        if (group) {
          const size = (item.input.images ?? []).reduce((total, image) => total + image.data.byteLength, 0);
          const pictures = item.input.images?.length ?? 0;
          // Use the host turn limits so a large member cannot be overtaken by a smaller one.
          if (ready.length && (bytes + size > 16 * 1024 * 1024 || imageCount + pictures > 16 ||
              characters + item.input.text.length > 128000 || ready.length >= 128)) {
            await privateTurn(peer, ready);
            ready = [];
            bytes = imageCount = characters = 0;
          }
          ready.push(item);
          bytes += size;
          imageCount += pictures;
          characters += item.input.text.length;
        } else if (mode === 'live' && typeof handle().openTurn === 'function') {
          const current = live.get(peer);
          if (current?.sender === item.input.sender && await append(current, item)) continue;
          live.delete(peer);
          await open(item, peer, true);
        } else {
          live.delete(peer);
          finish(item, handle().receive(item.input, {signal}));
        }
      } catch (error) { discard(item, error); }
    }
    if (ready.length) await privateTurn(peer, ready);
  }

  function queue(peer, items, mode) {
    const previous = admission.get(peer) ?? Promise.resolve();
    const next = previous.then(() => submit(peer, items, mode)).catch(report);
    admission.set(peer, next);
    void next.then(() => { if (admission.get(peer) === next) admission.delete(peer); });
  }

  function flush(peer, batch) {
    if (collecting.get(peer) !== batch) return;
    collecting.delete(peer);
    clearTimeout(batch.timer);
    queue(peer, batch.items, 'quiet');
  }

  return {
    busy: peer => collecting.has(peer) || admission.has(peer),
    add(item, mode, delay) {
      const {peer, messageId} = item.input;
      if (signal.aborted || pendingIds.has(messageId)) return;
      pendingIds.add(messageId);
      const batch = collecting.get(peer);
      if (mode !== 'quiet') {
        if (batch) flush(peer, batch);
        queue(peer, [item], mode);
        return;
      }
      const group = batch ?? {items:[], timer:undefined};
      collecting.set(peer, group);
      group.items.push(item);
      clearTimeout(group.timer);
      group.timer = setTimeout(() => flush(peer, group), delay);
    }
  };
}
