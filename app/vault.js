// Users and passwords live in the system's password store, protected by the
// user's login: Windows Credential Manager, macOS Keychain or Linux libsecret.
// One entry per VPN, "onlyroute:<id>".
//
// Windows: Node has no built-in access to it, so this runs a small PowerShell that calls
// the Windows API (CredRead / CredWrite / CredDelete). Data goes in and out as
// base64 JSON, so accents and symbols in passwords arrive intact, and the
// password never appears on a command line.
const { spawn } = require('child_process');

const PREFIX = 'onlyroute:';
const LEGACY = 'vpn-git:'; // name used before the project was renamed

const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VpnGitCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr p);

  public static void Write(string target, string user, string pass) {
    byte[] blob = Encoding.Unicode.GetBytes(pass ?? "");
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.Persist = 2; c.TargetName = target; c.UserName = user ?? "";
    c.Comment = "vpn-git";
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(blob.Length, 1));
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWrite(ref c, 0)) throw new Exception("CredWrite " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      string pass = c.CredentialBlobSize > 0 ? Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2) : "";
      return new string[] { c.UserName ?? "", pass };
    } finally { CredFree(p); }
  }
  public static void Delete(string target) { CredDelete(target, 1, 0); }
}
'@
$utf8 = [Text.Encoding]::UTF8
$ops = $utf8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
$out = @()
foreach ($o in @($ops)) {
  if ($o.op -eq 'write') { [VpnGitCred]::Write($o.target, $o.user, $o.pass); $out += $null }
  elseif ($o.op -eq 'delete') { [VpnGitCred]::Delete($o.target); $out += $null }
  else {
    $r = [VpnGitCred]::Read($o.target)
    if ($r) { $out += [pscustomobject]@{ user = $r[0]; pass = $r[1] } } else { $out += $null }
  }
}
[Console]::Out.Write([Convert]::ToBase64String($utf8.GetBytes((ConvertTo-Json -InputObject @($out) -Compress))))
`;

const ENCODED = Buffer.from(PS, 'utf16le').toString('base64');

// Runs a batch of operations in one PowerShell call.
// ops: [{op:'read', id} | {op:'write', id, user, pass} | {op:'delete', id}]
function batch(ops) {
  if (!ops.length) return Promise.resolve([]);
  const input = Buffer.from(JSON.stringify(ops.map((o) => ({
    op: o.op, target: (o.prefix || PREFIX) + o.id, user: o.user || '', pass: o.pass || '',
  }))), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('Cofre do Windows: ' + (err.trim() || 'erro ' + code)));
      try {
        const list = JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'));
        resolve(Array.isArray(list) ? list : [list]);
      } catch (e) {
        reject(new Error('Cofre do Windows: resposta inválida'));
      }
    });
    p.stdin.end(input);
  });
}

const windows = {
  readMany: (ids) => batch(ids.map((id) => ({ op: 'read', id }))),
  write: (id, user, pass) => batch([{ op: 'write', id, user, pass }]),
  writeMany: (items) => batch(items.map((x) => ({ op: 'write', ...x }))),
  remove: (id) => batch([{ op: 'delete', id }]),
  readLegacy: (ids) => batch(ids.map((id) => ({ op: 'read', id, prefix: LEGACY }))),
  removeLegacy: (ids) => batch(ids.map((id) => ({ op: 'delete', id, prefix: LEGACY }))),
};

// ------------------------------------------------------------ macOS / Linux
// Same format as onlyroute.sh, so the app and the script share logins.
//   macOS: Keychain, generic password, service "onlyroute:<id>", account = user.
//   Linux: libsecret (secret-tool), attributes service=onlyroute id=<id> user=<user>.

function exec(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(e.code === 'ENOENT'
      ? new Error(cmd === 'secret-tool' ? 'instale o secret-tool (pacote libsecret-tools)' : `${cmd} não encontrado`)
      : e));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input || '');
  });
}

const mac = {
  async read(id) {
    const svc = PREFIX + id;
    const a = await exec('security', ['find-generic-password', '-s', svc]);
    if (a.code !== 0) return null;
    const m = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(a.out + a.err);
    const p = await exec('security', ['find-generic-password', '-s', svc, '-w']);
    return { user: m ? m[1] : '', pass: p.code === 0 ? p.out.replace(/\n$/, '') : '' };
  },
  async remove(id) {
    // Loops in case an older entry with another account is still there.
    for (let i = 0; i < 5; i++) {
      if ((await exec('security', ['delete-generic-password', '-s', PREFIX + id])).code !== 0) break;
    }
  },
  async write(id, user, pass) {
    await mac.remove(id);
    // The password goes as an argument: `security` has no stdin option for it.
    const r = await exec('security', ['add-generic-password', '-s', PREFIX + id, '-a', user || '', '-l', `OnlyRoute ${id}`, '-w', pass || '']);
    if (r.code !== 0) throw new Error('Chaveiro: ' + (r.err.trim() || 'erro ' + r.code));
  },
};

const linux = {
  async read(id) {
    const s = await exec('secret-tool', ['search', 'service', 'onlyroute', 'id', id]);
    const all = s.out + s.err;
    if (!/attribute\.id\s*=/.test(all)) return null;
    const m = /attribute\.user\s*=\s*(.*)/.exec(all);
    const p = await exec('secret-tool', ['lookup', 'service', 'onlyroute', 'id', id]);
    return { user: m ? m[1].trim() : '', pass: p.code === 0 ? p.out : '' };
  },
  async remove(id) {
    await exec('secret-tool', ['clear', 'service', 'onlyroute', 'id', id]);
  },
  async write(id, user, pass) {
    await linux.remove(id);
    const r = await exec('secret-tool', ['store', `--label=OnlyRoute ${id}`, 'service', 'onlyroute', 'id', id, 'user', user || ''], pass || '');
    if (r.code !== 0) throw new Error('Chaveiro: ' + (r.err.trim() || 'erro ' + r.code));
  },
};

function unixVault(v) {
  return {
    readMany: async (ids) => { const r = []; for (const id of ids) r.push(await v.read(id)); return r; },
    write: (id, user, pass) => v.write(id, user, pass),
    writeMany: async (items) => { for (const x of items) await v.write(x.id, x.user, x.pass); },
    remove: (id) => v.remove(id),
    readLegacy: async (ids) => ids.map(() => null), // the old name only existed on Windows
    removeLegacy: async () => {},
  };
}

module.exports = process.platform === 'win32' ? windows
  : unixVault(process.platform === 'darwin' ? mac : linux);
