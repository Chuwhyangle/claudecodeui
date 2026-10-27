# Receives one awaiting-reply alert from the CloudCLI server and raises a
# Windows toast for it.
#
# Called by the scheduled task `CloudCLINotify`, which is what makes the toast
# land in the logged-in user's session: a process started by sshd runs in
# session 0 and has no desktop to draw on, so the ssh call only queues the
# payload and triggers this task.
#
# The payload is one JSON object with `title`, `body`, and `sessionId`.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadPath = Join-Path $root 'payload.json'
$logPath = Join-Path $root 'last-run.log'

# One line per run, overwritten every time: the toast API reports success even
# when Windows suppresses the notification, so the only durable evidence that
# this task ran — and in which session — is a record it writes itself.
$sessionId = (Get-Process -Id $PID).SessionId
function Write-RunLog([string]$message) {
    $line = '{0} session={1} pid={2} {3}' -f (Get-Date -Format 's'), $sessionId, $PID, $message
    Set-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $payloadPath)) {
    Write-RunLog 'no payload.json; nothing to show'
    exit 0
}

try {
    $payload = Get-Content -LiteralPath $payloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-RunLog "payload.json is not valid JSON: $($_.Exception.Message)"
    exit 1
}

$title = if ($payload.title) { [string]$payload.title } else { 'CloudCLI' }
$body = if ($payload.body) { [string]$payload.body } else { 'Waiting for your reply' }

# The toast is the primary channel, but Windows can have notifications switched
# off (or suppressed in Do Not Disturb). The chime is what makes the alert still
# reach the user in that case, so it plays first and independently.
[System.Media.SystemSounds]::Exclamation.Play()

# Session names are user text and may contain XML metacharacters, so escape
# before inserting into the toast markup.
$safeTitle = [System.Security.SecurityElement]::Escape($title)
$safeBody = [System.Security.SecurityElement]::Escape($body)
$toastXml = '<toast><visual><binding template="ToastText02">' +
    "<text id=""1"">$safeTitle</text>" +
    "<text id=""2"">$safeBody</text>" +
    '</binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'

try {
    # WinRT types are not in PowerShell 5.1's default type table; both assemblies
    # have to be loaded by their type name before New-Object can see them.
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($toastXml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $document
    # PowerShell's own AppUserModelID: already registered on every Windows 10
    # install, so no app registration is needed to show a toast.
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Write-RunLog "toast shown: $title"
} catch {
    # No toast (WinRT unavailable, or notifications disabled): a popup is louder
    # but it does draw on the desktop, which is the whole point of this channel.
    Write-RunLog "toast failed, using popup: $($_.Exception.Message)"
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup($body, 15, $title, 64) | Out-Null
}
