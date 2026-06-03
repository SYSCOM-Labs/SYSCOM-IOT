# Registra una tarea programada de Windows para que Syscom IoT arranque al iniciar sesión
# y se reinicie si el proceso Node termina inesperadamente.
#
# Ejecutar como administrador (opcional; sin admin la tarea corre solo al iniciar sesión del usuario actual):
#   powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-syscom-task.ps1
#
# Desinstalar:
#   Unregister-ScheduledTask -TaskName 'SyscomIoT-Production' -Confirm:$false

param(
  [string]$TaskName = 'SyscomIoT-Production',
  [ValidateSet('AtLogOn', 'AtStartup')]
  [string]$Trigger = 'AtLogOn'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$starter = Join-Path $Root 'deploy\windows\start-production.ps1'

if (-not (Test-Path $starter)) {
  Write-Error "No se encontró $starter"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$starter`"" -WorkingDirectory $Root

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

if ($Trigger -eq 'AtStartup') {
  $triggerObj = New-ScheduledTaskTrigger -AtStartup
} else {
  $triggerObj = New-ScheduledTaskTrigger -AtLogOn
}

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggerObj -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Tarea '$TaskName' registrada ($Trigger)."
Write-Host "Arranque manual: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Verificar motor: Invoke-RestMethod http://127.0.0.1:3001/api/health/platform"
Write-Host ""
Write-Host "IMPORTANTE: npm start (desarrollo) NO es 24/7. Use npm run production o esta tarea."
