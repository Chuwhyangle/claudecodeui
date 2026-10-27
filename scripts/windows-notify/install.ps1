# Registers the CloudCLINotify scheduled task that shows awaiting-reply toasts.
#
# Run once per Windows workstation, from the account that receives the alerts:
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\<you>\cloudcli-notify\install.ps1
#
# The action runs as an INTERACTIVE task. That is load-bearing: a toast must be
# drawn in the logged-in user's session, and a task without it would inherit the
# non-interactive session that sshd starts, where no desktop exists and the
# notification is silently dropped.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$toastScript = Join-Path $root 'toast.ps1'
$toastLauncher = Join-Path $root 'toast.vbs'
$taskName = 'CloudCLINotify'

if (-not (Test-Path -LiteralPath $toastScript)) {
    [Console]::Error.WriteLine("toast.ps1 not found next to install.ps1: $toastScript")
    exit 2
}

if (-not (Test-Path -LiteralPath $toastLauncher)) {
    [Console]::Error.WriteLine("toast.vbs not found next to install.ps1: $toastLauncher")
    exit 2
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Run through wscript rather than powershell.exe directly: the task scheduler
# gives powershell.exe a console window even with -WindowStyle Hidden, and that
# flash on every alert is worse than the alert itself. toast.vbs starts the
# script with a hidden window instead.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument "`"$toastLauncher`""

# A once-only trigger in the far future: the task is started by `schtasks /run`
# from enqueue.ps1, never by the clock. Register-ScheduledTask requires some
# trigger, and this one can never fire on its own.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# A laptop on battery must still alert; a stuck toast must not hold the task for
# Windows' three-day default.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Output "registered $taskName for $env:USERDOMAIN\$env:USERNAME (interactive)"
