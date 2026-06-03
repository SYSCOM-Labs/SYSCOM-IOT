# Arranca Syscom IoT en modo producción (API + dist/, LNS UDP, automatizaciones).
# Uso: .\deploy\windows\start-production.ps1
# Requiere: npm install y npm run build ejecutados previamente en la raíz del proyecto.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

if (-not (Test-Path (Join-Path $Root 'dist\index.html'))) {
  Write-Error 'No existe dist/. Ejecute: npm run build'
}

$env:NODE_ENV = 'production'
if (-not $env:JWT_SECRET -and -not (Test-Path (Join-Path $Root '.env'))) {
  Write-Error 'Defina JWT_SECRET en .env o en el entorno antes de producción.'
}

$nodeArgs = @('--experimental-sqlite')
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) { $nodeArgs += "--env-file=$envFile" }
$nodeArgs += (Join-Path $Root 'server\server.js')

Write-Host "[Syscom] Iniciando motor 24/7 (LNS + SQLite + automatizaciones). Cerrar sesión web NO detiene este proceso."
Write-Host "[Syscom] Salud: http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { '3001' })/api/health/platform"
& node @nodeArgs
