#!/usr/bin/env bash
# Optional approved dedicated-relay bootstrap. Executes apt/service/firewall and production ACME account/certificate setup.
# The caller must authorize provider costs and ACME terms before running. No cloud API credentials belong here.
set -euo pipefail
set +x
[[ ${EUID} -eq 0 ]] || { echo 'Run as root on the approved dedicated relay.' >&2; exit 1; }
: "${TURN_PUBLIC_IP:?Set approved relay public IPv4}"
export TURN_PUBLIC_IP
python3 - <<'PYVALIDATE'
import ipaddress, os
p = ipaddress.ip_address(os.environ['TURN_PUBLIC_IP'])
if p.version != 4 or not p.is_global:
    raise SystemExit('A directly assigned public IPv4 address is required')
PYVALIDATE
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends python3-venv openssl ufw ca-certificates
cat > /etc/ssh/sshd_config.d/00-safesc-key-only.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/udp
ufw allow 49160:49200/udp
ufw --force enable
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install --disable-pip-version-check certbot==5.10.0
/opt/certbot/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --preferred-profile shortlived --standalone --ip-address "${TURN_PUBLIC_IP}"
TURN_PUBLIC_IP="${TURN_PUBLIC_IP}" TURN_DOMAIN="${TURN_PUBLIC_IP}" TURN_CERT_FILE=/etc/letsencrypt/live/${TURN_PUBLIC_IP}/fullchain.pem TURN_KEY_FILE=/etc/letsencrypt/live/${TURN_PUBLIC_IP}/privkey.pem bash "$(dirname "$0")/setup_turn.sh"
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/safesc-turn <<EOF
#!/usr/bin/env bash
set -euo pipefail
[[ \${RENEWED_LINEAGE:-} == /etc/letsencrypt/live/${TURN_PUBLIC_IP} ]] || exit 0
install -m 0640 -o root -g turnserver "\$RENEWED_LINEAGE/fullchain.pem" /etc/safesc-turn/tls/fullchain.pem
install -m 0640 -o root -g turnserver "\$RENEWED_LINEAGE/privkey.pem" /etc/safesc-turn/tls/privkey.pem
systemctl restart coturn.service
EOF
chmod 0750 /etc/letsencrypt/renewal-hooks/deploy/safesc-turn
cat > /etc/systemd/system/safesc-certbot-renew.service <<'EOF'
[Unit]
Description=Renew Palladium TURN short-lived IP certificate
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet
EOF
cat > /etc/systemd/system/safesc-certbot-renew.timer <<'EOF'
[Unit]
Description=Check Palladium TURN certificate twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1800
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now safesc-certbot-renew.timer
systemctl is-active coturn.service safesc-certbot-renew.timer
openssl x509 -in /etc/safesc-turn/tls/fullchain.pem -noout -issuer -dates -ext subjectAltName
ss -lntup | awk 'NR==1 || /:443 |:3478 /'
