param([string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Localdeck'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Collector-Lifecycle.ps1')
$lock = $null
try {
    # An exclusive file handle also prevents duplicate launches from the Startup shortcut.
    try { $lock = [IO.File]::Open((Join-Path $StateDirectory 'supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { exit }
    $self = Get-Process -Id $PID
    @{ pid=$PID; ticks=$self.StartTime.ToUniversalTime().Ticks; binary=$self.Path } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDirectory 'supervisor.json') -Encoding UTF8
    $settings = Get-Content -LiteralPath (Join-Path $StateDirectory 'settings.json') -Raw | ConvertFrom-Json
    $env:LOCALDECK_TOKEN = $settings.token
    $env:LOCALDECK_ROOTS = ConvertTo-Json -InputObject @($settings.roots) -Compress
    $statePath = Join-Path $StateDirectory 'collector.json'
    while ($true) {
        try {
            $collector = $null
            if (Test-Path -LiteralPath $statePath) {
                $collector = Get-LocaldeckProcess (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
            }
            if (-not $collector) {
                $collector = Start-Process -FilePath $settings.binary -ArgumentList '--collector' -WorkingDirectory $StateDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'collector.log') -RedirectStandardError (Join-Path $StateDirectory 'collector-error.log')
                @{ pid=$collector.Id; ticks=$collector.StartTime.ToUniversalTime().Ticks; token=$settings.token; binary=$settings.binary } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
            }
            $collector.WaitForExit()
        } catch {
            $_ | Out-String | Add-Content -LiteralPath (Join-Path $StateDirectory 'supervisor-error.log')
        }
        Start-Sleep -Seconds 2
    }
} finally {
    if ($lock) { $lock.Dispose() }
}
