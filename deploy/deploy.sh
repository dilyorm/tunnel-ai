#!/usr/bin/env bash
# Build and ship the landing page and the relay to oraclewps.
#   deploy/deploy.sh          both
#   deploy/deploy.sh site     landing page only
#   deploy/deploy.sh relay    relay only
# First run also installs the nginx vhost and the systemd unit; TLS is a one-time
# `sudo certbot --nginx -d tunnel.dilyor.dev` on the server.
set -euo pipefail

HOST="${DEPLOY_HOST:-oraclewps}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
what="${1:-all}"

if [[ "$what" == all || "$what" == site ]]; then
  (cd "$ROOT/site" && npm run build)
  tar -C "$ROOT/site/dist" -czf - . | ssh "$HOST" '
    set -e
    sudo rm -rf /var/www/tunnel-ai.new && sudo mkdir -p /var/www/tunnel-ai.new
    sudo tar -C /var/www/tunnel-ai.new -xzf -
    sudo rm -rf /var/www/tunnel-ai.old
    [ -d /var/www/tunnel-ai ] && sudo mv /var/www/tunnel-ai /var/www/tunnel-ai.old
    sudo mv /var/www/tunnel-ai.new /var/www/tunnel-ai
    sudo rm -rf /var/www/tunnel-ai.old'
  echo "site deployed"
fi

if [[ "$what" == all || "$what" == relay ]]; then
  (cd "$ROOT/cli" && npm run build)
  # The package as npm would ship it: package.json, dist/, skills/.
  tar -C "$ROOT/cli" -czf - package.json dist skills | ssh "$HOST" '
    set -e
    sudo rm -rf /opt/tunnel-ai.new && sudo mkdir -p /opt/tunnel-ai.new
    sudo tar -C /opt/tunnel-ai.new -xzf -
    sudo rm -rf /opt/tunnel-ai.old
    [ -d /opt/tunnel-ai ] && sudo mv /opt/tunnel-ai /opt/tunnel-ai.old
    sudo mv /opt/tunnel-ai.new /opt/tunnel-ai'
  scp -q "$ROOT/deploy/tunnel-relay.service" "$HOST:/tmp/tunnel-relay.service"
  ssh "$HOST" '
    set -e
    sudo install -m 644 /tmp/tunnel-relay.service /etc/systemd/system/tunnel-relay.service
    sudo systemctl daemon-reload
    sudo systemctl enable --quiet tunnel-relay
    sudo systemctl restart tunnel-relay
    for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8797/v1/health && exit 0; sleep 0.5; done
    sudo journalctl -u tunnel-relay -n 30 --no-pager; exit 1'
  echo; echo "relay deployed"
fi

# The vhost is installed once; after that certbot owns the file.
ssh "$HOST" '[ -e /etc/nginx/sites-available/tunnel.dilyor.dev ]' || {
  scp -q "$ROOT/deploy/nginx.conf" "$HOST:/tmp/tunnel.nginx.conf"
  ssh "$HOST" '
    set -e
    sudo install -m 644 /tmp/tunnel.nginx.conf /etc/nginx/sites-available/tunnel.dilyor.dev
    sudo ln -sf /etc/nginx/sites-available/tunnel.dilyor.dev /etc/nginx/sites-enabled/tunnel.dilyor.dev
    sudo nginx -t && sudo systemctl reload nginx'
  echo "nginx vhost installed"
}
