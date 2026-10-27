' Starts toast.ps1 with no window at all.
'
' The scheduled task runs this file instead of powershell.exe directly.
' `-WindowStyle Hidden` on powershell.exe still briefly creates a console
' window under the task scheduler, and that flash is more annoying than the
' notification it accompanies. WScript.Shell.Run with a window style of 0
' creates the process without one.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\toast.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"

' 0 = hidden window, False = do not wait for it to exit.
shell.Run command, 0, False
