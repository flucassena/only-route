#!/usr/bin/env bash
# OnlyRoute: VPN FortiGate (SSL VPN) só para alguns sites, sem FortiClient.
# Port of onlyroute.ps1 for Linux and macOS (bash 3.2+).
#
# The VPN runs inside a Docker container; the computer stays on the normal
# internet. Each site in "forward" (vpns.json) gets a line in /etc/hosts that
# points it to a local address (127.0.0.x); the container relays that
# connection through the tunnel.
#
# Uso:
#   ./onlyroute.sh up [vpn]            # conecta em segundo plano (pergunta qual VPN, pede o código)
#   ./onlyroute.sh down                # desliga
#   ./onlyroute.sh status              # mostra se está ligada e qual VPN
#   ./onlyroute.sh list                # lista as VPNs e os sites repassados
#   ./onlyroute.sh login [vpn]         # grava usuário e senha (Keychain no macOS, secret-tool no Linux)
#   ./onlyroute.sh logout [vpn]        # apaga usuário e senha
#   ./onlyroute.sh add <site> [vpn]    # passa um site pela VPN (pede a senha do sudo)
#   ./onlyroute.sh remove <site> [vpn] # tira um site da VPN (pede a senha do sudo)
#   ./onlyroute.sh hosts-setup         # (root) aponta os sites do vpns.json para a VPN
#   ./onlyroute.sh hosts-remove        # (root) desfaz o hosts-setup
#   ./onlyroute.sh build               # remonta a imagem Docker
#   ./onlyroute.sh uninstall           # desfaz tudo: VPN, hosts, imagem Docker e logins
#
# Configuração:
#   vpns.json        VPNs cadastradas (gateway, porta, sites repassados)
#   Usuário e senha: Keychain (macOS) ou secret-tool/libsecret (Linux), os mesmos
#   que o app usa. Alternativa: onlyroute.env (veja onlyroute.env.example).
#
# Environment overrides (mostly for testing):
#   ONLYROUTE_CONFIG  path of vpns.json      (default: next to this script)
#   ONLYROUTE_HOSTS   path of the hosts file (default: /etc/hosts)
#   ONLYROUTE_ENV     path of onlyroute.env  (default: next to this script)
#   ONLYROUTE_VAULT   "none" disables Keychain/secret-tool
#   ONLYROUTE_LANG    "pt" or "en" (default: from LC_ALL / LC_MESSAGES / LANG)

set -euo pipefail
set -f # no globbing: forward lists are split on spaces

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
SCRIPT_PATH="$SCRIPT_DIR/$(basename "$0")"
IMAGE=onlyroute
NAME=onlyroute
LABEL=onlyroute.vpn
LEGACY_NAME=vpn-git
HOSTS_MARKER='# onlyroute'
# Lines we own in the hosts file (also the old project name).
OUR_LINE='#[[:space:]]*(onlyroute|vpn-git)[[:space:]]*$'
CONFIG_FILE=${ONLYROUTE_CONFIG:-$SCRIPT_DIR/vpns.json}
HOSTS_FILE=${ONLYROUTE_HOSTS:-/etc/hosts}
OS=$(uname -s)
US=$'\037' # field separator for config dumps (never in JSON values we care about)

die() { printf '%s\n' "$*" >&2; exit 1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
is_root() { [ "$(id -u)" -eq 0 ]; }

# --- language: ONLYROUTE_LANG (pt|en), else LC_ALL / LC_MESSAGES / LANG; "pt*" -> Portuguese, anything else -> English ---
OR_LANG=${ONLYROUTE_LANG:-}
if [ -z "$OR_LANG" ]; then
  OR_LANG=${LC_ALL:-}
  [ -n "$OR_LANG" ] || OR_LANG=${LC_MESSAGES:-}
  [ -n "$OR_LANG" ] || OR_LANG=${LANG:-}
fi
case "$(lower "$OR_LANG")" in pt*) OR_PT=1; OR_LANG=pt ;; *) OR_PT=0; OR_LANG=en ;; esac
# t "<português>" "<english>": prints the text in the chosen language.
t() { if [ "$OR_PT" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

usage() {
  if [ "$OR_PT" = 1 ]; then
    sed -n '2,/^# Environment/p' "$SCRIPT_PATH" | sed -e '$d' -e 's/^# \{0,1\}//'
    return
  fi
  cat <<'EOF'
OnlyRoute: FortiGate VPN (SSL VPN) for just a few sites, without FortiClient.
Port of onlyroute.ps1 for Linux and macOS (bash 3.2+).

The VPN runs inside a Docker container; the computer stays on the normal
internet. Each site in "forward" (vpns.json) gets a line in /etc/hosts that
points it to a local address (127.0.0.x); the container relays that
connection through the tunnel.

Usage:
  ./onlyroute.sh up [vpn]            # connects in the background (asks which VPN, asks for the code)
  ./onlyroute.sh down                # disconnects
  ./onlyroute.sh status              # shows whether it is on and which VPN
  ./onlyroute.sh list                # lists the VPNs and the forwarded sites
  ./onlyroute.sh login [vpn]         # saves user and password (Keychain on macOS, secret-tool on Linux)
  ./onlyroute.sh logout [vpn]        # deletes user and password
  ./onlyroute.sh add <site> [vpn]    # sends a site through the VPN (asks for the sudo password)
  ./onlyroute.sh remove <site> [vpn] # takes a site off the VPN (asks for the sudo password)
  ./onlyroute.sh hosts-setup         # (root) points the sites in vpns.json to the VPN
  ./onlyroute.sh hosts-remove        # (root) undoes hosts-setup
  ./onlyroute.sh build               # rebuilds the Docker image
  ./onlyroute.sh uninstall           # undoes everything: VPN, hosts, Docker image and logins

Configuration:
  vpns.json        Registered VPNs (gateway, port, forwarded sites)
  User and password: Keychain (macOS) or secret-tool/libsecret (Linux), the same
  ones the app uses. Alternative: onlyroute.env (see onlyroute.env.example).
  Language: ONLYROUTE_LANG=pt or ONLYROUTE_LANG=en (default: from LANG).
EOF
}

# --- arguments ---
CMD=${1:-up}
VPN_ARG=${2:-}
ARG2=${3:-}
case "$CMD" in
  up | down | status | list | login | logout | add | remove | build | hosts-setup | hosts-remove | uninstall | _uninstall-system) ;;
  -h | --help | help) usage; exit 0 ;;
  *) usage >&2; die "$(t "Comando desconhecido: $CMD" "Unknown command: $CMD")" ;;
esac

# --- JSON (python3, else jq) ---
PY=
for c in python3 python; do
  # On Windows "python3" may be a Store stub that fails; check it really runs Python 3.
  if command -v "$c" >/dev/null 2>&1 &&
    "$c" -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
    PY=$c
    break
  fi
done
if [ -z "$PY" ] && ! command -v jq >/dev/null 2>&1; then
  die "$(t "Preciso do python3 ou do jq para ler o vpns.json. Instale um deles." "I need python3 or jq to read vpns.json. Please install one of them.")"
fi
export PYTHONIOENCODING=utf-8

# Prints one line per VPN: id US name US gateway US port US credentials US trustedCert US forward (space separated).
config_dump() {
  if [ -n "$PY" ]; then
    "$PY" - "$CONFIG_FILE" <<'PYEOF'
import json, sys
with open(sys.argv[1], encoding="utf-8-sig") as f:
    data = json.load(f)
def s(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v).lower()
    return str(v).replace("\x1f", " ").replace("\n", " ").replace("\r", " ")
for v in (data.get("vpns") or []):
    fwd = [s(x).replace(" ", "") for x in (v.get("forward") or []) if x]
    print("\x1f".join([s(v.get(k)) for k in ("id", "name", "gateway", "port", "credentials", "trustedCert")] + [" ".join(fwd)]))
PYEOF
  else
    jq -r '(.vpns // [])[] | [(.id, .name, .gateway, .port, .credentials, .trustedCert | . // "" | tostring),
      ((.forward // []) | map(select(. != null and . != "") | tostring) | join(" "))] | join("\u001f")' "$CONFIG_FILE"
  fi
}

# config_set_forward <index> "<site> <site> ...": writes vpns.json.
config_set_forward() {
  if [ -n "$PY" ]; then
    "$PY" - "$CONFIG_FILE" "$1" "$2" <<'PYEOF'
import json, sys
path, i, fwd = sys.argv[1], int(sys.argv[2]), sys.argv[3].split()
with open(path, encoding="utf-8-sig") as f:
    data = json.load(f)
data["vpns"][i]["forward"] = fwd
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF
  else
    local tmp
    tmp=$(mktemp)
    jq --argjson i "$1" --arg f "$2" '.vpns[$i].forward = ($f | split(" ") | map(select(. != "")))' \
      "$CONFIG_FILE" >"$tmp" && cat "$tmp" >"$CONFIG_FILE"
    rm -f "$tmp"
  fi
}

# Loads vpns.json into parallel arrays (bash 3.2 has no associative arrays).
V_ID=() V_NAME=() V_GW=() V_PORT=() V_CRED=() V_CERT=() V_FWD=()
load_config() {
  [ -f "$CONFIG_FILE" ] || die "$(t "Não achei $CONFIG_FILE. Copie o vpns.example.json para vpns.json e coloque suas VPNs." "Could not find $CONFIG_FILE. Copy vpns.example.json to vpns.json and add your VPNs.")"
  V_ID=() V_NAME=() V_GW=() V_PORT=() V_CRED=() V_CERT=() V_FWD=()
  local dump id name gw port cred cert fwd
  dump=$(config_dump | tr -d '\r') || die "$(t "Não consegui ler $CONFIG_FILE (JSON inválido?)." "Could not read $CONFIG_FILE (invalid JSON?).")"
  while IFS="$US" read -r id name gw port cred cert fwd; do
    [ -n "$id$name$gw" ] || continue
    V_ID+=("$id") V_NAME+=("$name") V_GW+=("$gw") V_PORT+=("$port")
    V_CRED+=("$cred") V_CERT+=("$cert") V_FWD+=("$fwd")
  done <<EOF
$dump
EOF
  [ "${#V_ID[@]}" -gt 0 ] || die "$(t "Nenhuma VPN cadastrada no vpns.json." "No VPN registered in vpns.json.")"
}

# --- sites ---
# "host" or "host:port" (default 443) -> sets F_HOST and F_PORT.
parse_forward() {
  local re='^(.+):([0-9]+)$'
  if [[ $1 =~ $re ]]; then
    F_HOST=${BASH_REMATCH[1]} F_PORT=${BASH_REMATCH[2]}
  else
    F_HOST=$1 F_PORT=443
  fi
}

# Accepts "site", "site:port" or a whole URL (https://site/path).
normalize_site() {
  local s re rest scheme hostport port def
  s=$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  re='^([a-zA-Z][a-zA-Z0-9+.-]*)://(.*)$'
  if [[ $s =~ $re ]]; then
    scheme=$(lower "${BASH_REMATCH[1]}")
    rest=${BASH_REMATCH[2]}
    hostport=${rest%%[/?#]*}
    hostport=${hostport##*@} # drop user:pass@
    hostport=$(lower "$hostport")
    re='^(.*):([0-9]+)$'
    if [[ $hostport =~ $re ]]; then
      port=$((10#${BASH_REMATCH[2]}))
      case "$scheme" in
        http | ws) def=80 ;; https | wss) def=443 ;; ftp) def=21 ;; *) def= ;;
      esac
      if [ "$port" = "$def" ]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
      else
        printf '%s\n' "${BASH_REMATCH[1]}:$port"
      fi
    else
      printf '%s\n' "${hostport%:}"
    fi
    return
  fi
  lower "${s%%/*}"
  echo
}

# Each site gets a fixed local address: 127.0.0.1, 127.0.0.2, ... in order of
# first appearance in vpns.json, so several sites can share the same port.
HOST_NAMES=() HOST_IPS=()
compute_host_ips() {
  HOST_NAMES=() HOST_IPS=()
  local i f h
  for ((i = 0; i < ${#V_ID[@]}; i++)); do
    for f in ${V_FWD[i]}; do
      parse_forward "$f"
      h=$(lower "$F_HOST")
      host_ip "$h" >/dev/null && continue
      HOST_NAMES+=("$h")
      HOST_IPS+=("127.0.0.$((${#HOST_NAMES[@]}))")
    done
  done
}

host_ip() {
  local i
  for ((i = 0; i < ${#HOST_NAMES[@]}; i++)); do
    if [ "${HOST_NAMES[i]}" = "$1" ]; then
      printf '%s\n' "${HOST_IPS[i]}"
      return 0
    fi
  done
  return 1
}

# --- onlyroute.env (optional alternative to the keychain) ---
ENV_FILE=${ONLYROUTE_ENV:-}
if [ -z "$ENV_FILE" ]; then
  for f in "$SCRIPT_DIR/onlyroute.env" "$SCRIPT_DIR/vpn-git.env"; do
    if [ -f "$f" ]; then ENV_FILE=$f; break; fi
  done
fi

env_get() {
  [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || return 0
  local line key value re='^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$'
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*# ]] && continue
    [[ $line =~ $re ]] || continue
    key=$(upper "${BASH_REMATCH[1]}")
    [ "$key" = "$1" ] || continue
    value=$(printf '%s' "${BASH_REMATCH[2]}" | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
    if [ -n "$value" ]; then printf '%s\n' "$value"; return 0; fi
  done <"$ENV_FILE"
}

cred_prefix() { # <index>
  if [ -n "${V_CRED[$1]}" ]; then upper "${V_CRED[$1]}"; else upper "${V_ID[$1]}"; fi
}

# --- credential store ---
# macOS: Keychain generic password, service "onlyroute:<id>", account = user.
# Linux: libsecret item with attributes service=onlyroute id=<id> user=<user>.
# The Electron app uses these same entries.
vault_kind() {
  [ "${ONLYROUTE_VAULT:-}" = none ] && return 0
  if [ "$OS" = Darwin ] && command -v security >/dev/null 2>&1; then
    echo keychain
  elif [ "$OS" = Linux ] && command -v secret-tool >/dev/null 2>&1; then
    echo secret-tool
  fi
}
VAULT=$(vault_kind)

vault_name() {
  case "$VAULT" in
    keychain) echo "$(t 'Keychain do macOS' 'macOS Keychain')" ;;
    secret-tool) echo "$(t 'chaveiro do sistema (secret-tool)' 'system keyring (secret-tool)')" ;;
    *) echo "$(t 'cofre' 'vault')" ;;
  esac
}

# Sets C_FOUND (1/""), C_USER, C_PASS.
vault_get() {
  local id=$1 out
  C_FOUND= C_USER= C_PASS=
  case "$VAULT" in
    keychain)
      out=$(security find-generic-password -s "onlyroute:$id" 2>/dev/null) || return 0
      C_FOUND=1
      C_USER=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*"acct"<blob>="\(.*\)"[[:space:]]*$/\1/p' | head -n 1)
      C_PASS=$(security find-generic-password -s "onlyroute:$id" -w 2>/dev/null) || C_PASS=
      ;;
    secret-tool)
      if C_PASS=$(secret-tool lookup service onlyroute id "$id" 2>/dev/null); then C_FOUND=1; else C_PASS=; fi
      # "search" prints the attributes on stdout or stderr depending on the version.
      C_USER=$(secret-tool search service onlyroute id "$id" 2>&1 | sed -n 's/^attribute\.user = //p' | head -n 1) || C_USER=
      [ -n "$C_USER" ] && C_FOUND=1
      ;;
  esac
  return 0
}

vault_delete() {
  local id=$1 n=0
  case "$VAULT" in
    keychain)
      # Loop in case there are duplicates (one per account).
      while [ $n -lt 20 ] && security delete-generic-password -s "onlyroute:$id" >/dev/null 2>&1; do n=$((n + 1)); done
      ;;
    secret-tool)
      secret-tool clear service onlyroute id "$id" >/dev/null 2>&1 || true
      ;;
  esac
  return 0
}

vault_set() {
  local id=$1 user=$2 pass=$3
  vault_delete "$id" # an old item with another user would linger otherwise
  case "$VAULT" in
    keychain)
      security add-generic-password -U -s "onlyroute:$id" -a "$user" -w "$pass" ||
        die "$(t "Não consegui gravar no Keychain." "Could not save to the Keychain.")"
      ;;
    secret-tool)
      printf '%s' "$pass" | secret-tool store --label="OnlyRoute $id" service onlyroute id "$id" user "$user" ||
        die "$(t "Não consegui gravar com o secret-tool (o chaveiro está desbloqueado? há sessão gráfica/D-Bus?)." "Could not save with secret-tool (is the keyring unlocked? is there a graphical/D-Bus session?).")"
      ;;
  esac
}

# VPN user and password: keychain first, then onlyroute.env. Sets L_USER, L_PASS, L_SOURCE.
get_login() {
  local i=$1 prefix
  prefix=$(cred_prefix "$i")
  vault_get "${V_ID[i]}"
  L_USER=$C_USER L_PASS=$C_PASS
  [ -n "$L_USER" ] || L_USER=$(env_get "${prefix}_USER")
  [ -n "$L_PASS" ] || L_PASS=$(env_get "${prefix}_PASSWORD")
  if [ -n "$C_FOUND" ]; then L_SOURCE=$(t cofre vault)
  elif [ -n "$L_USER" ]; then L_SOURCE=onlyroute.env
  else L_SOURCE=$(t nenhum none)
  fi
}

# --- Docker ---
docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# Opens Docker Desktop (or starts the Docker service) without waiting.
start_docker() {
  if [ "$OS" = Darwin ]; then
    open -a Docker >/dev/null 2>&1
  else
    systemctl --user start docker-desktop >/dev/null 2>&1 || sudo systemctl start docker
  fi
}

# Never assumes Docker is already running: opens it and waits until it answers.
check_docker() {
  [ "$OS" = Darwin ] && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ] &&
    ! command -v docker >/dev/null 2>&1 && PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
  command -v docker >/dev/null 2>&1 || die "$(t "O Docker não está instalado. Instale o Docker Desktop (https://www.docker.com/products/docker-desktop/) ou o Docker Engine no Linux, abra uma vez e rode de novo." "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Docker Engine on Linux, open it once and run again.")"
  local err i
  err=$(docker info 2>&1 >/dev/null) && return 0
  case "$err" in
    *ermission\ denied*)
      die "$(t "Sem permissão para usar o Docker. Adicione seu usuário ao grupo docker:
  sudo usermod -aG docker \$USER
e depois saia e entre de novo na sessão (ou rode: newgrp docker)." "No permission to use Docker. Add your user to the docker group:
  sudo usermod -aG docker \$USER
then log out and back in (or run: newgrp docker).")" ;;
  esac
  echo "$(t 'O Docker não está aberto. Abrindo...' 'Docker is not running. Opening it...')"
  start_docker || echo "$(t 'Não consegui abrir sozinho: abra o Docker.' 'Could not open it automatically: please open Docker.')"
  echo "$(t 'Esperando o Docker ficar pronto (pode levar 1 minuto; Ctrl+C cancela)...' 'Waiting for Docker to be ready (may take a minute; Ctrl+C cancels)...')"
  echo "$(t 'Se o Docker pedir para aceitar os termos ou fazer login, aceite (o login pode pular).' 'If Docker asks you to accept the terms or sign in, accept (you can skip the sign-in).')"
  i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 150 ] || die "$(t 'O Docker não ficou pronto em 5 minutos. Abra o Docker, espere ele terminar de iniciar e rode de novo.' 'Docker was not ready after 5 minutes. Open Docker, wait for it to finish starting and run again.')"
    sleep 2
  done
  echo "$(t 'Docker pronto.' 'Docker is ready.')"
}

# pppd needs the PPP line discipline in Docker's Linux kernel. Newer kernels
# ship it as a module a container can't load ("Couldn't set tty to PPP
# discipline"), so it's loaded from a short-lived privileged container. It
# lasts until Docker restarts.
has_ppp_ldisc() { docker run --rm --entrypoint cat "$IMAGE" /proc/tty/ldiscs 2>/dev/null | grep -q '^ppp[[:space:]]'; }
# If it still isn't on, the VPN container gets SYS_ADMIN instead: on other
# Docker/WSL kernels that is what fixes the same error.
CAP_SYS_ADMIN=()
ensure_ppp_ldisc() {
  CAP_SYS_ADMIN=()
  has_ppp_ldisc && return 0
  docker run --rm --privileged --pid=host --entrypoint nsenter "$IMAGE" -t 1 -m modprobe ppp_async >/dev/null 2>&1 || true
  has_ppp_ldisc || CAP_SYS_ADMIN=(--cap-add SYS_ADMIN)
}

build_image() { docker build -q -t "$IMAGE" "$SCRIPT_DIR" >/dev/null || die "$(t 'Falha ao montar a imagem Docker.' 'Failed to build the Docker image.')"; }
is_running() { [ -n "$(docker ps -q -f "name=^${NAME}\$" 2>/dev/null)" ]; }
# Removes the container (running or stopped) without complaining if it does not exist.
remove_container() { docker rm -f "$NAME" "$LEGACY_NAME" >/dev/null 2>&1 || true; }

# Reads the VPN log from inside the container (works even when it is stopped).
read_vpn_log() {
  local tmp
  tmp=$(mktemp)
  docker cp "$NAME:/run/vpn.log" "$tmp" >/dev/null 2>&1 || true
  cat "$tmp" 2>/dev/null || true
  rm -f "$tmp"
}

is_connected() { is_running && case "$(read_vpn_log)" in *'Tunnel is up'*) true ;; *) false ;; esac; }
current_vpn() { docker inspect -f "{{ index .Config.Labels \"$LABEL\" }}" "$NAME" 2>/dev/null || true; }

# Shows the last VPN messages and removes the container.
failure_and_cleanup() {
  local log
  echo "$1"
  log=$(read_vpn_log)
  printf '%s\n' "$log" | grep -v '^[[:space:]]*$' | tail -n 6 || true
  case "$log" in
    *'pppd: An immediately fatal error'*)
      echo
      echo "$(t 'O login funcionou, mas o Docker não deixou montar o túnel (suporte a PPP).' 'The login worked, but Docker did not allow the tunnel to be set up (PPP support).')"
      echo "$(t 'Reinicie o Docker e tente de novo.' 'Restart Docker and try again.')" ;;
  esac
  remove_container
}

# Goes straight to the VPN input inside the container; nothing is written to disk.
send_vpn_input() { printf '%s\n' "$1" | docker exec -i "$NAME" sh -c 'cat > /run/vpn-input'; }

# --- hosts file ---
expected_hosts_lines() {
  local i
  for ((i = 0; i < ${#HOST_NAMES[@]}; i++)); do
    printf '%s %s %s\n' "${HOST_IPS[i]}" "${HOST_NAMES[i]}" "$HOSTS_MARKER"
  done
}

hosts_up_to_date() {
  local current expected
  current=$(grep -E "$OUR_LINE" "$HOSTS_FILE" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
  expected=$(expected_hosts_lines)
  [ "$current" = "$expected" ]
}

flush_dns() {
  if [ "$OS" = Darwin ]; then
    dscacheutil -flushcache >/dev/null 2>&1 || true
    killall -HUP mDNSResponder >/dev/null 2>&1 || true
  elif command -v resolvectl >/dev/null 2>&1; then
    resolvectl flush-caches >/dev/null 2>&1 || true
  fi
  return 0
}

# Rewrites the file in place (cat >, not mv) to keep its owner, mode and inode.
write_hosts() { # <with entries: 1|0>
  local tmp
  tmp=$(mktemp)
  grep -Ev "$OUR_LINE" "$HOSTS_FILE" >"$tmp" 2>/dev/null || true
  [ "$1" = 1 ] && expected_hosts_lines >>"$tmp"
  cat "$tmp" >"$HOSTS_FILE"
  rm -f "$tmp"
  flush_dns
}

can_write_hosts() { is_root || [ -w "$HOSTS_FILE" ]; }

# Re-runs this script as root for one operation (sudo drops the environment, so
# pass the paths explicitly).
sudo_self() {
  sudo env "ONLYROUTE_CONFIG=$CONFIG_FILE" "ONLYROUTE_HOSTS=$HOSTS_FILE" "ONLYROUTE_LANG=$OR_LANG" bash "$SCRIPT_PATH" "$@"
}

# macOS only has 127.0.0.1 on lo0: every other 127.0.0.N needs an alias
# (they vanish on reboot, so this is checked before each "up").
missing_loopback_aliases() {
  [ "$OS" = Darwin ] || return 0
  local n lo
  lo=$(ifconfig lo0 2>/dev/null || true)
  for ((n = 2; n <= ${#HOST_NAMES[@]}; n++)); do
    case "$lo" in *"inet 127.0.0.$n "*) ;; *) echo "127.0.0.$n" ;; esac
  done
}

ensure_loopback_aliases() {
  local missing ip
  missing=$(missing_loopback_aliases)
  [ -n "$missing" ] || return 0
  is_root || echo "$(t 'Criando endereços locais (127.0.0.x) no lo0: o sudo pode pedir sua senha...' 'Creating local addresses (127.0.0.x) on lo0: sudo may ask for your password...')"
  for ip in $missing; do
    if is_root; then ifconfig lo0 alias "$ip" up; else sudo ifconfig lo0 alias "$ip" up; fi ||
      echo "$(t "Não consegui criar o alias $ip no lo0." "Could not create the alias $ip on lo0.")"
  done
  return 0
}

remove_loopback_aliases() {
  [ "$OS" = Darwin ] || return 0
  local n lo
  lo=$(ifconfig lo0 2>/dev/null || true)
  for ((n = 2; n <= ${#HOST_NAMES[@]}; n++)); do
    case "$lo" in *"inet 127.0.0.$n "*) ifconfig lo0 -alias "127.0.0.$n" >/dev/null 2>&1 || true ;; esac
  done
  return 0
}

# Makes the hosts file match vpns.json; asks for the sudo password if needed.
update_hosts() {
  if hosts_up_to_date; then return 0; fi
  if can_write_hosts; then write_hosts 1; return 0; fi
  echo "$(t 'Atualizando o arquivo hosts: o sudo vai pedir sua senha...' 'Updating the hosts file: sudo will ask for your password...')"
  if ! sudo_self hosts-setup >/dev/null; then
    echo "$(t 'Permissão negada: o hosts não foi atualizado. Rode depois: sudo ./onlyroute.sh hosts-setup' 'Permission denied: the hosts file was not updated. Later, run: sudo ./onlyroute.sh hosts-setup')"
    return 1
  fi
  if hosts_up_to_date; then echo "$(t 'Arquivo hosts atualizado.' 'Hosts file updated.')"; return 0; fi
  echo "$(t 'Não consegui atualizar o hosts. Rode: sudo ./onlyroute.sh hosts-setup' 'Could not update the hosts file. Run: sudo ./onlyroute.sh hosts-setup')"
  return 1
}

# --- VPN selection: by id or 1-based number, else a numbered menu. Sets SEL. ---
select_vpn() {
  local want=$1 i n=${#V_ID[@]} ans lw
  SEL=
  if [ -n "$want" ]; then
    lw=$(lower "$want")
    for ((i = 0; i < n; i++)); do
      if [ "$(lower "${V_ID[i]}")" = "$lw" ]; then SEL=$i; return 0; fi
    done
    if [[ $want =~ ^[0-9]+$ ]] && [ "$((10#$want))" -ge 1 ] && [ "$((10#$want))" -le "$n" ]; then
      SEL=$((10#$want - 1))
      return 0
    fi
    die "$(t "VPN '$want' não está no vpns.json. Use: ./onlyroute.sh list" "VPN '$want' is not in vpns.json. Use: ./onlyroute.sh list")"
  fi
  if [ "$n" -eq 1 ]; then SEL=0; return 0; fi
  echo "$(t 'Qual VPN?' 'Which VPN?')" >&2
  for ((i = 0; i < n; i++)); do echo "  $((i + 1))) ${V_NAME[i]}  [${V_GW[i]}]" >&2; done
  while true; do
    read -r -p "$(t 'Número: ' 'Number: ')" ans || die "$(t 'Cancelado.' 'Cancelled.')"
    if [[ $ans =~ ^[0-9]+$ ]] && [ "$((10#$ans))" -ge 1 ] && [ "$((10#$ans))" -le "$n" ]; then
      SEL=$((10#$ans - 1))
      return 0
    fi
    echo "$(t 'Número inválido.' 'Invalid number.')" >&2
  done
}

# If the VPN is on, forwards only change by reconnecting.
offer_reconnect() {
  is_connected || return 0
  local current answer
  current=$(current_vpn)
  read -r -p "$(t "A VPN ($current) está ligada. Reconectar agora para aplicar? (s/N) " "The VPN ($current) is on. Reconnect now to apply? (y/N) ")" answer || answer=
  case "$answer" in
    [sSyY]*) remove_container; bash "$SCRIPT_PATH" up "$current" ;;
    *) echo "$(t "Vale na próxima vez que ligar (ou rode 'down' e 'up')." "It takes effect the next time you connect (or run 'down' and 'up').")" ;;
  esac
}

# Linux: the container needs the host's /dev/ppp.
ensure_ppp() {
  [ "$OS" = Linux ] || return 0
  [ -e /dev/ppp ] && return 0
  echo "$(t 'Carregando o módulo ppp do kernel (sudo modprobe ppp_generic)...' 'Loading the ppp kernel module (sudo modprobe ppp_generic)...')"
  sudo modprobe ppp_generic >/dev/null 2>&1 || true
  [ -e /dev/ppp ] || die "$(t "Não existe /dev/ppp e não consegui carregar o módulo ppp_generic.
Instale o suporte a PPP do kernel (ex.: pacote ppp / linux-modules-extra) e rode: sudo modprobe ppp_generic" "/dev/ppp does not exist and I could not load the ppp_generic module.
Install kernel PPP support (e.g. package ppp / linux-modules-extra) and run: sudo modprobe ppp_generic")"
}

# ============================== commands ==============================
load_config
compute_host_ips

case "$CMD" in
  build)
    check_docker
    build_image
    echo "$(t 'Imagem pronta.' 'Image ready.')"
    ;;

  list)
    for ((i = 0; i < ${#V_ID[@]}; i++)); do
      get_login "$i"
      if [ -n "$L_USER" ]; then who="$L_USER ($L_SOURCE)"; else who=$(t "sem login: rode ./onlyroute.sh login ${V_ID[i]}" "no login: run ./onlyroute.sh login ${V_ID[i]}"); fi
      echo "$((i + 1))) ${V_ID[i]} - ${V_NAME[i]}  [${V_GW[i]}:${V_PORT[i]}]  $(t usuário user): $who"
      [ -n "${V_FWD[i]}" ] || echo "     $(t '(nenhum site repassado)' '(no forwarded sites)')"
      for f in ${V_FWD[i]}; do
        parse_forward "$f"
        echo "     $F_HOST:$F_PORT -> $(host_ip "$(lower "$F_HOST")")"
      done
    done
    ;;

  login)
    [ -n "$VAULT" ] || die "$(t "Não há cofre disponível: no Linux instale o secret-tool (pacote libsecret-tools), no macOS use o Keychain.
Alternativa: onlyroute.env (veja onlyroute.env.example)." "No vault available: on Linux install secret-tool (package libsecret-tools), on macOS use the Keychain.
Alternative: onlyroute.env (see onlyroute.env.example).")"
    select_vpn "$VPN_ARG"
    id=${V_ID[SEL]}
    vault_get "$id"
    prompt="$(t 'Usuário' 'User') (${V_NAME[SEL]})"
    [ -n "$C_USER" ] && prompt="$prompt [$(t "Enter mantém $C_USER" "Enter keeps $C_USER")]"
    read -r -p "$prompt: " user || user=
    [ -n "$user" ] || user=$C_USER
    [ -n "$user" ] || die "$(t 'Usuário vazio.' 'Empty user.')"
    read -rs -p "$(t 'Senha (Enter = não salvar; o up pergunta): ' 'Password (Enter = do not save; up will ask): ')" pass || pass=
    echo >&2
    vault_set "$id" "$user" "$pass"
    if [ -n "$pass" ]; then echo "$(t "Usuário e senha de $id salvos no $(vault_name)." "User and password for $id saved to the $(vault_name).")"
    else echo "$(t "Usuário de $id salvo no $(vault_name); a senha será pedida no up." "User for $id saved to the $(vault_name); the password will be asked on up.")"; fi
    ;;

  logout)
    select_vpn "$VPN_ARG"
    vault_delete "${V_ID[SEL]}"
    echo "$(t "Usuário e senha de ${V_ID[SEL]} apagados do $(vault_name)." "User and password for ${V_ID[SEL]} deleted from the $(vault_name).")"
    ;;

  up)
    check_docker
    if is_connected; then
      echo "$(t "Já existe uma VPN ligada ($(current_vpn)). Rode 'down' antes de trocar." "A VPN is already on ($(current_vpn)). Run 'down' before switching.")"
      exit 0
    fi
    remove_container # leftover from a previous attempt that did not finish
    if ! hosts_up_to_date; then
      echo "$(t 'O arquivo hosts não está igual ao vpns.json.' 'The hosts file does not match vpns.json.')"
      update_hosts || true
    fi
    ensure_loopback_aliases
    ensure_ppp
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      # Reuse the image with the old name, if any; otherwise build it.
      if docker image inspect "$LEGACY_NAME" >/dev/null 2>&1; then
        docker tag "$LEGACY_NAME" "$IMAGE" >/dev/null
      else
        echo "$(t 'Montando a imagem (só na primeira vez)...' 'Building the image (first time only)...')"
        build_image
      fi
    fi
    ensure_ppp_ldisc

    select_vpn "$VPN_ARG"
    v=$SEL
    get_login "$v"
    user=$L_USER
    [ -n "$user" ] || read -r -p "$(t 'Usuário' 'User') (${V_NAME[v]}): " user || true
    [ -n "$user" ] || die "$(t 'Usuário vazio.' 'Empty user.')"
    password=$L_PASS

    # The gateway sometimes comes as a full address ("https://vpn.x.com:10443/remote/login").
    # openfortivpn wants only the host, with the port apart; a port in the address wins.
    gw_host=$(printf '%s' "${V_GW[v]}" | tr -d '[:space:]' | sed -E 's#^[a-zA-Z]+://##; s#[/?#].*$##')
    gw_port=${V_PORT[v]}
    case $gw_port in '' | *[!0-9]*) gw_port=10443 ;; esac
    if [[ $gw_host =~ ^([^:]*):([0-9]{1,5})$ ]]; then
      gw_host=${BASH_REMATCH[1]} gw_port=${BASH_REMATCH[2]}
    fi

    # Ports: each site becomes 127.0.0.x:port on this computer -> container port.
    port_args=()
    forwards=()
    internal=20000
    for f in ${V_FWD[v]}; do
      parse_forward "$f"
      port_args+=(-p "$(host_ip "$(lower "$F_HOST")"):$F_PORT:$internal")
      forwards+=("$internal=$F_HOST:$F_PORT")
      internal=$((internal + 1))
    done
    fwd_env="${forwards[*]+${forwards[*]}}"

    # No --rm: if the connection fails, the error messages can still be read.
    if ! docker run -d --name "$NAME" --label "$LABEL=${V_ID[v]}" \
      --cap-add NET_ADMIN ${CAP_SYS_ADMIN[@]+"${CAP_SYS_ADMIN[@]}"} --device /dev/ppp ${port_args[@]+"${port_args[@]}"} \
      -e "VPN_HOST=$gw_host" -e "VPN_PORT=$gw_port" -e "VPN_USER=$user" \
      -e "FORWARDS=$fwd_env" -e "TRUSTED_CERT=${V_CERT[v]}" \
      -e DETACHED=1 "$IMAGE" >/dev/null; then
      remove_container
      die "$(t 'Não consegui iniciar o container da VPN (porta ocupada?).' 'Could not start the VPN container (port in use?).')"
    fi

    echo "$(t "Conectando em ${V_NAME[v]} ($gw_host:$gw_port) como $user" "Connecting to ${V_NAME[v]} ($gw_host:$gw_port) as $user")"
    if [ -z "$password" ]; then
      read -rs -p "$(t 'Senha da VPN: ' 'VPN password: ')" password || password=
      echo >&2
    fi
    send_vpn_input "$password"

    otp_sent=
    deadline=$((SECONDS + 120))
    while true; do
      sleep 0.7
      if ! is_running; then failure_and_cleanup "$(t 'A VPN não conectou. Últimas mensagens:' 'The VPN did not connect. Last messages:')"; exit 1; fi
      log=$(read_vpn_log)
      case "$log" in
        *'Tunnel is up'*)
          echo "$(t 'VPN ligada. Pode fechar este terminal.' 'VPN on. You can close this terminal.')"
          for f in ${forwards[@]+"${forwards[@]}"}; do echo "  $(t 'pela VPN' 'via VPN'): ${f#*=}"; done
          exit 0
          ;;
      esac
      if [ -z "$otp_sent" ]; then
        case "$log" in
          *'Two-factor authentication token'*)
            read -r -p "$(t 'Código de verificação: ' 'Verification code: ')" otp || otp=
            send_vpn_input "$otp"
            otp_sent=1
            deadline=$((SECONDS + 60))
            ;;
        esac
      fi
      if [ "$SECONDS" -gt "$deadline" ]; then
        failure_and_cleanup "$(t 'Tempo esgotado esperando a VPN conectar. Últimas mensagens:' 'Timed out waiting for the VPN to connect. Last messages:')"
        exit 1
      fi
    done
    ;;

  down)
    docker_up || { echo "$(t 'VPN desligada (o Docker não está aberto).' 'VPN off (Docker is not running).')"; exit 0; }
    remove_container
    echo "$(t 'VPN desligada.' 'VPN off.')"
    ;;

  status)
    docker_up || { echo "$(t 'VPN desligada (o Docker não está aberto).' 'VPN off (Docker is not running).')"; exit 0; }
    if is_running; then
      current=$(current_vpn)
      ppp=$(docker exec "$NAME" sh -c 'ip -4 addr show ppp0 2>/dev/null | grep inet' 2>/dev/null || true)
      ppp=$(printf '%s' "$ppp" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
      if [ -n "$ppp" ]; then echo "$(t "VPN ligada ($current). $ppp" "VPN on ($current). $ppp")"
      else echo "$(t "Container rodando ($current), mas a VPN ainda não conectou." "Container running ($current), but the VPN has not connected yet.")"; fi
    else
      echo "$(t 'VPN desligada.' 'VPN off.')"
    fi
    ;;

  add)
    [ -n "$VPN_ARG" ] || die "$(t 'Informe o site, ex: ./onlyroute.sh add jira.empresa.com.br [vpn]' 'Give the site, e.g.: ./onlyroute.sh add jira.company.com [vpn]')"
    site=$(normalize_site "$VPN_ARG")
    [ -n "$site" ] || die "$(t "Site inválido: $VPN_ARG" "Invalid site: $VPN_ARG")"
    select_vpn "$ARG2"
    v=$SEL
    found=
    for f in ${V_FWD[v]}; do
      [ "$(normalize_site "$f")" = "$site" ] && found=1
    done
    if [ -n "$found" ]; then
      echo "$(t "$site já passa pela VPN ${V_ID[v]}." "$site already goes through the VPN ${V_ID[v]}.")"
    else
      config_set_forward "$v" "${V_FWD[v]:+${V_FWD[v]} }$site"
      echo "$(t "Adicionado: $site passa pela VPN ${V_ID[v]}." "Added: $site goes through the VPN ${V_ID[v]}.")"
      load_config
      compute_host_ips
    fi
    if update_hosts; then
      [ "$OS" = Darwin ] && ensure_loopback_aliases
      if command -v docker >/dev/null 2>&1; then offer_reconnect; fi
    fi
    ;;

  remove)
    [ -n "$VPN_ARG" ] || die "$(t 'Informe o site, ex: ./onlyroute.sh remove jira.empresa.com.br [vpn]' 'Give the site, e.g.: ./onlyroute.sh remove jira.company.com [vpn]')"
    site=$(normalize_site "$VPN_ARG")
    targets=()
    if [ -n "$ARG2" ]; then
      select_vpn "$ARG2"
      targets=("$SEL")
    else
      for ((i = 0; i < ${#V_ID[@]}; i++)); do targets+=("$i"); done
    fi
    changed=()
    for v in "${targets[@]}"; do
      after=
      removed=
      for f in ${V_FWD[v]}; do
        if [ "$(normalize_site "$f")" = "$site" ]; then removed=1; else after="${after:+$after }$f"; fi
      done
      if [ -n "$removed" ]; then
        config_set_forward "$v" "$after"
        changed+=("${V_ID[v]}")
      fi
    done
    if [ "${#changed[@]}" -eq 0 ]; then echo "$(t "$site não está em nenhum forward." "$site is not in any forward.")"; exit 0; fi
    old_ifs=$IFS
    IFS=,
    changed_list="${changed[*]}"
    IFS=$old_ifs
    echo "$(t "Removido: $site não passa mais pela VPN (${changed_list//,/, })." "Removed: $site no longer goes through the VPN (${changed_list//,/, }).")"
    load_config
    compute_host_ips
    if update_hosts; then
      if command -v docker >/dev/null 2>&1; then offer_reconnect; fi
    fi
    ;;

  hosts-setup)
    if ! is_root && { ! can_write_hosts || [ -n "$(missing_loopback_aliases)" ]; }; then
      sudo_self hosts-setup
      exit $?
    fi
    write_hosts 1
    ensure_loopback_aliases
    echo "$(t 'Pronto. Estes sites passam pela VPN (quando ela estiver ligada):' 'Done. These sites go through the VPN (when it is on):')"
    for ((i = 0; i < ${#HOST_NAMES[@]}; i++)); do echo "  ${HOST_NAMES[i]} -> ${HOST_IPS[i]}"; done
    echo "$(t 'Feche e abra de novo os programas que já estavam abertos.' 'Close and reopen any programs that were already open.')"
    ;;

  hosts-remove)
    if ! can_write_hosts; then
      sudo_self hosts-remove
      exit $?
    fi
    write_hosts 0
    echo "$(t 'Removido: os sites voltam a sair pela rede normal.' 'Removed: the sites go through the normal network again.')"
    ;;

  _uninstall-system)
    # Internal: the root part of "uninstall" (hosts file and lo0 aliases).
    is_root || can_write_hosts || die "$(t 'Precisa de root.' 'Needs root.')"
    write_hosts 0
    is_root && remove_loopback_aliases
    ;;

  uninstall)
    # Undoes everything OnlyRoute changes on this computer. The files in this folder stay.
    if is_root && [ -n "${SUDO_USER:-}" ]; then
      echo "$(t "Aviso: rodando como root; os logins no cofre de $SUDO_USER podem não ser apagados (rode sem sudo)." "Warning: running as root; the logins in $SUDO_USER's vault may not be deleted (run without sudo).")"
    fi
    if command -v docker >/dev/null 2>&1; then
      remove_container
      echo "$(t 'VPN desligada e container removido.' 'VPN off and container removed.')"
    fi
    if is_root || { can_write_hosts && [ "$OS" != Darwin ]; }; then
      bash "$SCRIPT_PATH" _uninstall-system
    else
      echo "$(t 'Removendo as linhas do hosts: o sudo vai pedir sua senha...' 'Removing the hosts lines: sudo will ask for your password...')"
      sudo_self _uninstall-system || die "$(t 'Não consegui mexer no hosts (sudo negado).' 'Could not change the hosts file (sudo denied).')"
    fi
    echo "$(t 'Linhas do OnlyRoute removidas do arquivo hosts.' 'OnlyRoute lines removed from the hosts file.')"
    [ "$OS" = Darwin ] && echo "$(t 'Endereços 127.0.0.x extras removidos do lo0.' 'Extra 127.0.0.x addresses removed from lo0.')"
    if command -v docker >/dev/null 2>&1; then
      docker rmi "$IMAGE" "$LEGACY_NAME" >/dev/null 2>&1 || true
      echo "$(t "Imagem Docker '$IMAGE' removida." "Docker image '$IMAGE' removed.")"
    fi
    for ((i = 0; i < ${#V_ID[@]}; i++)); do vault_delete "${V_ID[i]}"; done
    echo "$(t "Usuários e senhas apagados do $(vault_name)." "Users and passwords deleted from the $(vault_name).")"
    echo "$(t 'Pronto. Para usar de novo: login, hosts-setup (sudo) e up.' 'Done. To use it again: login, hosts-setup (sudo) and up.')"
    echo "$(t "A imagem base 'debian:trixie-slim' foi mantida; para remover: docker rmi debian:trixie-slim" "The base image 'debian:trixie-slim' was kept; to remove it: docker rmi debian:trixie-slim")"
    ;;
esac
