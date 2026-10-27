# Queues one awaiting-reply alert and asks the logged-in Windows session to show it.
#
# Run over SSH by the CloudCLI server:
#
#   ssh winbox powershell -NoProfile -ExecutionPolicy Bypass -File C:\...\enqueue.ps1
#
# The JSON alert arrives on stdin. This process runs in the non-interactive
# session sshd starts, which has no desktop, so it cannot draw the toast itself:
# it writes the payload and triggers the `CloudCLINotify` scheduled task, whose
# action runs in the user's session.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadPath = Join-Path $root 'payload.json'

# Read the whole stdin before doing anything else: the server writes the JSON and
# closes the pipe, and the payload is small enough to buffer.
#
# Read through a StreamReader pinned to UTF-8 rather than [Console]::In, which
# decodes with the console's ANSI code page (936/GBK here). The server writes
# UTF-8, so the console reader turns a Chinese session title into mojibake and —
# when a multi-byte sequence swallows a quote — into JSON that no longer parses.
$stdinStream = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdinStream, (New-Object System.Text.UTF8Encoding($false)))
$raw = $reader.ReadToEnd()
$reader.Dispose()

if ([string]::IsNullOrWhiteSpace($raw)) {
    [Console]::Error.WriteLine('empty alert payload on stdin')
    exit 2
}

# Validate before writing: a payload the toast step cannot parse would otherwise
# surface there, far from the transport problem that caused it.
try {
    $null = $raw | ConvertFrom-Json
} catch {
    [Console]::Error.WriteLine("alert payload is not valid JSON: $($_.Exception.Message)")
    exit 3
}

# Written without a BOM: toast.ps1 reads it back with -Encoding UTF8, and a BOM
# would make the first character of the JSON text invalid.
[System.IO.File]::WriteAllText($payloadPath, $raw, (New-Object System.Text.UTF8Encoding($false)))

$taskName = 'CloudCLINotify'
$result = & schtasks.exe /run /tn $taskName 2>&1
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("could not start ${taskName}: $result")
    exit $LASTEXITCODE
}
