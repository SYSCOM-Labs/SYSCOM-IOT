# Archivos para despliegue en AWS EC2

| Archivo | Uso |
|---------|-----|
| [`syscom-iot.service`](./syscom-iot.service) | Unidad **systemd**; copiar a `/etc/systemd/system/`. |
| [`nginx-syscom-iot.conf.example`](./nginx-syscom-iot.conf.example) | **Nginx** reverse proxy + SSE. |
| [`bootstrap-amazon-linux-2023.sh`](./bootstrap-amazon-linux-2023.sh) | Script opcional: Node 22 + git + nginx en AL2023. |

Guía paso a paso: [`docs/DEPLOY-AWS-EC2.md`](../../docs/DEPLOY-AWS-EC2.md).
