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
    .\onlyroute.ps1 help           # mostra esta ajuda

  Configuracao:
    vpns.json        VPNs cadastradas (gateway, porta, sites repassados)
    Usuario e senha: no Gerenciador de Credenciais do Windows ("login"), o mesmo
    que o app usa. Alternativa: onlyroute.env (veja onlyroute.env.example).

  Idioma / Language: ONLYROUTE_LANG=pt ou en. Sem ela, segue o idioma do Windows.
#>
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'status', 'list', 'login', 'logout', 'add', 'remove', 'build', 'hosts-setup', 'hosts-remove', 'uninstall', 'help')]
  [string]$Command = 'up',
  [Parameter(Position = 1)][string]$Vpn,
  [Parameter(Position = 2)][string]$Arg2
)

# --- Idioma: ONLYROUTE_LANG (pt/en) ganha; senao o idioma do Windows; senao ingles ---
$Lang = "$env:ONLYROUTE_LANG".Trim().ToLower()
if ($Lang -like 'pt*') { $UsePt = $true }
elseif ($Lang -like 'en*') { $UsePt = $false }
else { $UsePt = "$((Get-UICulture).Name)" -like 'pt*' }

# Devolve o texto em portugues ou em ingles.
function T([string]$PtText, [string]$EnText) { if ($UsePt) { $PtText } else { $EnText } }

function Show-Usage {
  if ($UsePt) {
@'
OnlyRoute: VPN FortiGate (SSL VPN) so para alguns sites, sem FortiClient.

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
  .\onlyroute.ps1 help           # mostra esta ajuda

Idioma: defina ONLYROUTE_LANG=pt ou ONLYROUTE_LANG=en (sem ela, segue o Windows).
'@
  } else {
@'
OnlyRoute: FortiGate VPN (SSL VPN) for just a few sites, without FortiClient.

Usage:
  .\onlyroute.ps1 up [vpn]       # connect in the background (asks which VPN and for the code)
  .\onlyroute.ps1 down           # disconnect
  .\onlyroute.ps1 status         # show whether it is on and which VPN
  .\onlyroute.ps1 list           # list the VPNs and the sites sent through them
  .\onlyroute.ps1 login [vpn]    # save username and password in the Windows vault
  .\onlyroute.ps1 logout [vpn]   # delete username and password from the vault
  .\onlyroute.ps1 add <site> [vpn]     # send a site through the VPN (asks for Admin permission)
  .\onlyroute.ps1 remove <site> [vpn]  # stop sending a site through the VPN (asks for Admin permission)
  .\onlyroute.ps1 hosts-setup    # (Admin) point the sites in vpns.json to the VPN
  .\onlyroute.ps1 hosts-remove   # (Admin) undo hosts-setup
  .\onlyroute.ps1 build          # rebuild the Docker image
  .\onlyroute.ps1 uninstall      # (Admin) undo everything: VPN, hosts, Docker image and logins
  .\onlyroute.ps1 help           # show this help

Language: set ONLYROUTE_LANG=pt or ONLYROUTE_LANG=en (otherwise follows Windows).
'@
  }
}

if ($Command -eq 'help') { Show-Usage; return }

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
if (-not (Test-Path $ConfigFile)) { throw (T "Nao achei $ConfigFile. Copie o vpns.example.json para vpns.json e coloque suas VPNs." "Could not find $ConfigFile. Copy vpns.example.json to vpns.json and add your VPNs.") }
$Vpns = @((Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json).vpns)
if ($Vpns.Count -eq 0) { throw (T 'Nenhuma VPN cadastrada no vpns.json.' 'No VPN set up in vpns.json.') }

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
  $source = if ($cred) { T 'cofre' 'vault' } elseif ($user) { 'onlyroute.env' } else { T 'nenhum' 'none' }
  @{ User = $user; Pass = $pass; Source = $source }
}

function Build-Image {
  docker build -q -t $Image $Here | Out-Null
  if ($LASTEXITCODE -ne 0) { throw (T 'Falha ao montar a imagem Docker.' 'Failed to build the Docker image.') }
}

# --- Docker: nunca assume que ja esta aberto ---
$DockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$DockerBin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'

function Test-DockerInstalled {
  if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
  if (Test-Path (Join-Path $DockerBin 'docker.exe')) { $env:Path += ";$DockerBin"; return $true }
  return $false
}

function Test-DockerUp {
  if (-not (Test-DockerInstalled)) { return $false }
  docker version --format '{{.Server.Version}}' 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# Se o Docker estiver fechado, abre o Docker Desktop e espera ele ficar pronto.
function Wait-Docker {
  if (-not (Test-DockerInstalled)) {
    throw (T "O Docker nao esta instalado. Baixe o Docker Desktop em https://www.docker.com/products/docker-desktop/ , instale, abra uma vez e rode de novo." "Docker is not installed. Download Docker Desktop from https://www.docker.com/products/docker-desktop/ , install it, open it once and run this again.")
  }
  if (Test-DockerUp) { return }
  if (Test-Path $DockerDesktop) { T 'Abrindo o Docker Desktop...' 'Opening Docker Desktop...'; Start-Process $DockerDesktop }
  else { T 'Abra o Docker Desktop.' 'Please open Docker Desktop.' }
  T 'Esperando o Docker ficar pronto (pode levar 1 minuto; Ctrl+C cancela)...' 'Waiting for Docker to be ready (may take a minute; Ctrl+C cancels)...'
  T 'Se o Docker pedir para aceitar os termos ou fazer login, aceite (o login pode pular).' 'If Docker asks you to accept its terms or sign in, accept (you can skip the sign-in).'
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-DockerUp)) {
    if ((Get-Date) -gt $deadline) { throw (T 'O Docker nao ficou pronto em 5 minutos. Abra o Docker Desktop, espere ele terminar de iniciar e rode de novo.' 'Docker was not ready after 5 minutes. Open Docker Desktop, wait for it to finish starting and run this again.') }
    Start-Sleep -Seconds 2
  }
  T 'Docker pronto.' 'Docker is ready.'
}

# O pppd precisa do suporte a PPP ligado no Linux do Docker. Em kernels mais novos
# (WSL 2 recente) ele vem desligado e o container nao consegue ligar sozinho
# ("Couldn't set tty to PPP discipline"). Liga uma vez com um container
# privilegiado de vida curta; vale ate o Docker reiniciar.
function Test-Ppp { [bool](docker run --rm --entrypoint cat $Image /proc/tty/ldiscs 2>$null | Select-String '^ppp\s') }
function Enable-Ppp {
  if (Test-Ppp) { return $true }
  docker run --rm --privileged --pid=host --entrypoint nsenter $Image -t 1 -m modprobe ppp_async 2>&1 | Out-Null
  if (Test-Ppp) { return $true }
  # Kernels novos do WSL (6.x) deixam os modulos onde so as distros do WSL enxergam;
  # a distro docker-desktop usa o mesmo kernel do Docker, entao carrega por ela.
  wsl.exe -d docker-desktop -u root modprobe ppp_async 2>&1 | Out-Null
  return (Test-Ppp)
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

# Le os rotulos em JSON: o PowerShell 5.1 tira aspas internas ao chamar o docker.
function Get-CurrentVpn {
  $json = docker inspect -f '{{json .Config.Labels}}' $Name 2>$null
  if (-not $json) { return '' }
  $labels = $json | ConvertFrom-Json
  return $labels.$Label
}

# Mostra as ultimas mensagens da VPN e remove o container.
function Show-FailureAndCleanup([string]$Title) {
  $Title
  $log = Read-VpnLog
  ($log -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 6) -join "`n"
  if ($log -match 'pppd: An immediately fatal error') {
    ''
    T 'O login funcionou, mas o Docker nao deixou montar o tunel (suporte a PPP).' 'The login worked, but Docker did not allow the tunnel to be set up (PPP support).'
    T 'Rode "wsl --update", feche e abra o Docker Desktop e tente de novo.' 'Run "wsl --update", close and reopen Docker Desktop and try again.'
  }
  Remove-VpnContainer
}

function Is-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Require-Admin {
  if (-not (Is-Admin)) { throw (T 'Este comando mexe no arquivo hosts: abra o PowerShell como Administrador e rode de novo.' 'This command changes the hosts file: open PowerShell as Administrator and run it again.') }
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
  Write-Host (T 'Atualizando o arquivo hosts: o Windows vai pedir permissao de administrador...' 'Updating the hosts file: Windows will ask for administrator permission...')
  try {
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'hosts-setup')
  } catch {
    Write-Host (T 'Permissao negada: o hosts nao foi atualizado. Rode hosts-setup como Administrador depois.' 'Permission denied: the hosts file was not updated. Run hosts-setup as Administrator later.')
    return $false
  }
  if (Test-HostsUpToDate) { Write-Host (T 'Arquivo hosts atualizado.' 'Hosts file updated.'); return $true }
  Write-Host (T 'Nao consegui atualizar o hosts. Rode hosts-setup como Administrador.' 'Could not update the hosts file. Run hosts-setup as Administrator.')
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
  $answer = Read-Host (T "A VPN ($current) esta ligada. Reconectar agora para aplicar? (s/N)" "The VPN ($current) is on. Reconnect now to apply? (y/N)")
  if ($answer -match '^[sSyY]') {
    Remove-VpnContainer
    & $PSCommandPath up $current
  } else {
    T "Vale na proxima vez que ligar (ou rode 'down' e 'up')." "It takes effect the next time you connect (or run 'down' and 'up')."
  }
}

# O gateway as vezes vem como endereco inteiro ("https://vpn.x.com:10443/remote/login").
# O openfortivpn quer so o host, com a porta separada; a porta no endereco vale mais.
function Split-Gateway($Gateway, $Port) {
  $g = "$Gateway".Trim() -replace '^[a-zA-Z]+://', '' -replace '[/?#].*$', ''
  $p = 10443
  if ("$Port" -match '^\d+$') { $p = [int]$Port }
  if ($g -match '^([^:]*):(\d{1,5})$') { $g = $Matches[1]; $p = [int]$Matches[2] }
  @{ Host = $g; Port = $p }
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
    if (-not $match) { throw (T "VPN '$Vpn' nao esta no vpns.json. Use: .\onlyroute.ps1 list" "VPN '$Vpn' is not in vpns.json. Use: .\onlyroute.ps1 list") }
    return $match
  }
  if ($Vpns.Count -eq 1) { return $Vpns[0] }
  $labels = @($Vpns | ForEach-Object { "$($_.name)  [$($_.gateway)]" })
  $Vpns[(Select-Menu (T 'Qual VPN? (setas + Enter, Esc cancela)' 'Which VPN? (arrows + Enter, Esc cancels)') $labels)]
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
      $answer = Read-Host (T 'Numero' 'Number')
      if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $n) { return [int]$answer - 1 }
      Write-Host (T 'Numero invalido.' 'Invalid number.')
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
        'Escape' { throw (T 'Cancelado.' 'Cancelled.') }
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
  'build' { Wait-Docker; Build-Image; T 'Imagem pronta.' 'Image ready.' }

  'list' {
    $ips = Get-HostIps
    for ($i = 0; $i -lt $Vpns.Count; $i++) {
      $v = $Vpns[$i]
      $login = Get-Login $v
      $who = if ($login.User) { "$($login.User) ($($login.Source))" } else { T "sem login: rode .\onlyroute.ps1 login $($v.id)" "no login: run .\onlyroute.ps1 login $($v.id)" }
      "$($i + 1)) $($v.id) - $($v.name)  [$($v.gateway):$($v.port)]  $(T 'usuario' 'user'): $who"
      $fwd = @($v.forward | Where-Object { $_ })
      if ($fwd.Count -eq 0) { T '     (nenhum site repassado)' '     (no sites sent through it)' }
      foreach ($f in $fwd) { $p = Parse-Forward $f; "     $($p.Host):$($p.Port) -> $($ips[$p.Host.ToLower()])" }
    }
  }

  'login' {
    $v = Select-Vpn
    $old = Get-VaultCred $v.id
    $prompt = T "Usuario ($($v.name))" "Username ($($v.name))"
    if ($old -and $old.User) { $prompt += T " [Enter mantem $($old.User)]" " [Enter keeps $($old.User)]" }
    $user = Read-Host $prompt
    if (-not $user -and $old) { $user = $old.User }
    if (-not $user) { throw (T 'Usuario vazio.' 'Empty username.') }
    $secure = Read-Host (T 'Senha (Enter = nao salvar; o up pergunta)' 'Password (Enter = do not save; up will ask)') -AsSecureString
    $pass = [Net.NetworkCredential]::new('', $secure).Password
    Set-VaultCred $v.id $user $pass
    if ($pass) { T "Usuario e senha de $($v.id) salvos no cofre do Windows." "Username and password for $($v.id) saved in the Windows vault." } else { T "Usuario de $($v.id) salvo no cofre; a senha sera pedida no up." "Username for $($v.id) saved in the vault; up will ask for the password." }
  }

  'logout' {
    $v = Select-Vpn
    Remove-VaultCred $v.id
    T "Usuario e senha de $($v.id) apagados do cofre do Windows." "Username and password for $($v.id) deleted from the Windows vault."
  }

  'up' {
    Wait-Docker
    if (Is-Connected) {
      $current = Get-CurrentVpn
      T "Ja existe uma VPN ligada ($current). Rode 'down' antes de trocar." "A VPN is already on ($current). Run 'down' before switching."
      return
    }
    Remove-VpnContainer   # sobra de uma tentativa anterior que nao terminou
    if (-not (Test-HostsUpToDate)) {
      Write-Host (T 'O arquivo hosts nao esta igual ao vpns.json.' 'The hosts file does not match vpns.json.')
      Update-Hosts | Out-Null
    }
    if (-not (docker images -q $Image)) {
      # Reaproveita a imagem do nome antigo, se houver; senao monta.
      if (docker images -q $LegacyName) { docker tag $LegacyName $Image | Out-Null }
      else { T 'Montando a imagem (so na primeira vez)...' 'Building the image (first time only)...'; Build-Image }
    }
    $pppOk = Enable-Ppp

    $v = Select-Vpn
    $login = Get-Login $v
    $user = $login.User
    if (-not $user) { $user = Read-Host (T "Usuario ($($v.name))" "Username ($($v.name))") }
    $password = $login.Pass

    # Portas: cada site vira 127.0.0.x:porta no Windows -> porta interna do container
    $ips = Get-HostIps
    $gw = Split-Gateway $v.gateway $v.port
    $portArgs = @()
    $forwards = @()
    $internal = 20000
    foreach ($f in @($v.forward | Where-Object { $_ })) {
      $p = Parse-Forward $f
      $portArgs += @('-p', "$($ips[$p.Host.ToLower()]):$($p.Port):$internal")
      $forwards += "$internal=$($p.Host):$($p.Port)"
      $internal++
    }

    # Se o suporte a PPP nao ligou, o container recebe SYS_ADMIN: em outros
    # kernels do Docker/WSL e isso que resolve o "Couldn't set tty to PPP discipline".
    $sysAdmin = @()
    if (-not $pppOk) { $sysAdmin = @('--cap-add', 'SYS_ADMIN') }

    # Sem --rm: se a conexao falhar, ainda da para ler as mensagens de erro.
    $runArgs = @('run', '-d', '--name', $Name, '--label', "$Label=$($v.id)",
      '--cap-add', 'NET_ADMIN') + $sysAdmin + @('--device', '/dev/ppp') + $portArgs + @(
      '-e', "VPN_HOST=$($gw.Host)", '-e', "VPN_PORT=$($gw.Port)", '-e', "VPN_USER=$user",
      '-e', "FORWARDS=$($forwards -join ' ')", '-e', "TRUSTED_CERT=$($v.trustedCert)",
      '-e', 'DETACHED=1', $Image)
    docker @runArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw (T 'Nao consegui iniciar o container da VPN (porta ocupada?).' 'Could not start the VPN container (port already in use?).') }

    T "Conectando em $($v.name) ($($gw.Host):$($gw.Port)) como $user" "Connecting to $($v.name) ($($gw.Host):$($gw.Port)) as $user"
    if ($password) {
      Send-VpnInput $password
    } else {
      $secure = Read-Host (T 'Senha da VPN' 'VPN password') -AsSecureString
      Send-VpnInput ([Net.NetworkCredential]::new('', $secure).Password)
    }

    $otpSent = $false
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
      Start-Sleep -Milliseconds 700
      if (-not (Is-Running)) { Show-FailureAndCleanup (T 'A VPN nao conectou. Ultimas mensagens:' 'The VPN did not connect. Last messages:'); return }
      $log = Read-VpnLog
      if ($log -match 'Tunnel is up') {
        T 'VPN ligada. Pode fechar este terminal.' 'VPN is on. You can close this terminal.'
        foreach ($f in $forwards) { "  $(T 'pela VPN' 'via VPN'): $(($f -split '=')[1])" }
        return
      }
      if (-not $otpSent -and $log -match 'Two-factor authentication token') {
        $otp = Read-Host (T 'Codigo de verificacao' 'Verification code')
        Send-VpnInput $otp
        $otpSent = $true
        $deadline = (Get-Date).AddSeconds(60)
      }
      if ((Get-Date) -gt $deadline) { Show-FailureAndCleanup (T 'Tempo esgotado esperando a VPN conectar. Ultimas mensagens:' 'Timed out waiting for the VPN to connect. Last messages:'); return }
    }
  }

  'down' {
    if (-not (Test-DockerUp)) { T 'VPN desligada (o Docker nao esta aberto).' 'VPN is off (Docker is not running).'; return }
    Remove-VpnContainer; T 'VPN desligada.' 'VPN is off.'
  }

  'status' {
    if (-not (Test-DockerUp)) { T 'VPN desligada (o Docker nao esta aberto).' 'VPN is off (Docker is not running).' }
    elseif (Is-Running) {
      $current = Get-CurrentVpn
      $ppp = docker exec $Name sh -c 'ip -4 addr show ppp0 2>/dev/null | grep inet'
      if ($ppp) { T "VPN ligada ($current). $($ppp.Trim())" "VPN is on ($current). $($ppp.Trim())" } else { T "Container rodando ($current), mas a VPN ainda nao conectou." "Container running ($current), but the VPN has not connected yet." }
    } else { T 'VPN desligada.' 'VPN is off.' }
  }

  'add' {
    if (-not $Vpn) { throw (T 'Informe o site, ex: .\onlyroute.ps1 add jira.empresa.com.br [vpn]' 'Tell me the site, e.g. .\onlyroute.ps1 add jira.company.com [vpn]') }
    $site = Normalize-Site $Vpn
    $script:Vpn = $Arg2
    $v = Select-Vpn
    $existing = @($v.forward | Where-Object { $_ })
    if ($existing | Where-Object { (Normalize-Site $_) -eq $site }) {
      T "$site ja passa pela VPN $($v.id)." "$site already goes through the VPN $($v.id)."
    } else {
      if ($v.PSObject.Properties['forward']) { $v.forward = @($existing + $site) }
      else { $v | Add-Member -NotePropertyName forward -NotePropertyValue @($site) }
      Save-Config
      T "Adicionado: $site passa pela VPN $($v.id)." "Added: $site now goes through the VPN $($v.id)."
    }
    if (Update-Hosts) { Offer-Reconnect }
  }

  'remove' {
    if (-not $Vpn) { throw (T 'Informe o site, ex: .\onlyroute.ps1 remove jira.empresa.com.br [vpn]' 'Tell me the site, e.g. .\onlyroute.ps1 remove jira.company.com [vpn]') }
    $site = Normalize-Site $Vpn
    $targets = $Vpns
    if ($Arg2) { $script:Vpn = $Arg2; $targets = @(Select-Vpn) }
    $changed = @()
    foreach ($v in $targets) {
      $before = @($v.forward | Where-Object { $_ })
      $after = @($before | Where-Object { (Normalize-Site $_) -ne $site })
      if ($after.Count -ne $before.Count) { $v.forward = $after; $changed += $v.id }
    }
    if ($changed.Count -eq 0) { T "$site nao esta em nenhum forward." "$site is not in any forward list."; return }
    Save-Config
    T "Removido: $site nao passa mais pela VPN ($($changed -join ', '))." "Removed: $site no longer goes through the VPN ($($changed -join ', '))."
    if (Update-Hosts) { Offer-Reconnect }
  }

  'hosts-setup' {
    Require-Admin
    $ips = Get-HostIps
    Write-HostsEntries
    T 'Pronto. Estes sites passam pela VPN (quando ela estiver ligada):' 'Done. These sites go through the VPN (when it is on):'
    foreach ($h in $ips.Keys) { "  $h -> $($ips[$h])" }
    T 'Feche e abra de novo os programas que ja estavam abertos.' 'Close and reopen any programs that were already open.'
  }

  'hosts-remove' {
    Require-Admin
    Remove-HostsEntries
    T 'Removido: os sites voltam a sair pela rede normal.' 'Removed: the sites go through the normal network again.'
  }

  'uninstall' {
    # Desfaz tudo o que o OnlyRoute muda no PC. Os arquivos desta pasta ficam.
    Require-Admin
    Remove-VpnContainer
    T 'VPN desligada e container removido.' 'VPN turned off and container removed.'
    Remove-HostsEntries
    T 'Linhas do OnlyRoute removidas do arquivo hosts.' 'OnlyRoute lines removed from the hosts file.'
    docker rmi $Image $LegacyName 2>&1 | Out-Null
    T "Imagem Docker '$Image' removida." "Docker image '$Image' removed."
    foreach ($v in $Vpns) { Remove-VaultCred $v.id }
    T 'Usuarios e senhas apagados do cofre do Windows.' 'Usernames and passwords deleted from the Windows vault.'
    T 'Pronto. Para usar de novo: login, hosts-setup (Admin) e up.' 'Done. To use it again: login, hosts-setup (Admin) and up.'
    T "A imagem base 'debian:trixie-slim' foi mantida; para remover: docker rmi debian:trixie-slim" "The base image 'debian:trixie-slim' was kept; to remove it: docker rmi debian:trixie-slim"
  }
}
