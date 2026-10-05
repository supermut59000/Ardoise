#!/usr/bin/env sh
# DEPLOY Ardoise — à exécuter SUR LE SERVEUR, n'importe où (se place dans le repo).
# git pull + rebuild frontend (dist/) + rebuild binaire + restart du service.
#
# Usage:  sh scripts/deploy.sh
set -eu
cd "$(dirname "$0")/.."

echo "==> git pull"
git pull

echo "==> frontend (frontend-react/dist/)"
# npm install (pas ci) : ci échoue avec npm 10 sur le lockfile écrit par npm 11.
(cd frontend-react && npm install --no-audit --no-fund && npm run build)

echo "==> binaire (rust/target/release/ardoise)"
(cd rust && cargo build --release)

if systemctl list-unit-files ardoise.service 2>/dev/null | grep -q ardoise; then
    echo "==> restart ardoise"
    sudo systemctl restart ardoise
else
    echo "==> ardoise.service absent, pas de restart (lance le binaire à la main)"
fi
echo "done."
