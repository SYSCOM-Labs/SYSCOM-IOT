# Volcado rápido para depurar downlinks LoRaWAN (LNS integrado).
# Requisitos: JWT de sesión web (staff) con dispositivo asignado.
#
#   .\scripts\lns-diagnose-downlink.ps1 -Token "eyJ..." -DeviceId "mi-dispositivo"
#   $env:SYSCOM_API_BASE = "https://iot.ejemplo.com/api"   # opcional; defecto http://127.0.0.1:3001/api
#
# Qué interpretar:
# - lora-profile: channel = FPort por defecto si no mandas fPort en POST; lorawanClassSource = telemetry → riesgo Shengda «Class B» falso.
# - session: sin fila → Join OTAA; fcntDown vs nodo → PATCH .../lns/session con fcntDown.
# - downlinks recientes: deferredReason si fue 202; campos del gateway (txAck, errores).
# - ui-events: downlink_gateway_ack → txpk_ack.error (TOO_LATE, TOO_EARLY, TX_FREQ).

param(
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$DeviceId,
    [string]$Base = $(if ($env:SYSCOM_API_BASE) { $env:SYSCOM_API_BASE } else { 'http://127.0.0.1:3001/api' })
)

$ErrorActionPreference = 'Stop'
$encId = [uri]::EscapeDataString($DeviceId)
$h = @{ Authorization = "Bearer $Token" }

function Show-Block($title, $obj) {
    Write-Host "`n=== $title ===" -ForegroundColor Cyan
    if ($null -eq $obj) { Write-Host '(null)'; return }
    $obj | ConvertTo-Json -Depth 10
}

try {
    Show-Block "GET /devices/$DeviceId/lora-profile" (
        Invoke-RestMethod -Uri "$Base/devices/$encId/lora-profile" -Headers $h -Method Get
    )
}
catch {
    Write-Host "lora-profile: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "  (requiere rol staff y dispositivo asignado)" -ForegroundColor Gray
}

try {
    Show-Block "GET /devices/$DeviceId/lns/session" (
        Invoke-RestMethod -Uri "$Base/devices/$encId/lns/session" -Headers $h -Method Get
    )
}
catch {
    Write-Host "lns/session: $($_.Exception.Message)" -ForegroundColor Yellow
}

try {
    $dl = Invoke-RestMethod -Uri "$Base/downlinks?limit=30" -Headers $h -Method Get
    $filtered = @()
    if ($dl.list) {
        foreach ($row in $dl.list) {
            if ($row.deviceId -eq $DeviceId -or $row.devEUI) { $filtered += $row }
        }
    }
    # Si no hubo match por deviceId, mostrar últimos 15 de la cuenta (referencia)
    if ($filtered.Count -eq 0 -and $dl.list) {
        $filtered = $dl.list | Select-Object -First 15
        Write-Host "`n(notas: sin coincidencia exacta deviceId; mostrando últimos downlinks de la cuenta)" -ForegroundColor Gray
    }
    Show-Block "GET /downlinks (filtrado / recientes)" $filtered
}
catch {
    Write-Host "downlinks: $($_.Exception.Message)" -ForegroundColor Yellow
}

try {
    $since = [string]([long]([DateTimeOffset]::UtcNow.AddHours(-24).ToUnixTimeMilliseconds()))
    $ev = Invoke-RestMethod -Uri "$Base/lns/ui-events?since=$since" -Headers $h -Method Get
    $deuiNorm = ''
    try {
        $sess = Invoke-RestMethod -Uri "$Base/devices/$encId/lns/session" -Headers $h -Method Get
        if ($sess.session.devEui) { $deuiNorm = $sess.session.devEui.ToLower() }
    }
    catch { }
    $rel = @()
    if ($ev.events) {
        foreach ($e in $ev.events) {
            $match =
                ($deuiNorm -and $e.devEui -and ($e.devEui.ToLower() -eq $deuiNorm)) -or
                ($e.meta -and $e.meta.deviceId -eq $DeviceId)
            if ($match -and $e.eventType -match 'downlink') { $rel += $e }
        }
    }
    if ($rel.Count -eq 0 -and $ev.events) {
        $rel = $ev.events | Where-Object { $_.eventType -match 'downlink' } | Select-Object -Last 25
        Write-Host "`n(notas: sin DevEUI en sesión o sin match; últimos eventos downlink de la cuenta)" -ForegroundColor Gray
    }
    Show-Block "GET /lns/ui-events (últimas ~24 h, downlink*)" $rel
}
catch {
    Write-Host "lns/ui-events: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`nHecho. Active en servidor SYSCOM_LNS_LOG_TX_ACK_PROGRESS=1 y SYSCOM_LNS_LOG_DOWNLINK_SCHEDULE=1 para traza en consola." -ForegroundColor DarkGray
