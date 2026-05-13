<#
.SYNOPSIS
  Escucha UDP en el puerto 1700 (Semtech GWMP) y muestra cabecera + JSON cola (si cabe en UTF-8).

.DESCRIPTION
  - Detenga el LNS Node en este PC antes de usar el mismo puerto, o ejecute en otra máquina en la LAN.
  - Los paquetes GWMP NO son JSON puro: byte 3 = tipo (0x05 = GW_TX_ACK); el JSON va desde el byte 12.
  - Para diagnóstico en el servidor LNS, prefiera: SYSCOM_LNS_LOG_TX_ACK_PROGRESS=1 o SYSCOM_LNS_LOG_TX_ACK=1

.PARAMETER Port
  Puerto UDP (defecto 1700).
#>
param([int]$Port = 1700)

$ep = New-Object System.Net.IPEndpoint([System.Net.IPAddress]::Any, $Port)
$udp = New-Object System.Net.Sockets.UdpClient
$udp.Client.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
try {
  $udp.Client.Bind($ep)
} catch {
  Write-Error "No se pudo enlazar UDP/$Port : $_ (¿npm start ya usa LNS_UDP_PORT?)"
  exit 1
}

Write-Host "UDP/$Port — Ctrl+C para salir. GWMP: v=byte0 id=byte3 token=bytes1-2 mac8=bytes4-11 json=utf8 desde byte12"
while ($true) {
  $remote = New-Object System.Net.IPEndpoint([System.Net.IPAddress]::Any, 0)
  $buf = $udp.Receive([ref]$remote)
  $len = $buf.Length
  $id = if ($len -gt 3) { $buf[3] } else { -1 }
  $head = ($buf[0..([Math]::Min(15, $len - 1))] | ForEach-Object { $_.ToString('X2') }) -join ''
  $tail = ''
  if ($len -gt 12) {
    try {
      $tail = [System.Text.Encoding]::UTF8.GetString($buf, 12, $len - 12)
    } catch { $tail = '(utf8 error)' }
  }
  $ts = Get-Date -Format 'o'
  $idHex = '{0:X2}' -f $id
  Write-Host "[$ts] $($remote.Address):$($remote.Port) len=$len id=0x$idHex head=$head"
  if ($tail.Length -gt 0) {
    Write-Host "  json_tail: $tail"
    if ($tail -match 'txpk_ack') { Write-Host '  >>> contiene txpk_ack (típico GW_TX_ACK 0x05)' }
  }
}
