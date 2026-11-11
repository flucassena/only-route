const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';

// Password input with a button to show/hide what is typed.
function pwField(id, value, placeholder) {
  return `<div class="pwbox"><input type="password" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
    <button type="button" class="icon eye" data-act="eye" data-id="${id}" title="Mostrar senha">${EYE}</button></div>`;
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

// ------------------------------------------------------------------ header

function renderStatus() {
  const dot = $('dot');
  const vpn = vpns.find((v) => v.id === st.vpnId);
  const name = vpn ? vpn.name : st.vpnId || '';
  let text = 'Desligada', cls = '';
  switch (st.phase) {
    case 'checking': text = 'Verificando...'; break;
    case 'nodocker': text = 'Docker Desktop não está rodando'; cls = 'bad'; break;
    case 'building': case 'connecting': text = st.message || 'Conectando...'; cls = 'busy'; break;
    case 'code': text = 'Esperando o código'; cls = 'busy'; break;
    case 'connected': text = `Ligada: ${name}`; cls = 'ok'; break;
    case 'error': text = 'Não conectou'; cls = 'bad'; break;
  }
  dot.className = 'dot ' + cls;
  $('statusText').textContent = text;
}

// ------------------------------------------------------------------ list

function panelFor(v) {
  if (askPw === v.id) {
    return `<div class="panel">
      <label><span>Senha de ${esc(v.user || v.name)}</span>
        <div class="inline">${pwField('pw', '', '')}
        <button class="primary" data-act="pw-go" data-id="${esc(v.id)}">Entrar</button></div>
        <div class="check"><input type="checkbox" id="pwSave"><label for="pwSave" style="margin:0">Lembrar a senha neste PC</label></div>
      </label>
      <button class="link" data-act="pw-cancel">Cancelar</button>
    </div>`;
  }
  if (st.vpnId !== v.id) return '';
  switch (st.phase) {
    case 'building':
    case 'connecting':
      return `<div class="panel"><div class="row"><div class="msg grow"><span class="spin"></span>${esc(st.message || 'Conectando...')}</div>
        <button data-act="cancel">Cancelar</button></div></div>`;
    case 'code':
      return `<div class="panel">
        <label><span>Código de verificação (2FA)</span>
          <div class="inline"><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12">
          <button class="primary" data-act="code-go">Enviar</button></div>
        </label>
        <button class="link" data-act="cancel">Cancelar</button>
      </div>`;
    case 'connected':
      return `<div class="panel"><div class="good">Conectada</div>
        <div class="hint">Os sites desta VPN já funcionam em qualquer programa. Pode fechar o app: a VPN continua ligada.</div></div>`;
    case 'error':
      return `<div class="panel"><pre class="err">${esc(st.message)}</pre><button data-act="dismiss">OK</button></div>`;
  }
  return '';
}

function renderList() {
  const main = $('main');
  let html = '';
  if (notice) {
    html += `<div class="notice"><div class="grow">${esc(notice.text)}</div>
      ${notice.action ? `<button class="primary" data-act="notice-go">${esc(notice.action.label)}</button>` : ''}
      <button class="icon" data-act="notice-close" title="Fechar">✕</button></div>`;
  }
  if (hs.pending) {
    const parts = [...hs.add.map((h) => '+ ' + h), ...hs.remove.map((h) => '− ' + h)];
    if (!parts.length) parts.push('atualizar as linhas antigas para o OnlyRoute');
    html += `<div class="notice warn"><div class="grow"><b>Mudanças no arquivo hosts ainda não aplicadas</b>
      <div class="pend">${parts.map((p) => `<span>${esc(p)}</span>`).join('')}</div>
      <div class="hint">O sistema pede permissão de administrador. Ao conectar, isso também é aplicado.</div></div>
      <button class="primary" data-act="hosts-apply">Aplicar</button></div>`;
  }
  if (st.phase === 'nodocker') {
    html += `<div class="notice"><div class="grow">Abra o Docker Desktop e espere ele terminar de iniciar.</div>
      <button data-act="dismiss">Tentar de novo</button></div>`;
  }
  if (!vpns.length) {
    html += `<div class="empty">Nenhuma VPN cadastrada.<br><br>
      <button class="primary" data-act="add">Adicionar VPN</button><br><br>
      <button class="link" data-act="import">ou importar o vpns.json do script</button></div>`;
  }
  const busy = BUSY.includes(st.phase) || st.phase === 'checking' || st.phase === 'nodocker';
  for (const v of vpns) {
    const mine = st.vpnId === v.id;
    const connected = mine && st.phase === 'connected';
    const sites = v.forward || [];
    const chips = sites.slice(0, 4).map((s) => isApplied(s)
      ? `<span class="chip">${esc(s)}</span>`
      : `<span class="chip pending" title="Ainda não aplicado no arquivo hosts">${esc(s)} · pendente</span>`).join('')
      + (sites.length > 4 ? `<span class="chip">+${sites.length - 4}</span>` : '')
      + (sites.length ? '' : '<span class="chip">nenhum site</span>');
    const btn = connected
      ? `<button data-act="disconnect">Desconectar</button>`
      : (mine && BUSY.includes(st.phase)) || askPw === v.id ? ''
      : `<button class="primary" data-act="connect" data-id="${esc(v.id)}" ${busy || askPw ? 'disabled' : ''}>Conectar</button>`;
    html += `<div class="card ${mine && st.phase !== 'idle' ? 'active' : ''}" data-edit="${esc(v.id)}" title="Dois cliques para editar">
      <div class="row">
        <div class="grow"><div class="name">${esc(v.name)}</div>
          <div class="sub">${esc(v.user || 'sem usuário')} @ ${esc(v.gateway)}:${esc(v.port)}</div></div>
        <button class="icon" data-act="edit" data-id="${esc(v.id)}" title="Editar">✎</button>
        ${btn}
      </div>
      <div class="chips">${chips}</div>
      ${panelFor(v)}
    </div>`;
  }
  // Connected through the script with a VPN this app doesn't know.
  if (st.phase === 'connected' && !vpns.some((v) => v.id === st.vpnId)) {
    html += `<div class="card active"><div class="row"><div class="grow"><div class="name">${esc(st.vpnId || 'VPN')}</div>
      <div class="sub">ligada pelo script</div></div><button data-act="disconnect">Desconectar</button></div></div>`;
  }
  main.innerHTML = html;
  const focus = $('code') || $('pw');
  if (focus) focus.focus();
}

// ------------------------------------------------------------------ form

function renderForm() {
  const v = editing || { name: '', gateway: '', port: 10443, user: '', forward: [], trustedCert: '' };
  $('main').innerHTML = `
    <h2 style="font-size:16px;margin:4px 0 16px">${editing ? 'Editar VPN' : 'Nova VPN'}</h2>
    <section class="box"><div class="box-title">Conexão</div>
    <label><span>Nome</span><input id="f-name" value="${esc(v.name)}" placeholder="Empresa - Sede"></label>
    <div class="two">
      <label><span>Gateway remoto</span><input id="f-gateway" value="${esc(v.gateway)}" placeholder="vpn.empresa.com.br"></label>
      <label><span>Porta</span><input id="f-port" value="${esc(v.port)}" inputmode="numeric"></label>
    </div>
    <details class="adv" ${v.trustedCert ? 'open' : ''}><summary>Avançado</summary>
      <label><span>Certificado confiável do gateway (SHA-256)</span><input id="f-cert" value="${esc(v.trustedCert || '')}" placeholder="só se o gateway tiver certificado inválido">
      <div class="hint">A mensagem de erro de certificado mostra esse valor. Confira com a TI antes de usar.</div></label>
    </details>
    </section>
    <section class="box"><div class="box-title">Login</div>
    <label><span>Usuário</span><input id="f-user" value="${esc(v.user)}" autocomplete="off"></label>
    <label><span>Senha</span>${pwField('f-password', editPw, 'opcional: se ficar vazia, pergunta ao conectar')}
      <div class="hint">Usuário e senha ficam no cofre de senhas do sistema.</div>
    </label>
    </section>
    <section class="box"><div class="box-title">Sites que passam pela VPN <span class="count" id="siteCount"></span></div>
      <div class="inline"><input id="f-site" placeholder="gitlab.empresa.com.br ou a URL inteira">
        <button class="primary" data-act="site-add">+ Adicionar</button></div>
      <div class="hint">Só esses sites passam pela VPN; o resto continua na internet normal.</div>
      <div class="sites" id="sites"></div>
    </section>
    <div class="row formbar">
      <button class="primary" data-act="form-save">Salvar</button>
      <button data-act="form-cancel">Cancelar</button>
      <span class="grow"></span>
      ${editing ? '<button class="danger" data-act="form-delete">Excluir</button>' : ''}
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
        const badge = !saved.has(s) ? '<span class="badge new">novo</span>'
          : isApplied(s) ? '<span class="badge ok">aplicado</span>'
          : '<span class="badge pend">pendente</span>';
        return `<div class="site"><span class="grow">${esc(s)}</span>${badge}
          <button class="icon" data-act="site-del" data-id="${i}" title="Remover">✕</button></div>`;
      }).join('')
    : '<div class="site muted">Nenhum site ainda.</div>';
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
  renderStatus();
  $('footer').classList.toggle('hidden', view !== 'list');
  if (view === 'list') renderList(); else renderForm();
}

function hostsWarning(r) {
  if (r && r.hostsOk === false) setNotice('O arquivo hosts não foi atualizado (a permissão foi negada). Os sites novos só funcionam depois disso. Ele tenta de novo ao conectar.');
}

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
    btn.title = show ? 'Ocultar senha' : 'Mostrar senha';
    input.focus();
  },
  'site-add'() { addSiteFromInput(); },
  'site-del'(i) { formSites.splice(+i, 1); renderSites(); },
  async 'hosts-apply'() {
    setNotice('Aplicando... clique em "Sim" no pedido de permissão do Windows.');
    const r = await window.api.hostsApply();
    notice = null;
    await reload();
    if (!r.hostsOk) setNotice('O arquivo hosts não foi alterado (a permissão foi negada).');
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
    if (!data.name.trim() || !data.gateway.trim()) { alert('Preencha pelo menos o nome e o gateway.'); return; }
    view = 'list';
    setNotice('Salvando...');
    const r = await window.api.save(data);
    notice = null;
    await reload();
    if (r.error) setNotice(r.error);
    if (r.needsReconnect) {
      setNotice('Os sites mudaram. Reconecte para aplicar (vai pedir o código de novo).', { label: 'Reconectar', fn: () => startConnect(r.id) });
    }
  },
  async 'form-delete'() {
    if (!confirm(`Excluir a VPN "${editing.name}"?`)) return;
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
  'code-go'() {
    const code = $('code').value.trim();
    if (code) window.api.code(code);
  },
  cancel() { window.api.disconnect(); },
  disconnect() { window.api.disconnect(); },
  dismiss() { window.api.dismiss(); },
  'notice-close'() { setNotice(null); },
  'notice-go'() { const fn = notice.action.fn; setNotice(null); fn(); },
  async import() {
    const r = await window.api.importFile();
    if (!r) return;
    await reload();
    if (r.error) return setNotice(r.error);
    setNotice(r.added ? `${r.added} VPN(s) importada(s).` : 'Nenhuma VPN nova nesse arquivo.');
  },
  async 'hosts-remove'() {
    if (!confirm('Tirar do arquivo hosts todas as linhas do OnlyRoute? Desconecta a VPN. Os sites voltam a ir pela internet normal (use isso antes de voltar ao FortiClient).')) return;
    const r = await window.api.hostsRemove();
    await reload();
    setNotice(r.hostsOk ? 'Arquivo hosts limpo. Ao conectar de novo, as linhas voltam.' : 'O arquivo hosts não foi alterado (a permissão foi negada).');
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
  if (e.target.closest('button, input, textarea, .panel')) return;
  const card = e.target.closest('[data-edit]');
  if (card && view === 'list') { window.getSelection().removeAllRanges(); actions.edit(card.dataset.edit); }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset.id);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code') actions['code-go']();
  if (e.target.id === 'pw') actions['pw-go'](askPw);
  if (e.target.id === 'f-site') addSiteFromInput();
});

$('addBtn').onclick = () => actions.add();
$('importBtn').onclick = () => actions.import();
$('hostsBtn').onclick = () => actions['hosts-remove']();

window.api.onState((s) => {
  if (JSON.stringify(s) === JSON.stringify(st)) return;
  const wasConnecting = BUSY.includes(st.phase);
  st = s;
  if (wasConnecting && !BUSY.includes(s.phase)) { reload(); return; } // connect may have updated hosts
  if (view === 'list') render(); else renderStatus();
});

(async () => {
  st = await window.api.state();
  await reload();
})();
