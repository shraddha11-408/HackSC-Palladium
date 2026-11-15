#!/usr/bin/env bash
# OPTIONAL manual/cloud-init setup on a dedicated Ubuntu 24.04 relay.
# This script installs/enables a public network service WHEN EXECUTED.
# It does not provision a host, change provider billing, or configure DNS/firewalls.
# Required: TURN_PUBLIC_IP (public IPv4 assigned directly to this server).
# Optional TLS: TURN_DOMAIN + TURN_CERT_FILE + TURN_KEY_FILE (existing valid PEMs).
# Shared secret is generated once in /etc/safesc-turn/shared-secret, never stdout.
set -euo pipefail
set +x
[[ ${EUID} -eq 0 ]] || { echo 'Run as root on the dedicated relay.' >&2; exit 1; }
: "${TURN_PUBLIC_IP:?Set the directly assigned public IPv4 address}"
export TURN_PUBLIC_IP TURN_DOMAIN="${TURN_DOMAIN:-}" TURN_CERT_FILE="${TURN_CERT_FILE:-}" TURN_KEY_FILE="${TURN_KEY_FILE:-}"
python3 - <<'PY'
import ipaddress, os, re
address = ipaddress.ip_address(os.environ['TURN_PUBLIC_IP'])
if address.version != 4 or not address.is_global:
    raise SystemExit('A directly assigned public IPv4 address is required')
domain = os.environ['TURN_DOMAIN']
if domain and not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', domain):
    raise SystemExit('Invalid TURN_DOMAIN')
if any(os.environ[k] for k in ('TURN_CERT_FILE', 'TURN_KEY_FILE')):
    if not domain or not all(os.path.isfile(os.environ[k]) for k in ('TURN_CERT_FILE', 'TURN_KEY_FILE')):
        raise SystemExit('TLS needs TURN_DOMAIN and both existing PEM paths')
PY
# Avoid exposing an unauthenticated default service during package installation.
systemctl mask coturn.service
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends coturn python3 openssl
install -d -m 0700 /etc/safesc-turn
if [[ ! -s /etc/safesc-turn/shared-secret ]]; then
  umask 077
  openssl rand -hex 32 > /etc/safesc-turn/shared-secret
fi
# Copy supplied certs to a service-readable directory. Renewals require rerunning
# this setup with renewed PEM paths; certificate issuance is deliberately external.
if [[ -n ${TURN_CERT_FILE} ]]; then
  install -d -m 0750 -o root -g turnserver /etc/safesc-turn/tls
  install -m 0640 -o root -g turnserver "$TURN_CERT_FILE" /etc/safesc-turn/tls/fullchain.pem
  install -m 0640 -o root -g turnserver "$TURN_KEY_FILE" /etc/safesc-turn/tls/privkey.pem
  chmod 0710 /etc/safesc-turn
  chgrp turnserver /etc/safesc-turn
fi
python3 - <<'PY'
import os, pathlib
ip = os.environ['TURN_PUBLIC_IP']
secret = pathlib.Path('/etc/safesc-turn/shared-secret').read_text().strip()
if len(secret) < 32 or any(c not in '0123456789abcdefABCDEF' for c in secret):
    raise SystemExit('Expected an existing strong hexadecimal relay secret')
lines = [
    '# Managed by Palladium scripts/setup_turn.sh; contains a private shared secret.',
    'listening-port=443', 'listening-ip='+ip, 'relay-ip='+ip,
    'aux-server='+ip+':3478', 'min-port=49160', 'max-port=49200',
    'realm='+ (os.environ['TURN_DOMAIN'] or 'safesc-turn'),
    'fingerprint', 'use-auth-secret', 'static-auth-secret='+secret,
    'user-quota=8', 'total-quota=32', 'max-bps=4000000', 'bps-capacity=16000000',
    'max-allocate-lifetime=3600', 'stale-nonce=600', 'no-tcp-relay',
    'no-multicast-peers', 'no-cli', 'no-dtls', 'no-tlsv1', 'no-tlsv1_1',
    'no-software-attribute', 'syslog', 'simple-log',
    # Deny relay access to local/metadata/private/reserved destinations.
    # The public relay IP must remain eligible: two isolated clients may both
    # use relay candidates on this same server. Private/loopback stays denied.
    'denied-peer-ip=0.0.0.0-0.255.255.255',
    'denied-peer-ip=10.0.0.0-10.255.255.255',
    'denied-peer-ip=100.64.0.0-100.127.255.255',
    'denied-peer-ip=127.0.0.0-127.255.255.255',
    'denied-peer-ip=169.254.0.0-169.254.255.255',
    'denied-peer-ip=172.16.0.0-172.31.255.255',
    'denied-peer-ip=192.168.0.0-192.168.255.255',
    'denied-peer-ip=224.0.0.0-255.255.255.255',
    'denied-peer-ip=::1', 'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
]
if os.environ['TURN_CERT_FILE']:
    # Coturn auto-detects TLS on its plain listener too; HTTPS-like traversal
    # needs turns:DOMAIN:443?transport=tcp and a valid domain certificate.
    lines += ['tls-listening-port=5349', 'cert=/etc/safesc-turn/tls/fullchain.pem',
              'pkey=/etc/safesc-turn/tls/privkey.pem']
else:
    lines += ['no-tls']
path = pathlib.Path('/etc/turnserver.conf')
path.write_text('\n'.join(lines)+'\n')
PY
chown root:turnserver /etc/turnserver.conf
chmod 0640 /etc/turnserver.conf
chmod 0600 /etc/safesc-turn/shared-secret
# Debian/Ubuntu run coturn as an unprivileged service user. Grant only the
# capability required to bind the TCP/UDP 443 listener.
install -d -m 0755 /etc/systemd/system/coturn.service.d
cat > /etc/systemd/system/coturn.service.d/safesc-bind.conf <<'EOF'
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
EOF
systemctl daemon-reload
systemctl unmask coturn.service
systemctl enable coturn.service
systemctl restart coturn.service
systemctl is-active --quiet coturn.service
cat <<'INFO'
Relay service started. Shared secret is in /etc/safesc-turn/shared-secret (root only).
Copy that secret privately into backend TURN_SHARED_SECRET; never into frontend env.
Allow inbound UDP 3478, TCP 443 and UDP 49160:49200 in host/provider firewalls.
TCP 443 without a supplied domain certificate is plain TURN, not TLS/HTTPS.
TLS mode uses turns:YOUR_DOMAIN:443?transport=tcp; plain turn:IP:443?transport=tcp
and turn:IP:3478?transport=udp remain available. TURN remains a measured fallback,
not a guarantee of 60 FPS or access through every institutional firewall.
INFO
