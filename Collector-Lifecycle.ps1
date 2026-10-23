function Get-LocaldeckProcess($State) {
    if (-not $State -or -not $State.pid) { return $null }
    $process = Get-Process -Id $State.pid -ErrorAction SilentlyContinue
    if ($process -and $process.Path -eq $State.binary -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$State.ticks) {
        return $process
    }
    return $null
}

function Stop-LocaldeckHost([string]$StateDirectory) {
    # Stop the supervisor first so it cannot restart the collector during an update.
    foreach ($name in @('supervisor.json', 'collector.json')) {
        $path = Join-Path $StateDirectory $name
        if (Test-Path -LiteralPath $path) {
            $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            $process = Get-LocaldeckProcess $state
            if ($process) { Stop-Process -Id $process.Id; $process.WaitForExit() }
        }
    }
}
