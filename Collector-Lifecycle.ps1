function Get-LocaldeckProcess($State) {
    if (-not $State -or -not $State.pid) { return $null }
    $process = Get-Process -Id $State.pid -ErrorAction SilentlyContinue
    if ($process -and $process.Path -eq $State.binary -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$State.ticks) {
        return $process
    }
    return $null
}

function Get-LocaldeckTaskName {
    return 'Localdeck-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Register-LocaldeckAutostart([string]$StateDirectory, [string]$TaskName = (Get-LocaldeckTaskName)) {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $watcher = Join-Path $StateDirectory 'Watch-Localdeck.ps1'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$watcher+'" -StateDirectory "'+$StateDirectory+'"'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $StateDirectory
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $user),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
    )
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
}

function Stop-LocaldeckHost([string]$StateDirectory, [string]$TaskName) {
    # Stop the scheduler-owned process before inspecting any legacy process state.
    if ($TaskName -and (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Stop-ScheduledTask -TaskName $TaskName
    }
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
