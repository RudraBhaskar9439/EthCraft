param([switch]$NoKeepAwake)
$ErrorActionPreference = 'Stop'
$nodeRepository = Split-Path -Parent $PSScriptRoot
$nodeMarker = Join-Path $nodeRepository '.local\hosting\enabled'
$nodeWslRoot = '/mnt/' + $nodeRepository.Substring(0, 1).ToLowerInvariant() + $nodeRepository.Substring(2).Replace('\', '/')
$nodeMutex = New-Object System.Threading.Mutex($false, 'Local\AgentCityHostKeepAwake')
if (-not $nodeMutex.WaitOne(0)) { exit 0 }
try {
    & wsl.exe -d Ubuntu --exec /usr/bin/python3 ($nodeWslRoot + '/scripts/host_node.py') start
    if ($LASTEXITCODE -ne 0) { throw 'AgentCity host did not start; inspect the private hosting logs.' }
    if ($NoKeepAwake) { exit 0 }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentCityPower {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
    try {
        while (Test-Path -LiteralPath $nodeMarker) {
            [void][AgentCityPower]::SetThreadExecutionState(2147483649)
            Start-Sleep -Seconds 30
        }
    } finally { [void][AgentCityPower]::SetThreadExecutionState(2147483648) }
} finally {
    $nodeMutex.ReleaseMutex()
    $nodeMutex.Dispose()
}
