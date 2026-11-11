// OnlyRoute: the same thing as onlyroute.ps1, with windows instead of a terminal.
// It uses the same Docker image, container name, hosts marker and vault entries,
// so the app and the script see each other's connection.
const { app, BrowserWindow, ipcMain, safeStorage, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const vault = require('./vault');

const NAME = 'onlyroute';
const IMAGE = 'onlyroute';
const LABEL = 'onlyroute.vpn';
const MARKER = '# onlyroute';
// Names used before the project was renamed: still recognized and cleaned up.
const LEGACY = { name: 'vpn-git', image: 'vpn-git', label: 'vpn-git.vpn' };
const isOurLine = (l) => /#\s*(onlyroute|vpn-git)\s*$/.test(l);
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOSTS = IS_WIN
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';
const DOCKER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'docker') : path.join(__dirname, '..');
// Where docker usually is when it is not on the PATH (apps opened from the
// Finder or the Start menu don't always get the shell's PATH).
const DOCKER_PATHS = {
  win32: ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'],
  darwin: ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'],
  linux: ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker'],
}[process.platform] || [];

let win = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------- processes

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e) });
    }
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, stdout: out, stderr: String(e), enoent: e.code === 'ENOENT' }));
    p.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
    if (input !== undefined) p.stdin.end(input);
  });
}

let dockerBin = 'docker';
async function docker(args, input) {
  let r = await run(dockerBin, args, input);
  const other = r.enoent && dockerBin === 'docker' && DOCKER_PATHS.find((p) => fs.existsSync(p));
  if (other) {
    dockerBin = other;
    r = await run(dockerBin, args, input);
  }
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- config

const configFile = () => path.join(app.getPath('userData'), 'config.json');

// Before the rename the app was called "vpn-git": bring its config along once.
try {
  const old = path.join(app.getPath('appData'), 'vpn-git', 'config.json');
  if (!fs.existsSync(configFile()) && fs.existsSync(old)) {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.copyFileSync(old, configFile());
  }
} catch {}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (Array.isArray(c.vpns)) return c;
  } catch {}
  return { vpns: [] };
}

function saveConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2), 'utf8');
}

// Old versions kept the password in config.json, encrypted with DPAPI. Only used
// to move those into the vault.
function decrypt(b64) {
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return ''; }
}

// Users and passwords: Windows Credential Manager (see vault.js). Kept in memory
// after the first read, so the vault is not asked again on every screen.
let credsPromise = null;
async function loadCreds() {
  const c = loadConfig();
  const legacy = c.vpns.filter((v) => 'user' in v || 'password' in v);
  if (legacy.length) {
    await vault.writeMany(legacy.map((v) => ({ id: v.id, user: v.user || '', pass: v.password ? decrypt(v.password) : '' })));
    for (const v of legacy) { delete v.user; delete v.password; }
    saveConfig(c);
  }
  const ids = c.vpns.map((v) => v.id);
  const found = await vault.readMany(ids);
  // Entries saved under the old name ("vpn-git:<id>") move to the new one.
  const missing = ids.filter((id, i) => !found[i]);
  if (missing.length) {
    const old = await vault.readLegacy(missing);
    const moved = missing.map((id, i) => old[i] && { id, user: old[i].user, pass: old[i].pass }).filter(Boolean);
    if (moved.length) {
      await vault.writeMany(moved);
      await vault.removeLegacy(moved.map((m) => m.id));
      for (const m of moved) found[ids.indexOf(m.id)] = { user: m.user, pass: m.pass };
    }
  }
  return new Map(ids.map((id, i) => [id, found[i] || { user: '', pass: '' }]));
}
function getCreds() {
  if (!credsPromise) credsPromise = loadCreds().catch((e) => { credsPromise = null; throw e; });
  return credsPromise;
}
async function setCred(id, user, pass) {
  await vault.write(id, user, pass);
  (await getCreds()).set(id, { user, pass });
}

// What the window gets: the VPN, its user, and whether a password is saved.
function publicVpn(v, cred = {}) {
  return { ...v, user: cred.user || '', hasPassword: !!cred.pass };
}

function slug(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vpn';
}

// "https://gitlab.x.com/grupo/proj" -> "gitlab.x.com"; keeps a non-default port.
function normalizeSite(s) {
  s = String(s || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    let h = u.hostname.toLowerCase();
    if (u.port) h += ':' + u.port;
    else if (u.protocol === 'http:') h += ':80';
    return h;
  } catch {
    return '';
  }
}

function parseForward(f) {
  const m = /^(.+):(\d+)$/.exec(f);
  return m ? { host: m[1].toLowerCase(), port: +m[2] } : { host: f.toLowerCase(), port: 443 };
}

// Every site gets a fixed local address: 127.0.0.1, .2, ... in order, across all
// VPNs (same rule as the script).
function hostIps(c) {
  const map = new Map();
  for (const v of c.vpns) {
    for (const f of v.forward || []) {
      const h = parseForward(f).host;
      if (!map.has(h)) map.set(h, `127.0.0.${map.size + 1}`);
    }
  }
  return map;
}

// ---------------------------------------------------------------- hosts file

function expectedHostsLines(c) {
  return [...hostIps(c)].map(([h, ip]) => `${ip} ${h} ${MARKER}`);
}

function currentHostsLines() {
  try {
    return fs.readFileSync(HOSTS, 'utf8').split(/\r?\n/).filter(isOurLine).map((l) => l.trim());
  } catch {
    return [];
  }
}

function hostsUpToDate(lines) {
  return currentHostsLines().join('\n') === lines.join('\n');
}

// Runs a shell command as root on macOS/Linux, with the system's own password
// dialog (macOS: osascript; Linux: pkexec/polkit).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function runAsRoot(script) {
  if (IS_MAC) {
    const as = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return run('osascript', ['-e', `do shell script "${as}" with administrator privileges`]);
  }
  return run('pkexec', ['sh', '-c', script]);
}

// macOS only has 127.0.0.1 on the loopback: 127.0.0.2 and up need an alias,
// and aliases are gone after a reboot. Returns the ones missing.
async function missingAliases() {
  if (!IS_MAC) return [];
  const ips = [...hostIps(loadConfig()).values()].filter((ip) => ip !== '127.0.0.1');
  if (!ips.length) return [];
  const out = (await run('ifconfig', ['lo0'])).stdout;
  return ips.filter((ip) => !out.includes(`inet ${ip} `));
}
async function ensureAliases() {
  const missing = await missingAliases();
  if (!missing.length) return true;
  await runAsRoot(missing.map((ip) => `ifconfig lo0 alias ${ip} up`).join('; '));
  return !(await missingAliases()).length;
}

// Writing the hosts file needs admin, so this asks for permission (Windows: UAC;
// macOS/Linux: password dialog) only for that one step. The app itself runs as
// a normal user.
async function writeHosts(lines) {
  if (hostsUpToDate(lines)) return true;
  if (!IS_WIN) return writeHostsUnix(lines);
  const tmp = path.join(os.tmpdir(), `onlyroute-hosts-${process.pid}.txt`);
  fs.writeFileSync(tmp, lines.join('\r\n'), 'ascii');
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const inner = [
    `$h = ${q(HOSTS)}`,
    `$m = '#\\s*(onlyroute|vpn-git)\\s*$'`,
    `$new = @(Get-Content ${q(tmp)} | Where-Object { $_ })`,
    `$keep = @(Get-Content $h | Where-Object { $_ -notmatch $m })`,
    `Set-Content -Path $h -Value ($keep + $new) -Encoding ascii`,
    `ipconfig /flushdns | Out-Null`,
  ].join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `try { Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit 0 } catch { exit 1 }`;
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', outer]);
  try { fs.unlinkSync(tmp); } catch {}
  return hostsUpToDate(lines);
}

async function writeHostsUnix(lines) {
  const keep = fs.readFileSync(HOSTS, 'utf8').split(/\r?\n/).filter((l) => !isOurLine(l));
  while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
  const tmp = path.join(os.tmpdir(), `onlyroute-hosts-${process.pid}.txt`);
  fs.writeFileSync(tmp, [...keep, ...lines].join('\n') + '\n', 'utf8');
  const flush = IS_MAC
    ? 'dscacheutil -flushcache; killall -HUP mDNSResponder'
    : '(resolvectl flush-caches || systemd-resolve --flush-caches) >/dev/null 2>&1';
  const aliases = (await missingAliases()).map((ip) => `ifconfig lo0 alias ${ip} up; `).join('');
  await runAsRoot(`${aliases}cat ${shq(tmp)} > /etc/hosts; ${flush}; true`);
  try { fs.unlinkSync(tmp); } catch {}
  return hostsUpToDate(lines);
}

const syncHosts = () => writeHosts(expectedHostsLines(loadConfig()));

// What still has to be written to the hosts file: sites to add (or whose
// address changed) and sites to take out.
function hostsStatus() {
  const want = hostIps(loadConfig());
  const have = new Map();
  for (const l of currentHostsLines()) {
    const [ip, host] = l.split(/\s+/);
    if (ip && host) have.set(host.toLowerCase(), ip);
  }
  const add = [...want].filter(([h, ip]) => have.get(h) !== ip).map(([h]) => h);
  const remove = [...have.keys()].filter((h) => !want.has(h));
  const inOrder = hostsUpToDate(expectedHostsLines(loadConfig()));
  return { add, remove, pending: !inOrder, applied: [...have.keys()] };
}

// ---------------------------------------------------------------- connection

// phase: checking | nodocker | idle | building | connecting | code | connected | error
let state = { phase: 'checking' };
let attempt = 0; // bumps on every connect/disconnect so old loops stop
let pendingCode = null;

function setState(s) {
  const was = state;
  state = s;
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  updateTray(was);
}

// ---------------------------------------------------------------- tray
// The app lives next to the clock: the icon shows if the VPN is on (green dot),
// connecting (amber) or off (gray). Closing the window only hides it.

const trayIcon = (name) => nativeImage.createFromPath(path.join(__dirname, 'build', `tray-${name}.png`)).resize({ width: 32, height: 32, quality: 'best' });

function vpnName(id) {
  const v = loadConfig().vpns.find((x) => x.id === id);
  return v ? v.name : id || 'VPN';
}

function statusText() {
  switch (state.phase) {
    case 'connected': return `Ligada: ${vpnName(state.vpnId)}`;
    case 'code': return 'Esperando o código de verificação';
    case 'building': case 'connecting': return state.message || 'Conectando...';
    case 'nodocker': return 'Docker Desktop não está rodando';
    case 'error': return 'Não conectou';
    case 'checking': return 'Verificando...';
    default: return 'Desligada';
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray(was = {}) {
  if (!tray) return;
  const busy = ['building', 'connecting', 'code'].includes(state.phase);
  tray.setImage(trayIcon(state.phase === 'connected' ? 'on' : busy ? 'busy' : 'off'));
  tray.setToolTip(`OnlyRoute: ${statusText()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: 'Abrir', click: showWindow },
    { label: 'Desconectar', enabled: state.phase === 'connected' || busy, click: () => disconnect() },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  // Tell the user when something changes while the window is hidden.
  if (win && !win.isVisible()) {
    if (state.phase === 'connected' && was.phase !== 'connected') {
      tray.displayBalloon({ title: 'VPN ligada', content: vpnName(state.vpnId) });
    } else if (was.phase === 'connected' && state.phase === 'idle') {
      tray.displayBalloon({ title: 'A VPN desligou', content: 'Abra o OnlyRoute para conectar de novo.', iconType: 'warning' });
    } else if (state.phase === 'code' && was.phase !== 'code') {
      showWindow(); // the 2FA code has to be typed in the window
    }
  }
}

async function readLog(name = NAME) {
  const tmp = path.join(os.tmpdir(), `onlyroute-log-${process.pid}.txt`);
  const r = await docker(['cp', `${name}:/run/vpn.log`, tmp]);
  if (r.code !== 0) return '';
  try { return fs.readFileSync(tmp, 'utf8'); } catch { return ''; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function logTail(log) {
  return log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-8).join('\n');
}

// Password and 2FA code go straight into openfortivpn through a pipe inside the
// container. Raw bytes: nothing is added or changed on the way.
async function sendInput(text) {
  const r = await docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /run/vpn-input'], Buffer.from(text + '\n', 'utf8'));
  return r.code === 0;
}

// The VPN container, if there is one (also one started under the old name).
async function containerInfo() {
  for (const name of [NAME, LEGACY.name]) {
    const r = await docker(['inspect', '-f', '{{.State.Running}}|{{json .Config.Labels}}', name]);
    if (r.code !== 0) continue;
    const out = r.stdout.trim();
    const cut = out.indexOf('|');
    let l = {};
    try { l = JSON.parse(out.slice(cut + 1)) || {}; } catch {}
    return { name, running: out.slice(0, cut) === 'true', vpn: l[LABEL] || l[LEGACY.label] || '' };
  }
  return null;
}

const removeContainers = () => docker(['rm', '-f', NAME, LEGACY.name]);

async function refresh() {
  if (['building', 'connecting', 'code'].includes(state.phase)) return;
  const v = await docker(['version', '--format', '{{.Server.Version}}']);
  if (v.code !== 0) return setState({ phase: 'nodocker' });
  const info = await containerInfo();
  if (info && info.running && /Tunnel is up/.test(await readLog(info.name))) {
    return setState({ phase: 'connected', vpnId: info.vpn });
  }
  if (state.phase !== 'error') setState({ phase: 'idle' });
}

async function connect(id, typedPassword) {
  const my = ++attempt;
  const live = () => my === attempt;
  const c = loadConfig();
  const v = c.vpns.find((x) => x.id === id);
  if (!v) return;
  let cred = {};
  try { cred = (await getCreds()).get(id) || {}; } catch {}
  const user = cred.user || '';
  const password = typedPassword || cred.pass || '';
  const fail = async (message) => {
    if (!live()) return;
    await removeContainers();
    setState({ phase: 'error', vpnId: id, message });
  };

  setState({ phase: 'connecting', vpnId: id, message: 'Preparando...' });
  if (!(await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim()) {
    return setState({ phase: 'nodocker' });
  }
  await removeContainers();

  if (!(await syncHosts())) {
    return fail(IS_WIN
      ? 'O arquivo hosts não foi atualizado. Clique em "Sim" no pedido de permissão do Windows.'
      : 'O arquivo /etc/hosts não foi atualizado. Digite a senha de administrador quando o sistema pedir.');
  }
  if (!(await ensureAliases())) {
    return fail('Não consegui criar os endereços locais (127.0.0.x). Digite a senha de administrador quando o sistema pedir.');
  }
  if (!live()) return;

  if ((await docker(['image', 'inspect', IMAGE])).code !== 0
      && (await docker(['tag', LEGACY.image, IMAGE])).code !== 0) { // reuses the old image if there is one
    setState({ phase: 'building', vpnId: id, message: 'Primeira vez: montando a imagem (cerca de 1 minuto)...' });
    const b = await docker(['build', '-t', IMAGE, DOCKER_DIR]);
    if (b.code !== 0) return fail('Falha ao montar a imagem Docker:\n' + logTail(b.stderr || b.stdout));
    if (!live()) return;
  }

  setState({ phase: 'connecting', vpnId: id, message: 'Conectando...' });
  const ips = hostIps(c);
  const portArgs = [];
  const forwards = [];
  let internal = 20000;
  for (const f of v.forward || []) {
    const p = parseForward(f);
    portArgs.push('-p', `${ips.get(p.host)}:${p.port}:${internal}`);
    forwards.push(`${internal}=${p.host}:${p.port}`);
    internal++;
  }
  const r = await docker([
    'run', '-d', '--name', NAME, '--label', `${LABEL}=${v.id}`,
    '--cap-add', 'NET_ADMIN', '--device', '/dev/ppp', ...portArgs,
    '-e', `VPN_HOST=${v.gateway}`, '-e', `VPN_PORT=${v.port || 10443}`, '-e', `VPN_USER=${user}`,
    '-e', `FORWARDS=${forwards.join(' ')}`, '-e', `TRUSTED_CERT=${v.trustedCert || ''}`,
    '-e', 'DETACHED=1', IMAGE,
  ]);
  if (r.code !== 0) {
    let msg = logTail(r.stderr);
    if (/port is already allocated|bind/i.test(r.stderr)) msg = 'Uma porta local já está em uso (outro programa, ou o FortiClient?).\n' + msg;
    else if (/\/dev\/ppp/.test(r.stderr)) msg = 'Falta o /dev/ppp. No Linux, rode: sudo modprobe ppp_generic\n' + msg;
    else if (/permission denied/i.test(r.stderr)) msg = 'Seu usuário não tem permissão no Docker. No Linux: sudo usermod -aG docker $USER e entre de novo na sessão.\n' + msg;
    return fail(msg);
  }

  await sleep(800);
  await sendInput(password);

  let askedCode = false;
  let deadline = Date.now() + 180000;
  pendingCode = null;
  while (live()) {
    await sleep(1000);
    if (!live()) return;
    const info = await containerInfo();
    const log = await readLog();
    if (!info || !info.running) {
      let msg = logTail(log) || 'A VPN parou sem mensagem.';
      if (/Could not authenticate|Permission denied|authentication failed/i.test(log)) msg = 'Usuário, senha ou código errado.\n\n' + msg;
      return fail(msg);
    }
    if (/Tunnel is up/.test(log)) return setState({ phase: 'connected', vpnId: id });
    if (!askedCode && /Two-factor authentication token/i.test(log)) {
      askedCode = true;
      setState({ phase: 'code', vpnId: id });
      deadline = Date.now() + 300000;
    }
    if (pendingCode) {
      const code = pendingCode;
      pendingCode = null;
      setState({ phase: 'connecting', vpnId: id, message: 'Verificando o código...' });
      await sendInput(code);
      deadline = Date.now() + 60000;
    }
    if (Date.now() > deadline) return fail('Tempo esgotado.\n\n' + logTail(log));
  }
}

async function disconnect() {
  attempt++;
  pendingCode = null;
  setState({ phase: 'connecting', message: 'Desconectando...' });
  await removeContainers();
  setState({ phase: 'idle' });
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('list', async () => {
  let creds = new Map();
  try { creds = await getCreds(); } catch {}
  return loadConfig().vpns.map((v) => publicVpn(v, creds.get(v.id)));
});
ipcMain.handle('password', async (_e, id) => {
  try { return ((await getCreds()).get(id) || {}).pass || ''; } catch { return ''; }
});
ipcMain.handle('state', () => state);
ipcMain.handle('connect', (_e, id, password) => { connect(id, password); });
ipcMain.handle('code', (_e, code) => { pendingCode = String(code).trim(); });
ipcMain.handle('disconnect', () => disconnect());
ipcMain.handle('dismiss', () => { setState({ phase: 'idle' }); refresh(); });

ipcMain.handle('save', async (_e, data) => {
  const c = loadConfig();
  let v = c.vpns.find((x) => x.id === data.id);
  const before = v ? JSON.stringify(v.forward || []) : null;
  if (!v) {
    let id = slug(data.name), n = 2;
    while (c.vpns.some((x) => x.id === id)) id = `${slug(data.name)}-${n++}`;
    v = { id };
    c.vpns.push(v);
  }
  v.name = String(data.name || '').trim() || v.id;
  v.gateway = String(data.gateway || '').trim();
  v.port = parseInt(data.port, 10) || 10443;
  v.trustedCert = String(data.trustedCert || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!v.trustedCert) delete v.trustedCert;
  v.forward = [...new Set((data.forward || []).map(normalizeSite).filter(Boolean))];
  saveConfig(c);
  try {
    await setCred(v.id, String(data.user || '').trim(), String(data.password || ''));
  } catch (e) {
    return { id: v.id, error: 'A VPN foi salva, mas o usuário e a senha não foram gravados no cofre de senhas.\n' + e.message };
  }

  const changed = before !== JSON.stringify(v.forward);
  const needsReconnect = changed && state.phase === 'connected' && state.vpnId === v.id;
  return { id: v.id, needsReconnect };
});

ipcMain.handle('hosts-status', () => hostsStatus());
ipcMain.handle('hosts-apply', async () => ({ hostsOk: await syncHosts() }));

ipcMain.handle('delete', async (_e, id) => {
  if (state.vpnId === id && state.phase !== 'idle') await disconnect();
  const c = loadConfig();
  c.vpns = c.vpns.filter((x) => x.id !== id);
  saveConfig(c);
  try { await vault.remove(id); (await getCreds()).delete(id); } catch {}
  return {};
});

// Brings in the script's vpns.json, plus users and passwords from a
// onlyroute.env next to it, if there is one.
ipcMain.handle('import', async () => {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Importar vpns.json',
    filters: [{ name: 'vpns.json', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const file = pick.filePaths[0];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).vpns;
    if (!Array.isArray(list)) throw new Error();
  } catch {
    return { error: 'Esse arquivo não parece um vpns.json.' };
  }
  const env = {};
  try {
    const dir = path.dirname(file);
    const envFile = ['onlyroute.env', 'vpn-git.env'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) env[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  const c = loadConfig();
  const logins = [];
  for (const x of list) {
    if (!x || !x.id || c.vpns.some((v) => v.id === x.id)) continue;
    const prefix = String(x.credentials || x.id).toUpperCase();
    const v = {
      id: String(x.id), name: x.name || x.id, gateway: x.gateway, port: x.port || 10443,
      forward: [...new Set((x.forward || []).map(normalizeSite).filter(Boolean))],
    };
    if (x.trustedCert) v.trustedCert = x.trustedCert;
    c.vpns.push(v);
    logins.push({ id: v.id, user: env[`${prefix}_USER`] || '', pass: env[`${prefix}_PASSWORD`] || '' });
  }
  saveConfig(c);
  try {
    await vault.writeMany(logins);
    const creds = await getCreds();
    for (const l of logins) creds.set(l.id, { user: l.user, pass: l.pass });
  } catch (e) {
    return { added: logins.length, error: 'Os usuários e senhas não foram gravados no cofre de senhas.\n' + e.message };
  }
  return { added: logins.length };
});

ipcMain.handle('hosts-remove', async () => {
  if (state.phase !== 'idle' && state.phase !== 'error' && state.phase !== 'nodocker') await disconnect();
  return { hostsOk: await writeHosts([]) };
});

// ---------------------------------------------------------------- window

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // macOS: click on the Dock icon
  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(() => {
    win = new BrowserWindow({
      width: 600,
      height: 740,
      minWidth: 440,
      minHeight: 480,
      title: 'OnlyRoute',
      icon: path.join(__dirname, 'build', 'icon.png'),
      autoHideMenuBar: true,
      backgroundColor: '#f6f7f9',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.loadFile(path.join(__dirname, 'index.html'));

    // Closing the window keeps the app in the tray (the VPN does not depend on
    // it: it keeps running in Docker either way).
    let hintShown = false;
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
      if (!hintShown) {
        hintShown = true;
        tray.displayBalloon({ title: 'O OnlyRoute continua aqui', content: 'Ele fica na bandeja, perto do relógio. Para fechar de vez: botão direito > Sair.' });
      }
    });

    tray = new Tray(trayIcon('off'));
    tray.on('click', showWindow);
    updateTray();
    refresh();
    setInterval(refresh, 10000);
  });

  // "Sair" closes the app. The VPN keeps running in Docker until "Desconectar".
  app.on('window-all-closed', () => app.quit());
}
