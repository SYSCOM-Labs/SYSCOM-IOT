# Instala paquetes Capacitor en Windows cuando npm install falla con ECONNRESET.
# Uso: powershell -ExecutionPolicy Bypass -File .\scripts\install-capacitor-windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "=== SYSCOM IoT — instalacion Capacitor ===" -ForegroundColor Cyan
Write-Host "Directorio: $Root"

# Ajustes npm (mas tolerante a redes inestables)
npm config set fetch-retries 10
npm config set fetch-retry-mintimeout 20000
npm config set fetch-retry-maxtimeout 120000
npm config set fetch-timeout 300000

$TarDir = Join-Path $Root ".npm-tarballs"
New-Item -ItemType Directory -Force -Path $TarDir | Out-Null

$packages = @(
    @{ Scope = "@capacitor/core"; File = "core-7.4.2.tgz"; Url = "https://registry.npmjs.org/@capacitor/core/-/core-7.4.2.tgz"; NpmArgs = @("--save-exact") },
    @{ Scope = "@capacitor/android"; File = "android-7.4.2.tgz"; Url = "https://registry.npmjs.org/@capacitor/android/-/android-7.4.2.tgz"; NpmArgs = @("--save-exact") },
    @{ Scope = "@capacitor/app"; File = "app-7.0.1.tgz"; Url = "https://registry.npmjs.org/@capacitor/app/-/app-7.0.1.tgz"; NpmArgs = @("--save-exact") },
    @{ Scope = "@capacitor/status-bar"; File = "status-bar-7.0.1.tgz"; Url = "https://registry.npmjs.org/@capacitor/status-bar/-/status-bar-7.0.1.tgz"; NpmArgs = @("--save-exact") },
    @{ Scope = "@capacitor/cli"; File = "cli-7.4.2.tgz"; Url = "https://registry.npmjs.org/@capacitor/cli/-/cli-7.4.2.tgz"; NpmArgs = @("--save-dev", "--save-exact") }
)

function Test-NpmRegistry {
    Write-Host "`nProbando conexion a registry.npmjs.org..." -ForegroundColor Yellow
    try {
        $r = Invoke-WebRequest -Uri "https://registry.npmjs.org/@capacitor/core" -UseBasicParsing -TimeoutSec 30
        Write-Host "OK — registry responde (HTTP $($r.StatusCode))" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "FALLO — $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Prueba: hotspot del celular, otra red, o VPN. Antivirus/firewall corporativo suele bloquear npm." -ForegroundColor Yellow
        return $false
    }
}

if (-not (Test-NpmRegistry)) {
    exit 1
}

foreach ($p in $packages) {
    $dest = Join-Path $TarDir $p.File
    Write-Host "`nDescargando $($p.Scope)..." -ForegroundColor Cyan
    if (-not (Test-Path $dest)) {
        try {
            Invoke-WebRequest -Uri $p.Url -OutFile $dest -UseBasicParsing -TimeoutSec 120
        } catch {
            Write-Host "Error al descargar $($p.Url)" -ForegroundColor Red
            Write-Host $_.Exception.Message
            exit 1
        }
    } else {
        Write-Host "Ya existe $dest — reutilizando" -ForegroundColor DarkGray
    }
    Write-Host "Instalando $($p.File)..." -ForegroundColor Cyan
    & npm install $dest @($p.NpmArgs)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install fallo para $($p.Scope)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "`n=== Capacitor instalado correctamente ===" -ForegroundColor Green
Write-Host "Siguiente:"
Write-Host "  npm run android:add"
Write-Host "  npm run android:sync"
Write-Host "  npm run android:open"
