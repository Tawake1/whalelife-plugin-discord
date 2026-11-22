/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { Client, GatewayIntentBits, Options } from 'discord.js';
import { startPlugin } from './plugin.mjs';

export function makeClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
    rest: { retries: 0, timeout: 15000 },
    allowedMentions: { parse: [], repliedUser: false }
  });
}

export function apply(ctx) {
  return startPlugin(ctx, makeClient);
}
