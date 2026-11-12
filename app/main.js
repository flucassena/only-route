// OnlyRoute: the same thing as onlyroute.ps1, with windows instead of a terminal.
// It uses the same Docker image, container name, hosts marker and vault entries,
// so the app and the script see each other's connection.
const { app, BrowserWindow, ipcMain, safeStorage, dialog, Tray, Menu, nativeImage, shell, clipboard, net } = require('electron');
const crypto = require('crypto');
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

// ---------------------------------------------------------------- docker
// Never assume Docker is already running: the app checks, asks the user to open
// it (or opens it), keeps checking and carries on by itself once it's ready.

const DOCKER_DESKTOP = {
  win32: [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe')],
  darwin: ['/Applications/Docker.app'],
  linux: ['/opt/docker-desktop/bin/com.docker.backend', '/usr/bin/dockerd', '/usr/sbin/dockerd', '/snap/bin/docker'],
}[process.platform] || [];

const DOCKER_DOWNLOAD = 'https://www.docker.com/products/docker-desktop/';

// Is the Docker engine answering?
async function dockerUp() {
  const r = await docker(['version', '--format', '{{.Server.Version}}']);
  return r.code === 0 && !!r.stdout.trim();
}

// Is Docker installed at all (the command or Docker Desktop)?
async function dockerInstalled() {
  if (DOCKER_DESKTOP.some((p) => fs.existsSync(p))) return true;
  return !(await docker(['--version'])).enoent;
}

// Opens Docker Desktop (or starts the Docker service on Linux). Doesn't wait.
async function startDocker() {
  if (IS_WIN) {
    const exe = DOCKER_DESKTOP.find((p) => fs.existsSync(p));
    if (!exe) return false;
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (IS_MAC) return (await run('open', ['-a', 'Docker'])).code === 0;
  // Linux: Docker Desktop runs as a user service; Docker Engine as a system service.
  if ((await run('systemctl', ['--user', 'start', 'docker-desktop'])).code === 0) return true;
  return (await runAsRoot('systemctl start docker')).code === 0;
}

// The PPP line discipline must be loaded in Docker's Linux kernel for pppd to
// build the tunnel. Newer kernels (e.g. recent WSL 2) ship it as a module that
// a container can't load ("Couldn't set tty to PPP discipline: Operation not
// permitted"), so it's loaded once from a short-lived privileged container.
// It lasts until Docker restarts, so this runs before every connection.
// If loading fails, the VPN container gets SYS_ADMIN instead (it fixes the same
// error on other Docker/WSL kernels), and pppNote goes into the error log.
let pppNote = '';
async function ensurePpp() {
  pppNote = '';
  const hasPpp = async () => /^ppp\s/m.test((await docker(['run', '--rm', '--entrypoint', 'cat', IMAGE, '/proc/tty/ldiscs'])).stdout);
  if (await hasPpp()) return true;
  const r = await docker(['run', '--rm', '--privileged', '--pid=host', '--entrypoint', 'nsenter', IMAGE,
    '-t', '1', '-m', 'sh', '-c', 'uname -r; modprobe ppp_async']);
  if (await hasPpp()) return true;
  // Newer WSL kernels (6.x) keep their modules where only WSL's own distros see
  // them. Every WSL distro shares Docker's kernel, so load it from the
  // docker-desktop distro, or else from the user's default one (Ubuntu...).
  if (process.platform === 'win32') {
    for (const distro of [['-d', 'docker-desktop'], []]) {
      await run('wsl.exe', [...distro, '-u', 'root', 'modprobe', 'ppp_async']);
      if (await hasPpp()) return true;
    }
  }
  pppNote = `[modprobe ppp_async] ${String((r.stdout || '') + (r.stderr || '')).trim() || 'exit ' + r.code}`;
  return false;
}

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

// ---------------------------------------------------------------- language
// Portuguese or English: what the user picked in the app (config.lang), else
// the system language. L('texto', 'text') returns the one in use.
let lang = 'en';
const L = (pt, en) => (lang === 'pt' ? pt : en);
function pickLang() {
  const c = loadConfig();
  if (c.lang === 'pt' || c.lang === 'en') return (lang = c.lang);
  const sys = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale() || '';
  lang = /^pt/i.test(sys) ? 'pt' : 'en';
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

// The gateway field sometimes gets a full address ("https://vpn.x.com:10443/remote/login").
// openfortivpn wants only the host, with the port apart; a port in the address wins.
function splitGateway(gateway, port) {
  let g = String(gateway || '').trim(), p = parseInt(port, 10) || 10443;
  g = g.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  const m = /^(.*):(\d{1,5})$/.exec(g);
  if (m && !m[1].includes(':')) { g = m[1]; p = +m[2]; }
  return { gateway: g, port: p };
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
    case 'connected': return L(`Ligada: ${vpnName(state.vpnId)}`, `On: ${vpnName(state.vpnId)}`);
    case 'code': return L('Esperando o código de verificação', 'Waiting for the verification code');
    case 'building': case 'connecting': return state.message || L('Conectando...', 'Connecting...');
    case 'nodocker': return state.starting || state.vpnId ? L('Esperando o Docker abrir', 'Waiting for Docker to open') : L('O Docker não está aberto', 'Docker is not open');
    case 'error': return L('Não conectou', 'Could not connect');
    case 'checking': return L('Verificando...', 'Checking...');
    default: return L('Desligada', 'Off');
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
    { label: L('Abrir', 'Open'), click: showWindow },
    { label: L('Desconectar', 'Disconnect'), enabled: state.phase === 'connected' || busy, click: () => disconnect() },
    { type: 'separator' },
    { label: L('Sair', 'Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
  // Tell the user when something changes while the window is hidden.
  if (win && !win.isVisible()) {
    if (state.phase === 'connected' && was.phase !== 'connected') {
      tray.displayBalloon({ title: L('VPN ligada', 'VPN on'), content: vpnName(state.vpnId) });
    } else if (was.phase === 'connected' && state.phase === 'idle') {
      tray.displayBalloon({ title: L('A VPN desligou', 'The VPN went off'), content: L('Abra o OnlyRoute para conectar de novo.', 'Open OnlyRoute to connect again.'), iconType: 'warning' });
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

// A connection asked while Docker was closed: it starts by itself once Docker is up.
let waitingConnect = null; // { id, password }
let dockerOpening = false;

function setNoDocker(installed) {
  setState({ phase: 'nodocker', installed, starting: dockerOpening, vpnId: waitingConnect ? waitingConnect.id : undefined });
}

async function openDocker() {
  dockerOpening = true;
  if (!(await startDocker())) dockerOpening = false;
  if (!(await dockerUp())) setNoDocker(await dockerInstalled());
}

async function refresh() {
  if (['building', 'connecting', 'code'].includes(state.phase)) return;
  if (!(await dockerUp())) return setNoDocker(await dockerInstalled());
  dockerOpening = false;
  if (waitingConnect) {
    const w = waitingConnect;
    waitingConnect = null;
    return connect(w.id, w.password);
  }
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
  // message: what went wrong, in plain words; hint: what to do; log: the full
  // output, shown only when the user asks for it.
  const fail = async (message, hint = '', log = '') => {
    if (!live()) return;
    await removeContainers();
    setState({ phase: 'error', vpnId: id, message, hint, log: String(log || '').trim() });
  };

  setState({ phase: 'connecting', vpnId: id, message: L('Preparando...', 'Getting ready...') });
  if (!(await dockerUp())) {
    // Opens Docker and waits; refresh() comes back here once it answers.
    waitingConnect = { id, password: typedPassword };
    if (await dockerInstalled()) await openDocker();
    else setNoDocker(false);
    return;
  }
  await removeContainers();

  if (!hostsUpToDate(expectedHostsLines(c))) {
    setState({ phase: 'connecting', vpnId: id, message: IS_WIN
      ? L('Atualizando o arquivo hosts: clique em "Sim" no pedido de permissão do Windows.', 'Updating the hosts file: click "Yes" on the Windows permission prompt.')
      : L('Atualizando o /etc/hosts: digite a senha de administrador quando o sistema pedir.', 'Updating /etc/hosts: type the administrator password when the system asks.') });
    if (win && !win.isVisible()) showWindow();
  }
  if (!(await syncHosts())) {
    return fail(L('O arquivo hosts não foi atualizado.', 'The hosts file was not updated.'), IS_WIN
      ? L('Tente de novo e clique em "Sim" no pedido de permissão do Windows.', 'Try again and click "Yes" on the Windows permission prompt.')
      : L('Tente de novo e digite a senha de administrador quando o sistema pedir.', 'Try again and type the administrator password when the system asks.'));
  }
  if (!(await ensureAliases())) {
    return fail(L('Não consegui criar os endereços locais (127.0.0.x).', 'Could not create the local addresses (127.0.0.x).'),
      L('Tente de novo e digite a senha de administrador quando o sistema pedir.', 'Try again and type the administrator password when the system asks.'));
  }
  if (!live()) return;

  if ((await docker(['image', 'inspect', IMAGE])).code !== 0
      && (await docker(['tag', LEGACY.image, IMAGE])).code !== 0) { // reuses the old image if there is one
    setState({ phase: 'building', vpnId: id, message: L('Primeira vez: montando a imagem (cerca de 1 minuto)...', 'First time: building the image (about 1 minute)...') });
    const b = await docker(['build', '-t', IMAGE, DOCKER_DIR]);
    if (b.code !== 0) {
      return fail(L('Não consegui montar a imagem do Docker.', 'Could not build the Docker image.'),
        L('Confira se a internet está funcionando e tente de novo. O log completo mostra o motivo.', 'Check that the internet is working and try again. The full log shows why.'),
        b.stderr || b.stdout);
    }
    if (!live()) return;
  }

  setState({ phase: 'connecting', vpnId: id, message: L('Preparando o túnel...', 'Preparing the tunnel...') });
  const pppOk = await ensurePpp();
  if (!live()) return;

  setState({ phase: 'connecting', vpnId: id, message: L('Conectando...', 'Connecting...') });
  const ips = hostIps(c);
  const gw = splitGateway(v.gateway, v.port);
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
    '--cap-add', 'NET_ADMIN', ...(pppOk ? [] : ['--cap-add', 'SYS_ADMIN']), '--device', '/dev/ppp', ...portArgs,
    '-e', `VPN_HOST=${gw.gateway}`, '-e', `VPN_PORT=${gw.port}`, '-e', `VPN_USER=${user}`,
    '-e', `FORWARDS=${forwards.join(' ')}`, '-e', `TRUSTED_CERT=${v.trustedCert || ''}`,
    '-e', 'DETACHED=1', IMAGE,
  ]);
  if (r.code !== 0) {
    const e = r.stderr;
    if (/port is already allocated|bind/i.test(e)) {
      return fail(L('Uma porta que a VPN usa já está ocupada.', 'A port the VPN needs is already taken.'),
        L('Outro programa (o FortiClient, por exemplo) está usando. Feche-o e tente de novo.', 'Another program (FortiClient, for example) is using it. Close it and try again.'), e);
    }
    if (/\/dev\/ppp/.test(e)) {
      return fail(L('Falta o /dev/ppp no sistema.', '/dev/ppp is missing on this system.'),
        L('No Linux, rode: sudo modprobe ppp_generic e tente de novo.', 'On Linux, run: sudo modprobe ppp_generic and try again.'), e);
    }
    if (/permission denied/i.test(e)) {
      return fail(L('Seu usuário não tem permissão no Docker.', 'Your user has no permission on Docker.'),
        L('No Linux: sudo usermod -aG docker $USER e entre de novo na sessão.', 'On Linux: sudo usermod -aG docker $USER and log in again.'), e);
    }
    return fail(L('O Docker não conseguiu iniciar a VPN.', 'Docker could not start the VPN.'),
      L('Tente de novo. Se continuar, reinicie o Docker Desktop.', 'Try again. If it keeps happening, restart Docker Desktop.'), e);
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
      // The gateway only asks for the code after the password is accepted, so a
      // refusal after that is the code (wrong, expired or an old one pasted).
      if (/Could not authenticate|Permission denied|authentication failed/i.test(log)) {
        return askedCode
          ? fail(L('O código de verificação foi recusado.', 'The verification code was refused.'),
            L('A senha está certa; o código estava errado ou já tinha vencido (eles duram cerca de 1 minuto). Clique em "Tentar de novo" e use um código novo.',
              'The password is right; the code was wrong or had already expired (they last about 1 minute). Click "Try again" and use a new code.'), log)
          : fail(L('Usuário ou senha errados.', 'Wrong user or password.'),
            L('Clique no lápis da VPN, confira o usuário e a senha (os mesmos do FortiClient) e tente de novo.', 'Click the pencil on the VPN, check the user and password (the same as in FortiClient) and try again.'), log);
      }
      if (/pppd: An immediately fatal error/i.test(log)) {
        return fail(L('O login funcionou, mas o túnel não abriu.', 'The login worked, but the tunnel did not open.'), pppOk
          ? L('O Docker não deixou montar o túnel. Feche e abra o Docker Desktop e tente de novo.', 'Docker did not let the tunnel start. Close and reopen Docker Desktop and try again.')
          : L('O Linux do Docker não tem suporte a PPP ligado. Feche e abra o Docker Desktop e tente de novo. Se continuar, copie o log e mande para quem cuida do OnlyRoute.', 'Docker\'s Linux has no PPP support turned on. Close and reopen Docker Desktop and try again. If it keeps happening, copy the log and send it to whoever looks after OnlyRoute.'),
          pppNote ? `${log}\n\n${pppNote}` : log);
      }
      if (/Could not resolve|Name or service not known|Connection refused|timed out|Network is unreachable/i.test(log)) {
        return fail(L('Não consegui falar com o servidor da VPN.', 'Could not reach the VPN server.'),
          L('Confira a internet e o endereço e a porta do gateway (os mesmos do FortiClient).', 'Check the internet and the gateway address and port (the same as in FortiClient).'), log);
      }
      if (/certificate/i.test(log)) {
        return fail(L('O certificado do servidor da VPN não foi aceito.', 'The VPN server certificate was not accepted.'),
          L('Se a TI confirmar que o servidor é esse mesmo, copie o valor do log para "Avançado > Certificado confiável" da VPN.', 'If your IT team confirms it is the right server, copy the value from the log into the VPN\'s "Advanced > Trusted certificate".'), log);
      }
      return fail(L('A VPN parou.', 'The VPN stopped.'), L('O log completo mostra o motivo.', 'The full log shows why.'), log);
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
      setState({ phase: 'connecting', vpnId: id, message: L('Verificando o código...', 'Checking the code...') });
      await sendInput(code);
      deadline = Date.now() + 60000;
    }
    if (Date.now() > deadline) {
      return fail(L('Demorou demais e a conexão foi cancelada.', 'It took too long and the connection was cancelled.'),
        askedCode ? L('O código não foi enviado a tempo. Tente de novo.', 'The code was not sent in time. Try again.') : L('Tente de novo.', 'Try again.'), log);
    }
  }
}

async function disconnect() {
  attempt++;
  pendingCode = null;
  waitingConnect = null;
  setState({ phase: 'connecting', message: L('Desconectando...', 'Disconnecting...') });
  await removeContainers();
  setState({ phase: 'idle' });
}

// ---------------------------------------------------------------- updates
// Looks at the latest GitHub release. When it is newer, the window shows an
// "Update" button; clicking it downloads the installer for this system, checks
// it against the release's SHA256SUMS.txt and installs it (silently on Windows).

const RELEASES = 'https://api.github.com/repos/flucassena/only-route/releases/latest';
// update.phase: none | available | downloading | installing | error
let update = { phase: 'none' };
// Running from source (npm start) the version is not a real one, so it only
// checks when ONLYROUTE_UPDATE_TEST=1 (and pretends to be that old version).
const currentVersion = () => process.env.ONLYROUTE_UPDATE_FROM || app.getVersion();
const updatesOn = () => app.isPackaged || process.env.ONLYROUTE_UPDATE_TEST === '1';

function setUpdate(u) {
  update = u;
  if (win && !win.isDestroyed()) win.webContents.send('update', update);
}

function newer(a, b) { // is version a newer than b?
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// The installer that fits this system, by the names electron-builder gives them.
function pickAsset(assets) {
  const n = (re) => assets.find((a) => re.test(a.name));
  if (IS_WIN) return n(/-win-x64\.exe$/i);
  if (IS_MAC) return n(new RegExp(`-mac-${process.arch}\\.dmg$`, 'i'));
  return process.env.APPIMAGE ? n(/\.AppImage$/i) : n(/\.deb$/i);
}

const ghFetch = (url) => net.fetch(url, { headers: { 'User-Agent': 'OnlyRoute', Accept: 'application/vnd.github+json' } });

async function checkUpdate() {
  if (!updatesOn() || ['downloading', 'installing'].includes(update.phase)) return;
  try {
    const r = await ghFetch(RELEASES);
    if (!r.ok) return;
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const asset = pickAsset(rel.assets || []);
    const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
    if (!version || !asset || !newer(version, currentVersion())) return setUpdate({ phase: 'none' });
    setUpdate({ phase: 'available', version, name: asset.name, url: asset.browser_download_url, size: asset.size,
      sums: sums && sums.browser_download_url, page: rel.html_url });
  } catch {}
}

async function download(url, file, onProgress) {
  const r = await ghFetch(url);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0;
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash('sha256');
  let got = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      if (!out.write(buf)) await new Promise((res) => out.once('drain', res));
      got += buf.length;
      if (total) onProgress(got / total);
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  return hash.digest('hex');
}

async function installUpdate() {
  if (update.phase !== 'available' && update.phase !== 'error') return;
  const u = update.url ? update : null;
  if (!u) return;
  const dir = path.join(os.tmpdir(), 'onlyroute-update');
  const file = path.join(dir, u.name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let last = -1;
    setUpdate({ ...u, phase: 'downloading', progress: 0 });
    const sha = await download(u.url, file, (p) => {
      const pct = Math.floor(p * 100);
      if (pct !== last) { last = pct; setUpdate({ ...u, phase: 'downloading', progress: p }); }
    });
    // Only install a file that matches the release's checksum list.
    if (u.sums) {
      const list = await (await ghFetch(u.sums)).text();
      const line = list.split(/\r?\n/).find((l) => l.trim().endsWith(u.name));
      if (!line || line.trim().split(/\s+/)[0].toLowerCase() !== sha) throw new Error(L('o arquivo baixado não confere com o SHA256SUMS.txt', 'the downloaded file does not match SHA256SUMS.txt'));
    }
    setUpdate({ ...u, phase: 'installing' });
    if (IS_WIN) {
      // NSIS: /S installs silently over the current install; --force-run opens
      // the app again when it is done. The app quits so its files can be replaced.
      spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => { quitting = true; app.quit(); }, 800);
    } else if (IS_MAC) {
      // Unsigned app: the user drags it to Applications from the disk image.
      await shell.openPath(file);
      setUpdate({ ...u, phase: 'manual' });
    } else if (process.env.APPIMAGE) {
      fs.copyFileSync(file, process.env.APPIMAGE);
      fs.chmodSync(process.env.APPIMAGE, 0o755);
      app.relaunch({ execPath: process.env.APPIMAGE });
      quitting = true; app.quit();
    } else {
      const r = await runAsRoot(`apt-get install -y ${shq(file)} || dpkg -i ${shq(file)}`);
      if (r.code !== 0) throw new Error(logTail(r.stderr || r.stdout) || 'apt-get');
      app.relaunch();
      quitting = true; app.quit();
    }
  } catch (e) {
    try { fs.unlinkSync(file); } catch {}
    setUpdate({ ...u, phase: 'error', message: String(e.message || e) });
  }
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
ipcMain.handle('docker-open', () => openDocker());
ipcMain.handle('docker-download', () => shell.openExternal(DOCKER_DOWNLOAD));
ipcMain.handle('docker-cancel', () => { waitingConnect = null; refresh(); });

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
  Object.assign(v, splitGateway(data.gateway, data.port));
  v.trustedCert = String(data.trustedCert || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!v.trustedCert) delete v.trustedCert;
  v.forward = [...new Set((data.forward || []).map(normalizeSite).filter(Boolean))];
  saveConfig(c);
  try {
    await setCred(v.id, String(data.user || '').trim(), String(data.password || ''));
  } catch (e) {
    return { id: v.id, error: L('A VPN foi salva, mas o usuário e a senha não foram gravados no cofre de senhas.\n', 'The VPN was saved, but the user and password were not stored in the password vault.\n') + e.message };
  }

  const changed = before !== JSON.stringify(v.forward);
  const needsReconnect = changed && state.phase === 'connected' && state.vpnId === v.id;
  return { id: v.id, needsReconnect };
});

ipcMain.handle('hosts-status', () => hostsStatus());
ipcMain.handle('hosts-apply', async () => ({ hostsOk: await syncHosts() }));

ipcMain.handle('clipboard-text', () => clipboard.readText());
ipcMain.handle('clipboard-write', (_e, text) => clipboard.writeText(String(text || '')));

ipcMain.handle('update-info', () => update);
ipcMain.handle('update-go', () => { installUpdate(); });
ipcMain.handle('update-page', () => update.page && shell.openExternal(update.page));

ipcMain.handle('lang', () => lang);
ipcMain.handle('set-lang', (_e, l) => {
  if (l !== 'pt' && l !== 'en') return lang;
  const c = loadConfig();
  c.lang = lang = l;
  saveConfig(c);
  updateTray();
  return lang;
});

// Opens a VPN site in the default browser. Only plain host[:port] values.
ipcMain.handle('open-site', (_e, site) => {
  const s = String(site || '').trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(s)) return;
  shell.openExternal('https://' + s);
});

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
    title: L('Importar vpns.json', 'Import vpns.json'),
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
    return { error: L('Esse arquivo não parece um vpns.json.', 'This file does not look like a vpns.json.') };
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
      id: String(x.id), name: x.name || x.id, ...splitGateway(x.gateway, x.port),
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
    return { added: logins.length, error: L('Os usuários e senhas não foram gravados no cofre de senhas.\n', 'The users and passwords were not stored in the password vault.\n') + e.message };
  }
  return { added: logins.length };
});

ipcMain.handle('hosts-remove', async () => {
  if (state.phase !== 'idle' && state.phase !== 'error' && state.phase !== 'nodocker') await disconnect();
  return { hostsOk: await writeHosts([]) };
});

// ---------------------------------------------------------------- window

// Windows names notifications after this id. It must match the appId in
// package.json, which the installer gives to the Start menu shortcut. Only
// set it in the installed app: when running with `npm start` the id has no
// shortcut and Windows would show the raw id instead of a name.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('io.github.flucassena.onlyroute');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // macOS: click on the Dock icon
  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(() => {
    pickLang();
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
        tray.displayBalloon({ title: L('O OnlyRoute continua aqui', 'OnlyRoute is still running'), content: L('Ele fica na bandeja, perto do relógio. Para fechar de vez: botão direito > Sair.', 'It stays in the tray, next to the clock. To close it for good: right-click > Quit.') });
      }
    });

    tray = new Tray(trayIcon('off'));
    tray.on('click', showWindow);
    updateTray();
    // Checks every 10 s, or every 2 s while waiting for Docker to open.
    const tick = async () => {
      try { await refresh(); } catch {}
      setTimeout(tick, state.phase === 'nodocker' ? 2000 : 10000);
    };
    tick();
    // New version? Checks a few seconds after opening, then every 6 hours.
    setTimeout(checkUpdate, 5000);
    setInterval(checkUpdate, 6 * 3600 * 1000);
  });

  // "Sair" closes the app. The VPN keeps running in Docker until "Desconectar".
  app.on('window-all-closed', () => app.quit());
}
