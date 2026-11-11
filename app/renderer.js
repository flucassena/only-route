const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Portuguese or English, the same choice main.js makes. L('texto', 'text').
let lang = 'pt';
const L = (pt, en) => (lang === 'pt' ? pt : en);

let vpns = [];
let st = { phase: 'checking' };
let view = 'list';      // list | form
let editing = null;     // vpn being edited (null = new)
let notice = null;      // { text, action?: { label, fn } }
let askPw = null;       // id of the VPN waiting for a typed password
let hs = { add: [], remove: [], pending: false, applied: [] }; // hosts file vs. config
let formSites = [];     // sites list while editing
let editPw = '';        // saved password, shown hidden in the form

const EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const PASTE = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';
const ALERT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
let logOpen = false; // keeps "Show full log" open across re-renders
const GLOBE ='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

// Password input with a button to show/hide what is typed.
function pwField(id, value, placeholder) {
  return `<div class="pwbox"><input type="password" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
    <button type="button" class="icon eye" data-act="eye" data-id="${id}" title="${L('Mostrar senha', 'Show password')}">${EYE}</button></div>`;
}

const BUSY = ['connecting', 'building', 'code'];

async function reload() {
  [vpns, hs] = await Promise.all([window.api.list(), window.api.hostsStatus()]);
  render();
}

const siteHost = (s) => s.replace(/:\d+$/, '');
const isApplied = (s) => hs.applied.includes(siteHost(s)) && !hs.add.includes(siteHost(s));

function setNotice(text, action) {
  notice = text ? { text, action } : null;
  render();
}

// ------------------------------------------------------------------ dialog
// Replaces the system confirm()/alert() boxes with one that matches the app.
// Resolves true when the main button is clicked (or Enter), false otherwise.
function dialog({ title, text, ok, cancel = L('Cancelar', 'Cancel'), danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${esc(title)}</div>
      ${text ? `<div class="modal-text">${esc(text)}</div>` : ''}
      <div class="modal-actions">
        ${cancel ? `<button data-m="no">${esc(cancel)}</button>` : ''}
        <button class="${danger ? 'danger-fill' : 'primary'}" data-m="yes">${esc(ok)}</button>
      </div></div>`;
    const done = (v) => { document.removeEventListener('keydown', key, true); wrap.remove(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (b) done(b.dataset.m === 'yes');
      else if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-m="yes"]').focus();
  });
}

// ------------------------------------------------------------------ header

function renderStatus() {
  const dot = $('dot');
  const vpn = vpns.find((v) => v.id === st.vpnId);
  const name = vpn ? vpn.name : st.vpnId || '';
  let text = L('Desligada', 'Off'), cls = '';
  switch (st.phase) {
    case 'checking': text = L('Verificando...', 'Checking...'); break;
    case 'nodocker':
      if (st.installed === false) { text = L('Docker não instalado', 'Docker not installed'); cls = 'bad'; }
      else if (st.starting || st.vpnId) { text = L('Esperando o Docker abrir...', 'Waiting for Docker to open...'); cls = 'busy'; }
      else { text = L('O Docker não está aberto', 'Docker is not open'); cls = 'bad'; }
      break;
    case 'building': case 'connecting': text = st.message || L('Conectando...', 'Connecting...'); cls = 'busy'; break;
    case 'code': text = L('Esperando o código', 'Waiting for the code'); cls = 'busy'; break;
    case 'connected': text = L(`Ligada: ${name}`, `On: ${name}`); cls = 'ok'; break;
    case 'error': text = L('Não conectou', 'Could not connect'); cls = 'bad'; break;
  }
  dot.className = 'dot ' + cls;
  $('statusText').textContent = text;
}

// Texts that live in index.html.
function renderChrome() {
  document.documentElement.lang = L('pt-BR', 'en');
  $('addBtn').textContent = L('+ Adicionar VPN', '+ Add VPN');
  $('importBtn').textContent = L('Importar VPNs', 'Import VPNs');
  $('importBtn').title = L('Trazer as VPNs do vpns.json do script', 'Bring in the VPNs from the script\'s vpns.json');
  $('hostsBtn').textContent = L('Limpar hosts', 'Clean hosts');
  $('hostsBtn').title = L('Tirar as linhas do OnlyRoute do arquivo hosts', 'Remove the OnlyRoute lines from the hosts file');
  // Shows the language in use, highlighted; click the other one to switch.
  $('langBtn').innerHTML = `${GLOBE}<span class="seg ${lang === 'pt' ? 'on' : ''}" data-lang="pt">PT</span><span class="seg ${lang === 'en' ? 'on' : ''}" data-lang="en">EN</span>`;
  $('langBtn').title = L('Idioma: português', 'Language: English');
  renderUpdate();
}

// The "Update" button next to the language switch: only shows when the latest
// GitHub release is newer than this app.
let upd = { phase: 'none' };
const DOWNLOAD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
function renderUpdate() {
  const b = $('updBtn');
  b.classList.toggle('hidden', upd.phase === 'none');
  b.disabled = upd.phase === 'downloading' || upd.phase === 'installing';
  b.className = 'small upd' + (upd.phase === 'none' ? ' hidden' : '') + (upd.phase === 'error' ? ' bad' : '');
  b.style.setProperty('--p', upd.phase === 'downloading' ? `${Math.round((upd.progress || 0) * 100)}%` : '0%');
  const v = upd.version ? ` v${upd.version}` : '';
  let text = '';
  switch (upd.phase) {
    case 'available': text = L(`Atualizar para${v}`, `Update to${v}`); break;
    case 'downloading': text = L(`Baixando... ${Math.round((upd.progress || 0) * 100)}%`, `Downloading... ${Math.round((upd.progress || 0) * 100)}%`); break;
    case 'installing': text = L('Instalando... o app reabre sozinho', 'Installing... the app reopens by itself'); break;
    case 'manual': text = L('Abra o instalador baixado', 'Open the downloaded installer'); break;
    case 'error': text = L('Falhou. Tentar de novo', 'Failed. Try again'); break;
  }
  b.innerHTML = `${DOWNLOAD}<span>${esc(text)}</span>`;
  b.title = upd.phase === 'error' ? upd.message || '' : L(`Nova versão${v} disponível`, `New version${v} available`);
}

// ------------------------------------------------------------------ list

function panelFor(v) {
  if (askPw === v.id) {
    return `<div class="panel">
      <label><span>${L('Senha de', 'Password for')} ${esc(v.user || v.name)}</span>
        <div class="inline">${pwField('pw', '', '')}
        <button class="primary" data-act="pw-go" data-id="${esc(v.id)}">${L('Entrar', 'Sign in')}</button>
        <button data-act="pw-cancel">${L('Cancelar', 'Cancel')}</button></div>
        <div class="check"><input type="checkbox" id="pwSave"><label for="pwSave" style="margin:0">${L('Lembrar a senha neste PC', 'Remember the password on this PC')}</label></div>
      </label>
    </div>`;
  }
  if (st.vpnId !== v.id) return '';
  switch (st.phase) {
    case 'nodocker':
      return `<div class="panel"><div class="row"><div class="msg grow"><span class="spin"></span>${L('Esperando o Docker abrir. Conecta sozinho assim que ele estiver pronto.', 'Waiting for Docker to open. It connects by itself as soon as Docker is ready.')}</div>
        <button data-act="docker-cancel">${L('Cancelar', 'Cancel')}</button></div></div>`;
    case 'building':
    case 'connecting':
      return `<div class="panel"><div class="row"><div class="msg grow"><span class="spin"></span>${esc(st.message || L('Conectando...', 'Connecting...'))}</div>
        <button data-act="cancel">${L('Cancelar', 'Cancel')}</button></div></div>`;
    case 'code':
      return `<div class="panel">
        <label><span>${L('Código de verificação (2FA)', 'Verification code (2FA)')}</span>
          <div class="inline codebar"><div class="codebox"><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12">
          <button type="button" class="icon paste" data-act="code-paste" title="${L('Colar o código copiado', 'Paste the copied code')}">${PASTE}</button></div>
          <button class="primary" data-act="code-go">${L('Enviar', 'Send')}</button>
          <button data-act="cancel">${L('Cancelar', 'Cancel')}</button></div>
        </label>
      </div>`;
    case 'connected':
      return `<div class="panel"><div class="good">${L('Conectada', 'Connected')}</div>
        <div class="hint">${L('Os sites desta VPN já funcionam em qualquer programa. Pode fechar o app: a VPN continua ligada.', 'The sites of this VPN now work in any program. You can close the app: the VPN stays on.')}</div></div>`;
    case 'error':
      return `<div class="panel">
        <div class="errbox">
          <div class="err-title">${ALERT}<span>${esc(st.message)}</span></div>
          ${st.hint ? `<div class="err-hint">${esc(st.hint)}</div>` : ''}
        </div>
        ${st.log ? `<details class="logbox" ${logOpen ? 'open' : ''}><summary>${L('Ver log completo', 'Show full log')}</summary>
          <pre class="log">${esc(st.log)}</pre>
          <button class="small" data-act="log-copy">${L('Copiar log', 'Copy log')}</button></details>` : ''}
        <div class="row" style="margin-top:12px">
          <button class="primary" data-act="retry" data-id="${esc(v.id)}">${L('Tentar de novo', 'Try again')}</button>
          <button data-act="dismiss">${L('Fechar', 'Close')}</button>
        </div>
      </div>`;
  }
  return '';
}

function renderList() {
  const main = $('main');
  let html = '';
  if (notice) {
    html += `<div class="notice"><div class="grow">${esc(notice.text)}</div>
      ${notice.action ? `<button class="primary" data-act="notice-go">${esc(notice.action.label)}</button>` : ''}
      <button class="icon" data-act="notice-close" title="${L('Fechar', 'Close')}">✕</button></div>`;
  }
  if (hs.pending) {
    const parts = [...hs.add.map((h) => '+ ' + h), ...hs.remove.map((h) => '− ' + h)];
    if (!parts.length) parts.push(L('atualizar as linhas antigas para o OnlyRoute', 'update the old lines for OnlyRoute'));
    html += `<div class="notice warn"><div class="grow"><b>${L('Mudanças no arquivo hosts ainda não aplicadas', 'Changes to the hosts file not applied yet')}</b>
      <div class="pend">${parts.map((p) => `<span>${esc(p)}</span>`).join('')}</div>
      <div class="hint">${L('O sistema pede permissão de administrador. Ao conectar, isso também é aplicado.', 'The system asks for administrator permission. Connecting also applies it.')}</div></div>
      <button class="primary" data-act="hosts-apply">${L('Aplicar', 'Apply')}</button></div>`;
  }
  if (st.phase === 'nodocker') {
    if (st.installed === false) {
      html += `<div class="notice warn"><div class="grow"><b>${L('O Docker não está instalado', 'Docker is not installed')}</b>
        <div class="hint">${L('O OnlyRoute usa o Docker Desktop para rodar a VPN. Instale, abra uma vez e volte aqui: o app percebe sozinho.', 'OnlyRoute uses Docker Desktop to run the VPN. Install it, open it once and come back here: the app notices by itself.')}</div></div>
        <button class="primary" data-act="docker-download">${L('Baixar o Docker', 'Download Docker')}</button></div>`;
    } else if (st.starting || st.vpnId) {
      html += `<div class="notice"><div class="grow" style="white-space:normal"><div class="msg"><span class="spin"></span><b>${L('Abrindo o Docker...', 'Opening Docker...')}</b></div>
        <div class="hint">${L('Pode levar até 1 minuto. Se ele pedir para aceitar os termos ou fazer login, aceite e pode pular o login. O app continua sozinho quando ele ficar pronto.', 'It can take up to 1 minute. If it asks you to accept the terms or sign in, accept them; you can skip the sign-in. The app goes on by itself once Docker is ready.')}</div></div></div>`;
    } else {
      html += `<div class="notice warn"><div class="grow"><b>${L('O Docker não está aberto', 'Docker is not open')}</b>
        <div class="hint">${L('O OnlyRoute precisa dele para conectar. Clique em "Abrir o Docker" (ou só clique em Conectar: ele abre sozinho).', 'OnlyRoute needs it to connect. Click "Open Docker" (or just click Connect: it opens Docker by itself).')}</div></div>
        <button class="primary" data-act="docker-open">${L('Abrir o Docker', 'Open Docker')}</button></div>`;
    }
  }
  if (!vpns.length) {
    html += `<div class="empty">${L('Nenhuma VPN cadastrada.', 'No VPNs yet.')}<br><br>
      <button class="primary" data-act="add">${L('Adicionar VPN', 'Add VPN')}</button><br><br>
      <button class="link" data-act="import">${L('ou importar o vpns.json do script', 'or import the script\'s vpns.json')}</button></div>`;
  }
  // With Docker closed, Conectar still works: it opens Docker and waits for it.
  const waitingDocker = st.phase === 'nodocker' && (!!st.vpnId || st.installed === false);
  const busy = BUSY.includes(st.phase) || st.phase === 'checking' || waitingDocker;
  for (const v of vpns) {
    const mine = st.vpnId === v.id;
    const connected = mine && st.phase === 'connected';
    const sites = v.forward || [];
    const chips = sites.slice(0, 4).map((s) => isApplied(s)
      ? `<a class="chip site-link" data-act="open-site" data-id="${esc(s)}" title="${L('Abrir no navegador', 'Open in the browser')}">${esc(s)}</a>`
      : `<a class="chip site-link pending" data-act="open-site" data-id="${esc(s)}" title="${L('Ainda não aplicado no arquivo hosts. Clique para abrir no navegador', 'Not applied to the hosts file yet. Click to open in the browser')}">${esc(s)} · ${L('pendente', 'pending')}</a>`).join('')
      + (sites.length > 4 ? `<span class="chip">+${sites.length - 4}</span>` : '')
      + (sites.length ? '' : `<span class="chip">${L('nenhum site', 'no sites')}</span>`);
    const btn = connected
      ? `<button data-act="disconnect">${L('Desconectar', 'Disconnect')}</button>`
      : (mine && (BUSY.includes(st.phase) || st.phase === 'nodocker' || st.phase === 'error')) || askPw === v.id ? ''
      : `<button class="primary" data-act="connect" data-id="${esc(v.id)}" ${busy || askPw ? 'disabled' : ''}>${L('Conectar', 'Connect')}</button>`;
    html += `<div class="card ${mine && st.phase !== 'idle' ? 'active' : ''}" data-edit="${esc(v.id)}" title="${L('Dois cliques para editar', 'Double-click to edit')}">
      <div class="row">
        <div class="grow"><div class="name">${esc(v.name)}</div>
          <div class="sub">${esc(v.user || L('sem usuário', 'no user'))} @ ${esc(v.gateway)}:${esc(v.port)}</div></div>
        <button class="icon" data-act="edit" data-id="${esc(v.id)}" title="${L('Editar', 'Edit')}">✎</button>
        ${btn}
      </div>
      <div class="chips">${chips}</div>
      ${panelFor(v)}
    </div>`;
  }
  // Connected through the script with a VPN this app doesn't know.
  if (st.phase === 'connected' && !vpns.some((v) => v.id === st.vpnId)) {
    html += `<div class="card active"><div class="row"><div class="grow"><div class="name">${esc(st.vpnId || 'VPN')}</div>
      <div class="sub">${L('ligada pelo script', 'started by the script')}</div></div><button data-act="disconnect">${L('Desconectar', 'Disconnect')}</button></div></div>`;
  }
  main.innerHTML = html;
  const focus = $('code') || $('pw');
  if (focus) focus.focus();
}

// ------------------------------------------------------------------ form

function renderForm() {
  const v = editing || { name: '', gateway: '', port: 10443, user: '', forward: [], trustedCert: '' };
  $('main').innerHTML = `
    <h2 style="font-size:16px;margin:4px 0 16px">${editing ? L('Editar VPN', 'Edit VPN') : L('Nova VPN', 'New VPN')}</h2>
    <section class="box"><div class="box-title">${L('Conexão', 'Connection')}</div>
    <label><span>${L('Nome', 'Name')}</span><input id="f-name" value="${esc(v.name)}" placeholder="${L('Empresa - Sede', 'Company - Office')}"></label>
    <div class="two">
      <label><span>${L('Gateway remoto', 'Remote gateway')}</span><input id="f-gateway" value="${esc(v.gateway)}" placeholder="${L('vpn.empresa.com.br', 'vpn.company.com')}"></label>
      <label><span>${L('Porta', 'Port')}</span><input id="f-port" value="${esc(v.port)}" inputmode="numeric"></label>
    </div>
    <details class="adv" ${v.trustedCert ? 'open' : ''}><summary>${L('Avançado', 'Advanced')}</summary>
      <label><span>${L('Certificado confiável do gateway (SHA-256)', 'Trusted gateway certificate (SHA-256)')}</span><input id="f-cert" value="${esc(v.trustedCert || '')}" placeholder="${L('só se o gateway tiver certificado inválido', 'only if the gateway has an invalid certificate')}">
      <div class="hint">${L('A mensagem de erro de certificado mostra esse valor. Confira com a TI antes de usar.', 'The certificate error message shows this value. Check it with your IT team before using it.')}</div></label>
    </details>
    </section>
    <section class="box"><div class="box-title">Login</div>
    <label><span>${L('Usuário', 'User')}</span><input id="f-user" value="${esc(v.user)}" autocomplete="off"></label>
    <label><span>${L('Senha', 'Password')}</span>${pwField('f-password', editPw, L('opcional: se ficar vazia, pergunta ao conectar', 'optional: if empty, it asks when connecting'))}
      <div class="hint">${L('Usuário e senha ficam no cofre de senhas do sistema.', 'User and password are kept in the system password vault.')}</div>
    </label>
    </section>
    <section class="box"><div class="box-title">${L('Sites que passam pela VPN', 'Sites that go through the VPN')} <span class="count" id="siteCount"></span></div>
      <div class="inline"><input id="f-site" placeholder="${L('gitlab.empresa.com.br ou a URL inteira', 'gitlab.company.com or the full URL')}">
        <button class="primary" data-act="site-add">${L('+ Adicionar', '+ Add')}</button></div>
      <div class="hint">${L('Só esses sites passam pela VPN; o resto continua na internet normal.', 'Only these sites go through the VPN; everything else stays on the normal internet.')}</div>
      <div class="sites" id="sites"></div>
    </section>
    <div class="row formbar">
      <button class="primary" data-act="form-save">${L('Salvar', 'Save')}</button>
      <button data-act="form-cancel">${L('Cancelar', 'Cancel')}</button>
      <span class="grow"></span>
      ${editing ? `<button class="danger" data-act="form-delete">${L('Excluir', 'Delete')}</button>` : ''}
    </div>`;
  renderSites();
  $('f-name').focus();
}

// Same cleanup the app does when saving: host only, keeps a non-default port.
function cleanSite(s) {
  s = s.trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    return u.hostname.toLowerCase() + (u.port ? ':' + u.port : u.protocol === 'http:' ? ':80' : '');
  } catch { return ''; }
}

function renderSites() {
  const saved = new Set((editing && editing.forward) || []);
  $('siteCount').textContent = formSites.length ? `(${formSites.length})` : '';
  $('sites').innerHTML = formSites.length
    ? formSites.map((s, i) => {
        const badge = !saved.has(s) ? `<span class="badge new">${L('novo', 'new')}</span>`
          : isApplied(s) ? `<span class="badge ok">${L('aplicado', 'applied')}</span>`
          : `<span class="badge pend">${L('pendente', 'pending')}</span>`;
        return `<div class="site"><span class="grow">${esc(s)}</span>${badge}
          <button class="icon" data-act="site-del" data-id="${i}" title="${L('Remover', 'Remove')}">✕</button></div>`;
      }).join('')
    : `<div class="site muted">${L('Nenhum site ainda.', 'No sites yet.')}</div>`;
}

function addSiteFromInput() {
  const input = $('f-site');
  let added = false;
  for (const part of input.value.split(/[\s,;]+/)) {
    const s = cleanSite(part);
    if (s && !formSites.includes(s)) { formSites.push(s); added = true; }
  }
  if (input.value.trim() && !added && !formSites.includes(cleanSite(input.value))) { input.select(); return; }
  input.value = '';
  renderSites();
  input.focus();
}

// ------------------------------------------------------------------ render

function render() {
  renderChrome();
  renderStatus();
  $('footer').classList.toggle('hidden', view !== 'list');
  $('addBtn').classList.toggle('hidden', view !== 'list');
  if (view === 'list') renderList(); else renderForm();
}

function hostsWarning(r) {
  if (r && r.hostsOk === false) setNotice(L('O arquivo hosts não foi atualizado (a permissão foi negada). Os sites novos só funcionam depois disso. Ele tenta de novo ao conectar.', 'The hosts file was not updated (permission was denied). New sites only work after that. It tries again when connecting.'));
}

const denied = () => L('O arquivo hosts não foi alterado (a permissão foi negada).', 'The hosts file was not changed (permission was denied).');

// ------------------------------------------------------------------ actions

const actions = {
  add() { editing = null; formSites = []; editPw = ''; view = 'form'; notice = null; render(); },
  async edit(id) {
    editing = vpns.find((v) => v.id === id);
    formSites = [...(editing.forward || [])];
    editPw = editing.hasPassword ? await window.api.password(id) : '';
    view = 'form'; notice = null; render();
  },
  eye(id) {
    const input = $(id);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    const btn = input.nextElementSibling;
    btn.innerHTML = show ? EYE_OFF : EYE;
    btn.title = show ? L('Ocultar senha', 'Hide password') : L('Mostrar senha', 'Show password');
    input.focus();
  },
  'site-add'() { addSiteFromInput(); },
  'site-del'(i) { formSites.splice(+i, 1); renderSites(); },
  async 'hosts-apply'() {
    setNotice(L('Aplicando... clique em "Sim" no pedido de permissão do sistema.', 'Applying... click "Yes" on the system permission prompt.'));
    const r = await window.api.hostsApply();
    notice = null;
    await reload();
    if (!r.hostsOk) setNotice(denied());
  },
  'form-cancel'() { view = 'list'; render(); },
  async 'form-save'() {
    const data = {
      id: editing && editing.id,
      name: $('f-name').value,
      gateway: $('f-gateway').value,
      port: $('f-port').value,
      user: $('f-user').value,
      password: $('f-password').value,
      forward: [...formSites, ...$('f-site').value.split(/[\s,;]+/).map(cleanSite)].filter(Boolean),
      trustedCert: $('f-cert').value,
    };
    if (!data.name.trim() || !data.gateway.trim()) {
      await dialog({ title: L('Faltam dados', 'Missing information'), text: L('Preencha pelo menos o nome e o gateway.', 'Fill in at least the name and the gateway.'), ok: 'OK', cancel: null });
      return;
    }
    view = 'list';
    setNotice(L('Salvando...', 'Saving...'));
    const r = await window.api.save(data);
    notice = null;
    await reload();
    if (r.error) setNotice(r.error);
    if (r.needsReconnect) {
      setNotice(L('Os sites mudaram. Reconecte para aplicar (vai pedir o código de novo).', 'The sites changed. Reconnect to apply (it asks for the code again).'), { label: L('Reconectar', 'Reconnect'), fn: () => startConnect(r.id) });
    }
  },
  async 'form-delete'() {
    const ok = await dialog({
      title: L(`Excluir a VPN "${editing.name}"?`, `Delete the VPN "${editing.name}"?`),
      text: L('O usuário e a senha salvos dela também são apagados.', 'Its saved user and password are deleted too.'),
      ok: L('Excluir', 'Delete'), danger: true,
    });
    if (!ok) return;
    view = 'list';
    const r = await window.api.remove(editing.id);
    await reload();
    hostsWarning(r);
  },
  connect(id) { startConnect(id); },
  async 'pw-go'(id) {
    const pw = $('pw').value;
    if (!pw) return;
    const save = $('pwSave').checked;
    askPw = null;
    if (save) {
      const v = vpns.find((x) => x.id === id);
      await window.api.save({ ...v, password: pw });
      await reload();
    }
    window.api.connect(id, pw);
  },
  'pw-cancel'() { askPw = null; render(); },
  // Pastes the copied code; sends it right away when it is just digits.
  async 'code-paste'() {
    const text = String(await window.api.clipboardText()).replace(/\s+/g, '');
    const input = $('code');
    if (!input) return;
    input.value = text.slice(0, 12);
    input.focus();
    if (/^\d{4,12}$/.test(text)) actions['code-go']();
  },
  'open-site'(s) { window.api.openSite(s); },
  'code-go'() {
    const code = $('code').value.trim();
    if (code) window.api.code(code);
  },
  cancel() { window.api.disconnect(); },
  disconnect() { window.api.disconnect(); },
  dismiss() { logOpen = false; window.api.dismiss(); },
  async retry(id) { logOpen = false; await window.api.dismiss(); startConnect(id); },
  async 'log-copy'() {
    await window.api.clipboardWrite(st.log || '');
    const b = document.querySelector('[data-act="log-copy"]');
    if (b) { b.textContent = L('Copiado', 'Copied'); setTimeout(() => { b.textContent = L('Copiar log', 'Copy log'); }, 1500); }
  },
  'docker-open'() { window.api.dockerOpen(); },
  'docker-download'() { window.api.dockerDownload(); },
  'docker-cancel'() { window.api.dockerCancel(); },
  'notice-close'() { setNotice(null); },
  'notice-go'() { const fn = notice.action.fn; setNotice(null); fn(); },
  async import() {
    const r = await window.api.importFile();
    if (!r) return;
    await reload();
    if (r.error) return setNotice(r.error);
    setNotice(r.added ? L(`${r.added} VPN(s) importada(s).`, `${r.added} VPN(s) imported.`) : L('Nenhuma VPN nova nesse arquivo.', 'No new VPNs in this file.'));
  },
  async 'hosts-remove'() {
    const ok = await dialog({
      title: L('Limpar o arquivo hosts?', 'Clean the hosts file?'),
      text: L('Tira do arquivo hosts todas as linhas do OnlyRoute e desconecta a VPN. Os sites voltam a ir pela internet normal. Use antes de voltar ao FortiClient. Ao conectar de novo, as linhas voltam.',
        'Removes every OnlyRoute line from the hosts file and disconnects the VPN. The sites go back to the normal internet. Use it before going back to FortiClient. Connecting again puts the lines back.'),
      ok: L('Limpar hosts', 'Clean hosts'), danger: true,
    });
    if (!ok) return;
    const r = await window.api.hostsRemove();
    await reload();
    setNotice(r.hostsOk ? L('Arquivo hosts limpo. Ao conectar de novo, as linhas voltam.', 'Hosts file cleaned. Connecting again puts the lines back.') : denied());
  },
  async lang(l) {
    if (!l || l === lang) return;
    lang = await window.api.setLang(l);
    render();
  },
};

function startConnect(id) {
  const v = vpns.find((x) => x.id === id);
  if (!v) return;
  notice = null;
  if (!v.hasPassword) { askPw = id; render(); return; }
  window.api.connect(id);
}

// Double-click a VPN card (outside its buttons and fields) to edit it.
document.addEventListener('dblclick', (e) => {
  if (e.target.closest('button, a, input, textarea, .panel')) return;
  const card = e.target.closest('[data-edit]');
  if (card && view === 'list') { window.getSelection().removeAllRanges(); actions.edit(card.dataset.edit); }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset.id);
});

document.addEventListener('toggle', (e) => {
  if (e.target.classList && e.target.classList.contains('logbox')) logOpen = e.target.open;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code') actions['code-go']();
  if (e.target.id === 'pw') actions['pw-go'](askPw);
  if (e.target.id === 'f-site') addSiteFromInput();
});

$('addBtn').onclick = () => actions.add();
$('importBtn').onclick = () => actions.import();
$('hostsBtn').onclick = () => actions['hosts-remove']();
$('updBtn').onclick = () => {
  if (upd.phase === 'available' || upd.phase === 'error') window.api.updateGo();
  else if (upd.phase === 'manual') window.api.updatePage();
};
window.api.onUpdate((u) => { upd = u; renderUpdate(); });

$('langBtn').onclick = (e) => {
  const seg = e.target.closest('[data-lang]');
  actions.lang(seg ? seg.dataset.lang : lang === 'pt' ? 'en' : 'pt');
};

window.api.onState((s) => {
  if (JSON.stringify(s) === JSON.stringify(st)) return;
  const wasConnecting = BUSY.includes(st.phase);
  const wasHosts = hs.pending && st.phase === 'connecting' && s.message !== st.message;
  st = s;
  // connect may have updated hosts: recheck as soon as that step is over
  if ((wasConnecting && !BUSY.includes(s.phase)) || wasHosts) { reload(); return; }
  if (view === 'list') render(); else renderStatus();
});

(async () => {
  lang = await window.api.lang();
  upd = await window.api.updateInfo();
  st = await window.api.state();
  await reload();
})();
