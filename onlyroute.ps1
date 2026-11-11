<#
  OnlyRoute: VPN FortiGate (SSL VPN) so para alguns sites, sem FortiClient.

  A VPN roda dentro de um container Docker; o Windows continua na internet normal.
  Os sites listados em "forward" no vpns.json passam pela VPN: o arquivo hosts
  aponta cada um para um endereco local (127.0.0.x) e o container repassa a
  conexao pelo tunel.

  Uso:
    .\onlyroute.ps1 up [vpn]       # conecta em segundo plano (pergunta qual VPN, pede o codigo)
    .\onlyroute.ps1 down           # desliga
    .\onlyroute.ps1 status         # mostra se esta ligada e qual VPN
    .\onlyroute.ps1 list           # lista as VPNs e os sites repassados
    .\onlyroute.ps1 login [vpn]    # grava usuario e senha no cofre do Windows
    .\onlyroute.ps1 logout [vpn]   # apaga usuario e senha do cofre
    .\onlyroute.ps1 add <site> [vpn]     # passa um site pela VPN (pede permissao de Admin)
    .\onlyroute.ps1 remove <site> [vpn]  # tira um site da VPN (pede permissao de Admin)
    .\onlyroute.ps1 hosts-setup    # (Admin) aponta os sites do vpns.json para a VPN
    .\onlyroute.ps1 hosts-remove   # (Admin) desfaz o hosts-setup
    .\onlyroute.ps1 build          # remonta a imagem Docker
    .\onlyroute.ps1 uninstall      # (Admin) desfaz tudo: VPN, hosts, imagem Docker e logins

  Configuracao:
    vpns.json        VPNs cadastradas (gateway, porta, sites repassados)
    Usuario e senha: no Gerenciador de Credenciais do Windows ("login"), o mesmo
    que o app usa. Alternativa: onlyroute.env (veja onlyroute.env.example).
#>
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'status', 'list', 'login', 'logout', 'add', 'remove', 'build', 'hosts-setup', 'hosts-remove', 'uninstall')]
  [string]$Command = 'up',
  [Parameter(Position = 1)][string]$Vpn,
  [Parameter(Position = 2)][string]$Arg2
)

$Here = $PSScriptRoot
$Image = 'onlyroute'
$Name = 'onlyroute'
$Label = 'onlyroute.vpn'
$HostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
$HostsMarker = '# onlyroute'
# Nomes usados antes do projeto ser renomeado: ainda reconhecidos e limpos.
$LegacyName = 'vpn-git'
$OurLine = '#\s*(onlyroute|vpn-git)\s*$'

# --- vpns.json ---
$ConfigFile = Join-Path $Here 'vpns.json'
if (-not (Test-Path $ConfigFile)) { throw "Nao achei $ConfigFile. Copie o vpns.example.json para vpns.json e coloque suas VPNs." }
$Vpns = @((Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json).vpns)
if ($Vpns.Count -eq 0) { throw 'Nenhuma VPN cadastrada no vpns.json.' }

# --- onlyroute.env (opcional, alternativa ao cofre) ---
$EnvVars = @{}
$EnvFile = @('onlyroute.env', 'vpn-git.env') | ForEach-Object { Join-Path $Here $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($EnvFile) {
  foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2] -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
      if ($value -ne '') { $EnvVars[$Matches[1].ToUpper()] = $value }
    }
  }
}

# --- Cofre do Windows (Gerenciador de Credenciais), entradas "onlyroute:<id>" ---
function Initialize-Vault {
  if ('OnlyRouteCred' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OnlyRouteCred {
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
    c.Comment = "OnlyRoute";
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
}

function Get-VaultCred([string]$Id) {
  Initialize-Vault
  $r = [OnlyRouteCred]::Read("onlyroute:$Id")
  if (-not $r) { $r = [OnlyRouteCred]::Read("vpn-git:$Id") }
  if ($r) { @{ User = $r[0]; Pass = $r[1] } }
}

function Set-VaultCred([string]$Id, [string]$User, [string]$Pass) {
  Initialize-Vault
  [OnlyRouteCred]::Write("onlyroute:$Id", $User, $Pass)
  [OnlyRouteCred]::Delete("vpn-git:$Id")
}

function Remove-VaultCred([string]$Id) {
  Initialize-Vault
  [OnlyRouteCred]::Delete("onlyroute:$Id")
  [OnlyRouteCred]::Delete("vpn-git:$Id")
}

# Usuario e senha da VPN: primeiro o cofre, depois o onlyroute.env.
function Get-Login($v) {
  $prefix = Get-CredPrefix $v
  $cred = Get-VaultCred $v.id
  $user = if ($cred -and $cred.User) { $cred.User } else { $EnvVars["${prefix}_USER"] }
  $pass = if ($cred -and $cred.Pass) { $cred.Pass } else { $EnvVars["${prefix}_PASSWORD"] }
  $source = if ($cred) { 'cofre' } elseif ($user) { 'onlyroute.env' } else { 'nenhum' }
  @{ User = $user; Pass = $pass; Source = $source }
}

function Build-Image {
  docker build -q -t $Image $Here | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao montar a imagem Docker.' }
}

function Is-Running { [bool](docker ps -q -f "name=^$Name$") }

# Remove o container (ligado ou parado) sem reclamar se ele nao existir.
function Remove-VpnContainer { docker rm -f $Name $LegacyName 2>&1 | Out-Null }

# Le o log da VPN de dentro do container (funciona mesmo com ele parado).
function Read-VpnLog {
  $tmp = [IO.Path]::GetTempFileName()
  try {
    docker cp "${Name}:/run/vpn.log" $tmp 2>&1 | Out-Null
    (Get-Content $tmp -ErrorAction SilentlyContinue) -join "`n"
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}

function Is-Connected { (Is-Running) -and ((Read-VpnLog) -match 'Tunnel is up') }

function Get-CurrentVpn { docker inspect -f "{{ index .Config.Labels `"$Label`" }}" $Name }

# Mostra as ultimas mensagens da VPN e remove o container.
function Show-FailureAndCleanup([string]$Title) {
  $Title
  ((Read-VpnLog) -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 6) -join "`n"
  Remove-VpnContainer
}

function Is-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Require-Admin {
  if (-not (Is-Admin)) { throw 'Este comando mexe no arquivo hosts: abra o PowerShell como Administrador e rode de novo.' }
}

function Remove-HostsEntries {
  $lines = @(Get-Content $HostsFile | Where-Object { $_ -notmatch $OurLine })
  Set-Content -Path $HostsFile -Value $lines -Encoding ascii
  ipconfig /flushdns | Out-Null
}

# Linhas que o hosts deveria ter, de acordo com o vpns.json.
function Get-ExpectedHostsLines {
  $ips = Get-HostIps
  foreach ($h in $ips.Keys) { "$($ips[$h]) $h $HostsMarker" }
}

function Test-HostsUpToDate {
  $current = @(Get-Content $HostsFile | Where-Object { $_ -match $OurLine } | ForEach-Object { $_.Trim() })
  ($current -join "`n") -eq (@(Get-ExpectedHostsLines) -join "`n")
}

function Write-HostsEntries {
  $lines = @(Get-Content $HostsFile | Where-Object { $_ -notmatch $OurLine })
  $lines += @(Get-ExpectedHostsLines)
  Set-Content -Path $HostsFile -Value $lines -Encoding ascii
  ipconfig /flushdns | Out-Null
}

# Deixa o hosts igual ao vpns.json. Sem Admin, abre o pedido de permissao do Windows.
function Update-Hosts {
  if (Test-HostsUpToDate) { return $true }
  if (Is-Admin) { Write-HostsEntries; return $true }
  Write-Host 'Atualizando o arquivo hosts: o Windows vai pedir permissao de administrador...'
  try {
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'hosts-setup')
  } catch {
    Write-Host 'Permissao negada: o hosts nao foi atualizado. Rode hosts-setup como Administrador depois.'
    return $false
  }
  if (Test-HostsUpToDate) { Write-Host 'Arquivo hosts atualizado.'; return $true }
  Write-Host 'Nao consegui atualizar o hosts. Rode hosts-setup como Administrador.'
  $false
}

# Grava o vpns.json (formato fixo e legivel, UTF-8 sem BOM).
function ConvertTo-JsonValue($Value) {
  if ($Value -is [array]) { return '[' + ((@($Value) | ForEach-Object { ConvertTo-JsonValue $_ }) -join ', ') + ']' }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return "$Value" }
  if ($Value -is [bool]) { return "$Value".ToLower() }
  '"' + ("$Value" -replace '\\', '\\' -replace '"', '\"') + '"'
}

function Save-Config {
  $blocks = foreach ($v in $Vpns) {
    $props = $v.PSObject.Properties | ForEach-Object { "      `"$($_.Name)`": $(ConvertTo-JsonValue $_.Value)" }
    "    {`n" + ($props -join ",`n") + "`n    }"
  }
  $json = "{`n  `"vpns`": [`n" + ($blocks -join ",`n") + "`n  ]`n}`n"
  [IO.File]::WriteAllText($ConfigFile, $json, (New-Object Text.UTF8Encoding $false))
}

# Aceita "site", "site:porta" ou uma URL inteira (https://site/caminho).
function Normalize-Site([string]$Site) {
  $Site = $Site.Trim()
  if ($Site -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    $uri = [uri]$Site
    $result = $uri.Host.ToLower()
    if (-not $uri.IsDefaultPort) { $result += ":$($uri.Port)" }
    return $result
  }
  ($Site -replace '/.*$', '').ToLower()
}

# Se a VPN estiver ligada, os repasses so mudam reconectando.
function Offer-Reconnect {
  if (-not (Is-Connected)) { return }
  $current = Get-CurrentVpn
  $answer = Read-Host "A VPN ($current) esta ligada. Reconectar agora para aplicar? (s/N)"
  if ($answer -match '^[sSyY]') {
    Remove-VpnContainer
    & $PSCommandPath up $current
  } else {
    "Vale na proxima vez que ligar (ou rode 'down' e 'up')."
  }
}

# "host" ou "host:porta" (padrao 443)
function Parse-Forward([string]$Entry) {
  if ($Entry -match '^(.+):(\d+)$') { return @{ Host = $Matches[1]; Port = [int]$Matches[2] } }
  @{ Host = $Entry; Port = 443 }
}

# Cada site ganha um endereco local fixo: 127.0.0.1, 127.0.0.2, ... na ordem em
# que aparece no vpns.json. Assim varios sites podem usar a mesma porta.
function Get-HostIps {
  $map = [ordered]@{}
  foreach ($v in $Vpns) {
    foreach ($f in @($v.forward)) {
      if (-not $f) { continue }
      $h = (Parse-Forward $f).Host.ToLower()
      if (-not $map.Contains($h)) { $map[$h] = "127.0.0.$($map.Count + 1)" }
    }
  }
  $map
}

function Select-Vpn {
  if ($Vpn) {
    $match = $Vpns | Where-Object { $_.id -ieq $Vpn }
    if (-not $match -and $Vpn -match '^\d+$' -and [int]$Vpn -ge 1 -and [int]$Vpn -le $Vpns.Count) { $match = $Vpns[[int]$Vpn - 1] }
    if (-not $match) { throw "VPN '$Vpn' nao esta no vpns.json. Use: .\onlyroute.ps1 list" }
    return $match
  }
  if ($Vpns.Count -eq 1) { return $Vpns[0] }
  $labels = @($Vpns | ForEach-Object { "$($_.name)  [$($_.gateway)]" })
  $Vpns[(Select-Menu 'Qual VPN? (setas + Enter, Esc cancela)' $labels)]
}

# Menu com setas. Sem console interativo, cai para digitar o numero.
function Select-Menu([string]$Title, [string[]]$Items) {
  $n = $Items.Count
  $interactive = $true
  try { if ([Console]::IsInputRedirected) { $interactive = $false } } catch { $interactive = $false }
  if (-not $interactive) {
    Write-Host $Title
    for ($i = 0; $i -lt $n; $i++) { Write-Host "  $($i + 1)) $($Items[$i])" }
    while ($true) {
      $answer = Read-Host 'Numero'
      if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $n) { return [int]$answer - 1 }
      Write-Host 'Numero invalido.'
    }
  }

  $width = ($Items | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum + 4
  $index = 0
  Write-Host $Title
  for ($i = 0; $i -lt $n; $i++) { Write-Host '' }
  $top = [Console]::CursorTop - $n
  $cursorWasVisible = $true
  try { $cursorWasVisible = [Console]::CursorVisible; [Console]::CursorVisible = $false } catch {}
  try {
    while ($true) {
      for ($i = 0; $i -lt $n; $i++) {
        [Console]::SetCursorPosition(0, $top + $i)
        $text = "  $($i + 1)) $($Items[$i])".PadRight($width)
        if ($i -eq $index) { Write-Host ('>' + $text.Substring(1)) -ForegroundColor Cyan -NoNewline }
        else { Write-Host $text -NoNewline }
      }
      [Console]::SetCursorPosition(0, $top + $n)
      $key = [Console]::ReadKey($true)
      switch ($key.Key) {
        'UpArrow' { $index = ($index - 1 + $n) % $n }
        'DownArrow' { $index = ($index + 1) % $n }
        'Enter' { return $index }
        'Escape' { throw 'Cancelado.' }
        default {
          $digit = 0
          if ([int]::TryParse([string]$key.KeyChar, [ref]$digit) -and $digit -ge 1 -and $digit -le $n) { $index = $digit - 1 }
        }
      }
    }
  } finally {
    try { [Console]::CursorVisible = $cursorWasVisible } catch {}
  }
}

function Get-CredPrefix($v) {
  if ($v.credentials) { return $v.credentials.ToUpper() }
  $v.id.ToUpper()
}

function Send-VpnInput([string]$Text) {
  # Vai direto para a entrada da VPN dentro do container; nada e gravado em disco.
  # Escreve os bytes UTF-8 exatos: o pipeline do PowerShell 5.1 acrescentaria
  # BOM, trocaria acentos por "?" e poria \r no fim, estragando a senha.
  $psi = New-Object Diagnostics.ProcessStartInfo 'docker'
  # O sed tira o BOM que o .NET pode colocar no inicio e qualquer \r.
  $psi.Arguments = "exec -i $Name sh -c `"sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r`$//' > /run/vpn-input`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $proc = [Diagnostics.Process]::Start($psi)
  $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($Text + "`n")
  $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $proc.StandardInput.Close()
  $proc.WaitForExit()
}

switch ($Command) {
  'build' { Build-Image; 'Imagem pronta.' }

  'list' {
    $ips = Get-HostIps
    for ($i = 0; $i -lt $Vpns.Count; $i++) {
      $v = $Vpns[$i]
      $login = Get-Login $v
      $who = if ($login.User) { "$($login.User) ($($login.Source))" } else { "sem login: rode .\onlyroute.ps1 login $($v.id)" }
      "$($i + 1)) $($v.id) - $($v.name)  [$($v.gateway):$($v.port)]  usuario: $who"
      $fwd = @($v.forward | Where-Object { $_ })
      if ($fwd.Count -eq 0) { '     (nenhum site repassado)' }
      foreach ($f in $fwd) { $p = Parse-Forward $f; "     $($p.Host):$($p.Port) -> $($ips[$p.Host.ToLower()])" }
    }
  }

  'login' {
    $v = Select-Vpn
    $old = Get-VaultCred $v.id
    $prompt = "Usuario ($($v.name))"
    if ($old -and $old.User) { $prompt += " [Enter mantem $($old.User)]" }
    $user = Read-Host $prompt
    if (-not $user -and $old) { $user = $old.User }
    if (-not $user) { throw 'Usuario vazio.' }
    $secure = Read-Host 'Senha (Enter = nao salvar; o up pergunta)' -AsSecureString
    $pass = [Net.NetworkCredential]::new('', $secure).Password
    Set-VaultCred $v.id $user $pass
    if ($pass) { "Usuario e senha de $($v.id) salvos no cofre do Windows." } else { "Usuario de $($v.id) salvo no cofre; a senha sera pedida no up." }
  }

  'logout' {
    $v = Select-Vpn
    Remove-VaultCred $v.id
    "Usuario e senha de $($v.id) apagados do cofre do Windows."
  }

  'up' {
    if (Is-Connected) {
      "Ja existe uma VPN ligada ($(Get-CurrentVpn)). Rode 'down' antes de trocar."
      return
    }
    Remove-VpnContainer   # sobra de uma tentativa anterior que nao terminou
    if (-not (Test-HostsUpToDate)) {
      Write-Host 'O arquivo hosts nao esta igual ao vpns.json.'
      Update-Hosts | Out-Null
    }
    if (-not (docker images -q $Image)) {
      # Reaproveita a imagem do nome antigo, se houver; senao monta.
      if (docker images -q $LegacyName) { docker tag $LegacyName $Image | Out-Null }
      else { 'Montando a imagem (so na primeira vez)...'; Build-Image }
    }

    $v = Select-Vpn
    $login = Get-Login $v
    $user = $login.User
    if (-not $user) { $user = Read-Host "Usuario ($($v.name))" }
    $password = $login.Pass

    # Portas: cada site vira 127.0.0.x:porta no Windows -> porta interna do container
    $ips = Get-HostIps
    $portArgs = @()
    $forwards = @()
    $internal = 20000
    foreach ($f in @($v.forward | Where-Object { $_ })) {
      $p = Parse-Forward $f
      $portArgs += @('-p', "$($ips[$p.Host.ToLower()]):$($p.Port):$internal")
      $forwards += "$internal=$($p.Host):$($p.Port)"
      $internal++
    }

    # Sem --rm: se a conexao falhar, ainda da para ler as mensagens de erro.
    $runArgs = @('run', '-d', '--name', $Name, '--label', "$Label=$($v.id)",
      # SYS_ADMIN: em alguns kernels do Docker/WSL o pppd precisa dela ("Couldn't set tty to PPP discipline").
      '--cap-add', 'NET_ADMIN', '--cap-add', 'SYS_ADMIN', '--device', '/dev/ppp') + $portArgs + @(
      '-e', "VPN_HOST=$($v.gateway)", '-e', "VPN_PORT=$($v.port)", '-e', "VPN_USER=$user",
      '-e', "FORWARDS=$($forwards -join ' ')", '-e', "TRUSTED_CERT=$($v.trustedCert)",
      '-e', 'DETACHED=1', $Image)
    docker @runArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Nao consegui iniciar o container da VPN (porta ocupada?).' }

    "Conectando em $($v.name) ($($v.gateway):$($v.port)) como $user"
    if ($password) {
      Send-VpnInput $password
    } else {
      $secure = Read-Host 'Senha da VPN' -AsSecureString
      Send-VpnInput ([Net.NetworkCredential]::new('', $secure).Password)
    }

    $otpSent = $false
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
      Start-Sleep -Milliseconds 700
      if (-not (Is-Running)) { Show-FailureAndCleanup 'A VPN nao conectou. Ultimas mensagens:'; return }
      $log = Read-VpnLog
      if ($log -match 'Tunnel is up') {
        'VPN ligada. Pode fechar este terminal.'
        foreach ($f in $forwards) { "  pela VPN: $(($f -split '=')[1])" }
        return
      }
      if (-not $otpSent -and $log -match 'Two-factor authentication token') {
        $otp = Read-Host 'Codigo de verificacao'
        Send-VpnInput $otp
        $otpSent = $true
        $deadline = (Get-Date).AddSeconds(60)
      }
      if ((Get-Date) -gt $deadline) { Show-FailureAndCleanup 'Tempo esgotado esperando a VPN conectar. Ultimas mensagens:'; return }
    }
  }

  'down' { Remove-VpnContainer; 'VPN desligada.' }

  'status' {
    if (Is-Running) {
      $current = Get-CurrentVpn
      $ppp = docker exec $Name sh -c 'ip -4 addr show ppp0 2>/dev/null | grep inet'
      if ($ppp) { "VPN ligada ($current). $($ppp.Trim())" } else { "Container rodando ($current), mas a VPN ainda nao conectou." }
    } else { 'VPN desligada.' }
  }

  'add' {
    if (-not $Vpn) { throw 'Informe o site, ex: .\onlyroute.ps1 add jira.empresa.com.br [vpn]' }
    $site = Normalize-Site $Vpn
    $script:Vpn = $Arg2
    $v = Select-Vpn
    $existing = @($v.forward | Where-Object { $_ })
    if ($existing | Where-Object { (Normalize-Site $_) -eq $site }) {
      "$site ja passa pela VPN $($v.id)."
    } else {
      if ($v.PSObject.Properties['forward']) { $v.forward = @($existing + $site) }
      else { $v | Add-Member -NotePropertyName forward -NotePropertyValue @($site) }
      Save-Config
      "Adicionado: $site passa pela VPN $($v.id)."
    }
    if (Update-Hosts) { Offer-Reconnect }
  }

  'remove' {
    if (-not $Vpn) { throw 'Informe o site, ex: .\onlyroute.ps1 remove jira.empresa.com.br [vpn]' }
    $site = Normalize-Site $Vpn
    $targets = $Vpns
    if ($Arg2) { $script:Vpn = $Arg2; $targets = @(Select-Vpn) }
    $changed = @()
    foreach ($v in $targets) {
      $before = @($v.forward | Where-Object { $_ })
      $after = @($before | Where-Object { (Normalize-Site $_) -ne $site })
      if ($after.Count -ne $before.Count) { $v.forward = $after; $changed += $v.id }
    }
    if ($changed.Count -eq 0) { "$site nao esta em nenhum forward."; return }
    Save-Config
    "Removido: $site nao passa mais pela VPN ($($changed -join ', '))."
    if (Update-Hosts) { Offer-Reconnect }
  }

  'hosts-setup' {
    Require-Admin
    $ips = Get-HostIps
    Write-HostsEntries
    'Pronto. Estes sites passam pela VPN (quando ela estiver ligada):'
    foreach ($h in $ips.Keys) { "  $h -> $($ips[$h])" }
    'Feche e abra de novo os programas que ja estavam abertos.'
  }

  'hosts-remove' {
    Require-Admin
    Remove-HostsEntries
    'Removido: os sites voltam a sair pela rede normal.'
  }

  'uninstall' {
    # Desfaz tudo o que o OnlyRoute muda no PC. Os arquivos desta pasta ficam.
    Require-Admin
    Remove-VpnContainer
    'VPN desligada e container removido.'
    Remove-HostsEntries
    'Linhas do OnlyRoute removidas do arquivo hosts.'
    docker rmi $Image $LegacyName 2>&1 | Out-Null
    "Imagem Docker '$Image' removida."
    foreach ($v in $Vpns) { Remove-VaultCred $v.id }
    'Usuarios e senhas apagados do cofre do Windows.'
    'Pronto. Para usar de novo: login, hosts-setup (Admin) e up.'
    "A imagem base 'debian:trixie-slim' foi mantida; para remover: docker rmi debian:trixie-slim"
  }
}
