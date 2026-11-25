/*! Copyright (c) 2026 WhaleLife Discord plugin contributors.
 * SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';

// This script only manages presentation. Inputs, connection state and form submissions stay with the host.
function setupAppearance() {
  const root = document.documentElement;
  const key = 'whalelife.discord.settings.appearance';
  try {
    if (localStorage.getItem(key) === 'swiss') root.dataset.theme = 'swiss';
  } catch { /* The default also works when browser storage is unavailable. */ }
  document.addEventListener('DOMContentLoaded', () => {
    const settings = document.querySelector('.settings');
    if (!settings) return;
    const nav = settings.querySelector('nav');
    const menu = settings.querySelector('.menu');
    const links = [...nav.querySelectorAll('a')];
    const sections = [...settings.querySelectorAll('section[id]')];
    const themes = [...settings.querySelectorAll('[data-choice]')];
    function closeMenu() {
      nav.classList.remove('open');
      menu.setAttribute('aria-expanded', 'false');
    }
    function showSection(id) {
      const current = sections.some(s => s.id === id) ? id : settings.dataset.start;
      for (const section of sections) {
        section.classList.toggle('inactive', section.id !== current && !(current === 'vision' && section.id === 'image-limits'));
      }
      for (const link of links) {
        if (link.hash.slice(1) === current) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
      settings.querySelector('.connection-actions').classList.toggle('inactive', ['image-limits','binding'].includes(current));
      closeMenu();
    }
    function paint() {
      for (const button of themes) button.setAttribute('aria-pressed', String(button.dataset.choice === root.dataset.theme));
      showSection(location.hash.slice(1));
    }
    for (const button of themes) button.addEventListener('click', () => {
      root.dataset.theme = button.dataset.choice;
      try { localStorage.setItem(key, root.dataset.theme); } catch { /* Keep this page's choice. */ }
      paint();
    });
    menu.addEventListener('click', () => menu.setAttribute('aria-expanded', String(nav.classList.toggle('open'))));
    for (const link of links) link.addEventListener('click', event => {
      if (root.dataset.theme !== 'discord' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (location.hash !== link.hash) history.pushState(null, '', link.hash);
      showSection(link.hash.slice(1));
      document.querySelector(link.hash + ' h2').focus({preventScroll:true});
      window.scrollTo(0, 0);
    });
    window.addEventListener('popstate', paint);
    window.addEventListener('hashchange', paint);
    // Reveal a hidden invalid field before the browser focuses it.
    settings.addEventListener('invalid', event => {
      const section = event.target.closest('section.inactive');
      if (section && root.dataset.theme === 'discord') {
        history.replaceState(null, '', '#' + section.id);
        showSection(section.id);
      }
    }, true);
    paint();
    root.classList.add('interactive');
  });
}
function watchConnection() {
  const form = document.getElementById('reconnect-form');
  if (!form) return;
  const button = form.querySelector('button');
  const status = document.getElementById('connection-status');
  const diagnostic = document.getElementById('connection-diagnostic');
  const feedback = document.getElementById('connection-feedback');
  const account = document.getElementById('bot-account');
  const binding = document.getElementById('binding-preview');
  let timer, reading, posting = false;

  function render(state) {
    if (status.textContent !== state.status) status.textContent = state.status;
    status.classList.toggle('online', state.online);
    diagnostic.querySelector('small').textContent = state.lastError ? '最近一次 · ' + state.lastError : '';
    diagnostic.hidden = !state.lastError;
    account.querySelector('code').textContent = state.account;
    account.hidden = !state.account;
    binding.form.elements.account.value = state.account;
    binding.disabled = !state.canBind;
    document.getElementById('binding-help').textContent = state.canBind ? '查看后可确认更改。' : '先连接 Bot，并保存允许私信的用户 ID。';
    button.disabled = !state.enabled || posting;
  }

  function message(text) {
    feedback.textContent = text;
    feedback.hidden = !text;
  }
  function pause() {
    clearTimeout(timer);
    reading?.abort();
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (!posting && !document.hidden) timer = setTimeout(read, ms);
  }
  const unavailable = '暂时无法读取连接状态，正在等待恢复。';
  const unconfirmed = '未能确认重连请求，正在核对连接状态。';
  async function read() {
    if (posting || document.hidden) return;
    pause();
    const request = new AbortController();
    reading = request;
    let delay = 2000;
    try {
      const response = await fetch(form.dataset.statusUrl, {cache:'no-store',
        signal:AbortSignal.any([request.signal, AbortSignal.timeout(8000)])});
      if (!response.ok) throw Error();
      const state = await response.json();
      if (request.signal.aborted) return;
      render(state);
      if (feedback.textContent === unavailable || feedback.textContent === unconfirmed) message('');
      if (state.online || !state.enabled) delay = 10000;
    } catch {
      if (!request.signal.aborted && !feedback.textContent) message(unavailable);
    } finally {
      if (!request.signal.aborted) schedule(delay);
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (posting) return;
    posting = true;
    pause();
    button.disabled = true;
    message('正在请求重新连接…');
    try {
      const response = await fetch(form.action, {method:'POST', headers:{Accept:'application/json'},
        body:new URLSearchParams(new FormData(form)), signal:AbortSignal.timeout(15000)});
      const state = await response.json();
      if (!response.ok) { message(state.error || '重新连接请求失败。'); return; }
      render(state);
      message('');
    } catch {
      message(unconfirmed);
    } finally {
      posting = false;
      button.disabled = false;
      schedule(0);
    }
  });
  document.addEventListener('visibilitychange', () => document.hidden ? pause() : schedule(0));
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', () => schedule(0));
  schedule(0);
}

export const appearanceScript = '(' + setupAppearance.toString() + ')();document.addEventListener("DOMContentLoaded",' + watchConnection.toString() + ');';
export const scriptHash = createHash('sha256').update(appearanceScript).digest('base64');

export const themeStyles = `
.topbar { display:flex; align-items:center; justify-content:space-between; gap:.7rem; padding:.55rem 0 }
.chooser { display:none; align-items:center; gap:.5rem; font-size:.85rem }
.interactive .chooser { display:flex }
.chooser button { min-height:2.1rem; font-size:.85rem; padding:.25rem .65rem }
.chooser button[aria-pressed=true] { color:var(--paper); background:var(--ink) }
.crumb { font-size:.85rem; color:var(--muted) }
.menu,.brand,.nav-icon { display:none }
.connection-actions { margin:0 0 2rem }
.unit input { flex:1 }
.unit span { white-space:nowrap }
:root[data-theme=discord] {
  color-scheme:dark;
  --paper:#25262b; --ink:#f1f1f5; --muted:#c2c3ce; --line:#43444e; --field:#212228;
  --edge:#646570; --accent:#c3c1ff; --on:#75dfae; --panel:#2d2e36; --sidebar:#1b1c21;
  main { max-width:none; padding:0 }
  .settings { display:grid; grid-template-columns:clamp(12rem,20vw,15rem) minmax(0,1fr);
    grid-template-rows:auto auto 1fr; min-height:100vh; align-items:start }
  .layout { display:contents }
  nav { grid-column:1; grid-row:1/4; height:100vh; overflow:auto; top:0; background:var(--sidebar);
    border-right:1px solid var(--line); padding:1.8rem 1rem; display:block }
  .brand { display:flex; align-items:center; gap:.7rem; border-bottom:1px solid var(--line); padding:0 .4rem 1.4rem; margin-bottom:1.2rem }
  .brand b { display:block; font-size:1.2rem; line-height:1.3 }
  .brand svg { width:2.65rem; height:2.65rem; flex:none; border-radius:.7rem; padding:.2rem; background:#5c58cf; color:white }
  .nav-title { font-size:.84rem; margin:.25rem .6rem .5rem }
  nav a { display:flex; align-items:center; gap:.6rem; width:100%; padding:.52rem .65rem;
    text-decoration:none; border-radius:.4rem; color:var(--muted) }
  nav a:hover,nav a[aria-current] { background:#393952; color:#eeedff; text-decoration:none }
  .nav-icon { display:inline-block; width:1.15rem; height:1.15rem; flex:none; vertical-align:-.15em }
  .topbar,header,.panels { grid-column:2; width:100%; padding-inline:clamp(1.4rem,5vw,4rem) }
  .topbar { grid-row:1; min-height:3.9rem; border-bottom:1px solid var(--line) }
  .chooser { background:var(--field); padding:.18rem; border-radius:.45rem; border:1px solid var(--line); gap:.12rem }
  .chooser button { border-color:transparent; background:transparent; border-radius:.3rem; color:var(--muted) }
  .chooser button[aria-pressed=true] { background:#444457; color:#f6f5ff }
  header,.panels { max-width:65rem; margin-inline:auto }
  header { grid-row:2; border:0 }
  .hero { padding:1.7rem 0 1rem }
  h1 { font-size:clamp(1.75rem,3vw,2.25rem); letter-spacing:-.035em }
  .context,.mark { display:none }
  .summary { border:1px solid var(--line); border-radius:.75rem; background:var(--panel); padding:.8rem 0; grid-template-columns:1fr 1.3fr .85fr }
  .summary>div,.summary>div:first-child { padding:.12rem 1rem }
  .summary dt { font-size:.82rem }
  .online::before { content:""; display:inline-block; width:.55rem; height:.55rem; margin-right:.45rem; border-radius:100%; background:var(--on) }
  .panels { grid-row:3; padding-bottom:2rem }
  section { border:0; padding:1.45rem 0 0 }
  h2 { font-size:1.35rem; margin:0 0 .75rem; letter-spacing:-.02em }
  h2 .nav-icon { color:var(--accent); margin-right:.45rem }
  .inactive { display:none }
  .card,.limit { background:var(--panel); border:1px solid var(--line); border-radius:.7rem; padding:.25rem 1rem }
  .card>.help,.card>p { margin:.55rem 0 }
  .field { align-items:start; grid-template-columns:minmax(7rem,1fr) minmax(0,1.5fr); margin:0; padding:.8rem 0 }
  .field+.field { border-top:1px solid var(--line) }
  input:not([type=checkbox],[type=hidden]),textarea,select { border-radius:.4rem }
  button { border-color:transparent; border-radius:.4rem; background:#444550; color:var(--ink) }
  button:hover:enabled { background:#515361; color:white }
  button.primary { color:white; background:#5653cf }
  button.primary:hover:enabled { background:#4745b5 }
  .connection-actions { margin:1rem 0 .35rem }
  .limit { padding:.8rem 1rem; margin:.5rem 0 }
  .detail { margin:clamp(1rem,5vw,4rem) auto; border:1px solid var(--line); background:var(--panel); padding:1.5rem; border-radius:.7rem }
  @media(max-width:48rem) {
    .settings { display:block }
    .topbar,header,.panels { padding-inline:1rem }
    .topbar { min-height:3.4rem }
    nav { position:static; height:auto; padding:.6rem 1rem; border-bottom:1px solid var(--line) }
    &.interactive nav:not(.open) { display:none }
    .brand,.nav-title { display:none }
    .topbar .menu { font-size:.88rem; padding:.2rem .5rem; min-height:2.1rem }
    .crumb { margin-right:auto }
  }
  @media(max-width:35rem) {
    .summary>div,.summary>div:first-child { grid-column:auto; border-bottom:0; padding:.1rem .5rem }
    .summary>div+div { border-inline-start:1px solid var(--line) }
    .summary dd { font-size:.94rem }
    .field { grid-template-columns:minmax(0,1fr) }
    .detail { margin:1rem }
  }
}
@media(max-width:48rem) { html.interactive[data-theme=discord] .menu { display:inline-flex } }
@media(max-width:23rem) { .crumb { display:none } .topbar { justify-content:flex-end } .menu { margin-right:auto } }
`;
