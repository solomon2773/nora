#!/usr/bin/env bash
# infra/setup-tls.sh - Obtain and install Let's Encrypt TLS certs for Nora.
#
# Prerequisites:
# - Domain DNS points to this host
# - Port 80 is reachable from the internet
# - Docker is installed and running
#
# Usage:
#   DOMAIN=app.example.com EMAIL=admin@example.com ./setup-tls.sh

set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN env var (for example app.example.com)}"
EMAIL="${EMAIL:?Set EMAIL env var for Lets Encrypt notifications}"
WEBROOT="/var/www/certbot"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TLS_TEMPLATE="${SCRIPT_DIR}/nginx_tls.conf"
PUBLIC_NGINX_CONF="${REPO_DIR}/nginx.public.conf"
COMPOSE_OVERRIDE_TEMPLATE="${SCRIPT_DIR}/docker-compose.public-tls.yml"
COMPOSE_OVERRIDE_DEST="${REPO_DIR}/docker-compose.override.yml"

mkdir -p "$WEBROOT"

echo "=========================================================="
echo "Nora TLS setup"
echo "Domain: ${DOMAIN}"
echo "Email:  ${EMAIL}"
echo "=========================================================="

echo
echo "[1/3] Requesting certificate from Let's Encrypt..."

(cd "$REPO_DIR" && docker compose stop nginx >/dev/null 2>&1) || true

docker run --rm \
  -v "/etc/letsencrypt:/etc/letsencrypt" \
  -v "/var/lib/letsencrypt:/var/lib/letsencrypt" \
  -v "${WEBROOT}:/var/www/certbot" \
  -p 80:80 \
  certbot/certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"

echo "[1/3] Certificate obtained"

echo
echo "[2/3] Writing nginx and compose TLS config..."

awk -v domain="$DOMAIN" '{ gsub(/\$\{DOMAIN\}/, domain); print }' "$TLS_TEMPLATE" > "$PUBLIC_NGINX_CONF"
cp "$COMPOSE_OVERRIDE_TEMPLATE" "$COMPOSE_OVERRIDE_DEST"

echo "  Wrote ${PUBLIC_NGINX_CONF##*/}"
echo "  Wrote ${COMPOSE_OVERRIDE_DEST##*/}"
echo "[2/3] Config ready"

echo
echo "[3/3] Setting up auto-renewal..."

CRON_CMD="0 3 * * * docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt -v ${WEBROOT}:/var/www/certbot certbot/certbot renew --quiet && cd ${REPO_DIR} && docker compose up -d nginx"

(crontab -l 2>/dev/null | grep -v 'certbot.*renew' || true; echo "$CRON_CMD") | crontab -

echo "  Auto-renewal cron added (daily at 3 AM)"
echo "[3/3] Auto-renewal configured"

echo
echo "=========================================================="
echo "TLS setup complete"
echo
echo "Next steps:"
echo "  1. In .env, set:"
echo "     NEXTAUTH_URL=https://${DOMAIN}"
echo "     CORS_ORIGINS=https://${DOMAIN}"
echo "     NGINX_CONFIG_FILE=nginx.public.conf"
echo "     NGINX_HTTP_PORT=80"
echo "  2. Start or restart Nora with: docker compose up -d"
echo "=========================================================="
