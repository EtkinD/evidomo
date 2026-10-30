#!/usr/bin/env bash
# Provision a fresh Ubuntu LTS (22.04 or 24.04) VPS for Evidomo. Run once as root, over SSH, by
# the founder; safe to run again (every step checks before it changes anything).
#
#   sudo bash provision.sh --ssh-key-file /root/deploy_key.pub [--swap-gb 2] [--no-auto-reboot]
#   sudo DEPLOY_SSH_PUBKEY='ssh-ed25519 AAAA... you@laptop' bash provision.sh
#
# What it sets up:
#   - unattended security updates (reboots at 03:30 UTC when a kernel update needs it)
#   - Docker Engine + compose plugin from Docker's apt repository (key fingerprint verified),
#     with rotated container logs
#   - user `deploy` (docker group, sudo without password, SSH key only, no password)
#   - sshd: root login off, passwords off (drop-in /etc/ssh/sshd_config.d/00-evidomo.conf)
#   - ufw: deny incoming except 22 (rate limited), 80, 443 (tcp, and udp for HTTP/3)
#   - fail2ban for sshd
#   - a swap file when the machine has less than 4 GiB of RAM
#   - NTP time sync
#
# Docker publishes ports through its own iptables rules, which ufw does not filter. The stack is
# safe only because infra/compose.yaml publishes nothing except caddy's 80/443; infra/deploy.sh
# checks that after every deploy.
#
# Ubuntu (GNU userland) only. Nothing here is meant for macOS.
set -euo pipefail

DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
DEPLOY_USER="deploy"
SWAP_GB=2
AUTO_REBOOT=true
KEY_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key-file) KEY_FILE="${2:?--ssh-key-file needs a path}"; shift 2 ;;
    --swap-gb) SWAP_GB="${2:?--swap-gb needs a number}"; shift 2 ;;
    --no-auto-reboot) AUTO_REBOOT=false; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash provision.sh ...)"
[ -r /etc/os-release ] || die "cannot read /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu only (found ${ID:-unknown})"
case "${VERSION_ID:-}" in
  22.04 | 24.04) ;;
  *) die "Ubuntu 22.04 or 24.04 LTS expected (found ${VERSION_ID:-unknown})" ;;
esac

# The deploy user's public key: a file or the environment, validated before anything changes, so a
# typo cannot lock everyone out once root login is disabled.
pubkey="${DEPLOY_SSH_PUBKEY:-}"
[ -z "$KEY_FILE" ] || pubkey="$(head -n 1 "$KEY_FILE")"
[ -n "$pubkey" ] || die "no public key: pass --ssh-key-file <file> or set DEPLOY_SSH_PUBKEY"
key_check="$(mktemp)"
trap 'rm -f "$key_check"' EXIT
printf '%s\n' "$pubkey" > "$key_check"
ssh-keygen -l -f "$key_check" > /dev/null 2>&1 || die "that is not a valid SSH public key (it must be the .pub file, one line)"
case "$pubkey" in
  ssh-ed25519\ * | ssh-rsa\ * | ecdsa-sha2-*\ * | sk-ssh-ed25519@openssh.com\ * | sk-ecdsa-sha2-*\ *) ;;
  *) die "unsupported key type" ;;
esac

export DEBIAN_FRONTEND=noninteractive

log "Packages and unattended security updates"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg ufw fail2ban unattended-upgrades apt-listchanges git openssh-server > /dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52evidomo-unattended << CONF
// Security updates only (the stock origin list); reboot only when a package needs it.
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "$AUTO_REBOOT";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
CONF

log "Time sync"
timedatectl set-ntp true || echo "WARNING: could not enable NTP via timedatectl" >&2

log "Docker Engine from Docker's repository"
install -m 0755 -d /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/docker.asc ]; then
  tmp_key="$(mktemp)"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$tmp_key"
  # Pin: the key must contain Docker's published fingerprint, or nothing is installed.
  if ! gpg --show-keys --with-colons "$tmp_key" | awk -F: '$1 == "fpr" { print $10 }' | grep -qx "$DOCKER_KEY_FINGERPRINT"; then
    rm -f "$tmp_key"
    die "Docker's signing key does not have the expected fingerprint $DOCKER_KEY_FINGERPRINT"
  fi
  install -m 0644 "$tmp_key" /etc/apt/keyrings/docker.asc
  rm -f "$tmp_key"
fi
arch="$(dpkg --print-architecture)"
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null

# Rotated logs: an unrotated json-file log fills the disk of a small VPS in weeks.
want_daemon_json='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}'
if [ ! -f /etc/docker/daemon.json ] || [ "$(cat /etc/docker/daemon.json)" != "$want_daemon_json" ]; then
  printf '%s\n' "$want_daemon_json" > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker > /dev/null 2>&1

log "User $DEPLOY_USER"
if ! id "$DEPLOY_USER" > /dev/null 2>&1; then
  # No password at all: login is by key only.
  adduser --disabled-password --gecos "" "$DEPLOY_USER" > /dev/null
fi
usermod -aG docker "$DEPLOY_USER"
home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
grep -qxF "$pubkey" "$home/.ssh/authorized_keys" || printf '%s\n' "$pubkey" >> "$home/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
chmod 0600 "$home/.ssh/authorized_keys"
# Members of the docker group are root-equivalent already, so passwordless sudo adds little and
# avoids a lockout (the account has no password for sudo to ask for).
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$DEPLOY_USER"
chmod 0440 "/etc/sudoers.d/90-$DEPLOY_USER"
visudo -cf "/etc/sudoers.d/90-$DEPLOY_USER" > /dev/null || { rm -f "/etc/sudoers.d/90-$DEPLOY_USER"; die "sudoers check failed"; }

log "SSH hardening"
# 00- sorts before cloud-init's 50-cloud-init.conf, and sshd uses the first value it reads.
cat > /etc/ssh/sshd_config.d/00-evidomo.conf << CONF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $DEPLOY_USER
MaxAuthTries 4
CONF
sshd -t || { rm -f /etc/ssh/sshd_config.d/00-evidomo.conf; die "sshd config test failed; hardening removed"; }
effective="$(sshd -T)"
for expect in "permitrootlogin no" "passwordauthentication no"; do
  echo "$effective" | grep -qix "$expect" || die "sshd does not report '$expect'; another file overrides the drop-in"
done
systemctl reload ssh 2> /dev/null || systemctl reload sshd

log "Firewall (ufw)"
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw limit 22/tcp > /dev/null
ufw allow 80/tcp > /dev/null
ufw allow 443/tcp > /dev/null
ufw allow 443/udp > /dev/null
ufw --force enable > /dev/null

log "fail2ban"
cat > /etc/fail2ban/jail.d/evidomo-sshd.local << 'CONF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
CONF
systemctl enable --now fail2ban > /dev/null 2>&1
systemctl restart fail2ban

log "Swap"
mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
if [ "$mem_kb" -lt 4000000 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024))
    chmod 600 /swapfile
    mkswap /swapfile > /dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "vm.swappiness=10" > /etc/sysctl.d/99-evidomo-swap.conf
  sysctl -q -p /etc/sysctl.d/99-evidomo-swap.conf
  log "Created ${SWAP_GB} GiB swap"
else
  log "Swap not needed or already present"
fi

log "Checks"
fail=0
check() { # <description> <command...>
  local desc="$1"; shift
  if "$@" > /dev/null 2>&1; then echo "ok:   $desc"; else echo "FAIL: $desc"; fail=1; fi
}
check "docker engine runs" docker info
check "docker compose plugin" docker compose version
check "$DEPLOY_USER is in the docker group" bash -c "id -nG $DEPLOY_USER | tr ' ' '\n' | grep -qx docker"
check "ufw is active" bash -c "ufw status | grep -q 'Status: active'"
check "fail2ban sshd jail is running" fail2ban-client status sshd
check "NTP synchronised (can take a minute after the first start)" bash -c "[ \"\$(timedatectl show -p NTPSynchronized --value)\" = yes ]"
check "sshd: root login disabled" bash -c "sshd -T | grep -qix 'permitrootlogin no'"
check "sshd: password auth disabled" bash -c "sshd -T | grep -qix 'passwordauthentication no'"
check "unattended-upgrades enabled" bash -c "systemctl is-enabled unattended-upgrades"

cat << MSG

Provisioning done.
NEXT, before you close this session: open a SECOND terminal and check that this works:
    ssh $DEPLOY_USER@<server-ip>
Only when that login works, log out of root. (Lish console in the Linode manager is the way back in.)
Then continue with infra/README.md, step 'Deploy'.
MSG
exit "$fail"
