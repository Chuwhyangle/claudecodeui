# Windows desktop alerts for awaiting sessions

CloudCLI's "awaiting reply" list is drawn in the page, and this deployment is
served over plain HTTP — where the browser refuses both `Notification` and
service workers (`isSecureContext` is false). So once the page is closed, or the
browser is behind another window, nothing tells the user that a session stopped
and needs an answer. This directory closes that gap on a Windows workstation.

## How the path works

```
provider run ends
  -> sessionAwaitingReplyService.markSessionAwaitingReply   (server, writes the row)
  -> sendAwaitingReplyDesktopAlert                          (server, only for a NEW wait)
  -> $CLOUDCLI_DESKTOP_NOTIFY_CMD                           (one JSON object on stdin)
  -> ssh winbox powershell -File ...\enqueue.ps1            (non-interactive session)
  -> writes payload.json, runs `schtasks /run /tn CloudCLINotify`
  -> toast.ps1 in the logged-in session                     (interactive task)
  -> toast + system chime
```

The scheduled task is the part people get wrong: a process started by sshd runs
in session 0, which has no desktop, so a toast it raises is silently dropped.
The task is registered as *interactive*, and it is the task — not the SSH
process — that draws the notification.

## Install (once per workstation)

1. Copy `toast.ps1`, `enqueue.ps1`, and `install.ps1` to
   `C:\Users\<you>\cloudcli-notify\`.
2. Register the task:

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\<you>\cloudcli-notify\install.ps1
   ```

3. Prove the path end to end from the Linux server:

   ```bash
   echo '{"title":"CloudCLI test","body":"from enqueue","sessionId":"test"}' \
     | ssh winbox powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\<you>\cloudcli-notify\enqueue.ps1'
   ```

   A toast and a chime should appear within a second or two.

## Enable on the server

Add to the `cloudcli.service` drop-in (adjust the path):

```ini
Environment=CLOUDCLI_DESKTOP_NOTIFY_CMD=ssh -o BatchMode=yes -o ConnectTimeout=5 winbox powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\wenhao.chu\cloudcli-notify\enqueue.ps1'
```

Then `systemctl --user daemon-reload && systemctl --user restart cloudcli`.
The startup log prints `Awaiting-reply desktop alerts are off (...)` while the
variable is unset; silence there means the channel is wired.

## What does and does not alert

- **Yes**: a session *newly* starts waiting — turn completed, turn failed, or a
  tool approval is outstanding.
- **No**: a session already waiting changes reason (a permission prompt, then
  the turn completing anyway). That is one thing still awaiting an answer, and
  alerting again would ring once per event.
- **No**: dismissing a row, or a page load that finds waits already there.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No toast, no chime | Run step 3 by hand. If that works, the server side is the problem. |
| Server log `desktop alert ... failed` | The ssh call itself: run the same ssh command from the server by hand. |
| Toast missing but chime plays | Windows notifications are off for PowerShell (Settings → Notifications), or Do Not Disturb is on. `toast.ps1` deliberately plays the chime first, separately. |
| Toast only when you are at the console | The task is not interactive. Re-run `install.ps1`; it registers `-LogonType Interactive`. |
| Nothing after a reboot | The task is user-scoped and needs that user logged in. It is re-created by `install.ps1`, not by boot. |
