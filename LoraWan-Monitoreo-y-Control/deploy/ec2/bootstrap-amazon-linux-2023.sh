#!/usr/bin/env bash
# Bootstrap opcional en Amazon Linux 2023: Node.js 22 (NodeSource), git, nginx opcional.
# Ejecutar con usuario que tenga sudo:  bash deploy/ec2/bootstrap-amazon-linux-2023.sh
set -euo pipefail

echo "[bootstrap] Instalando Node.js 22 (NodeSource) y dependencias básicas..."
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs git nginx

echo "[bootstrap] Versiones:"
node -v
npm -v

echo "[bootstrap] Creando directorios para SQLite (ajustar propietario tras crear usuario syscom)..."
sudo mkdir -p /var/lib/syscom-iot
sudo chmod 755 /var/lib/syscom-iot

echo "[bootstrap] Listo. Siguientes pasos manuales:"
echo "  1) Clonar el repo en /opt/syscom-iot/app (o desplegar artefacto)."
echo "  2) npm ci && npm run build"
echo "  3) Crear /opt/syscom-iot/.env (JWT_SECRET, NODE_ENV=production, SYSCOM_SQLITE_PATH=/var/lib/syscom-iot/data.sqlite, ...)"
echo "  4) Copiar deploy/ec2/syscom-iot.service y: sudo systemctl enable --now syscom-iot"
echo "  5) Opcional: copiar deploy/ec2/nginx-syscom-iot.conf.example a /etc/nginx/conf.d/"
