' Double-click to start the dashboard with no terminal window.
' It opens in your browser and stops by itself after you close the last dashboard tab.
'
' The server is started directly by Windows Script Host with a hidden console (window style 0).
' Everything the server starts later (for example Claude Code) inherits that hidden console,
' so no terminal window appears at any point.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

' Registers the claudedashboard:// link for this Windows user (HKEY_CURRENT_USER only), so the
' "Restart the server" button can start this launcher again after the server has stopped.
' To remove it: delete HKCU\Software\Classes\claudedashboard.
On Error Resume Next
key = "HKCU\Software\Classes\claudedashboard\"
shell.RegWrite key, "URL:Dashboard", "REG_SZ"
shell.RegWrite key & "URL Protocol", "", "REG_SZ"
shell.RegWrite key & "shell\open\command\", "wscript.exe """ & WScript.ScriptFullName & """ ""%1""", "REG_SZ"
On Error GoTo 0

' Started with an argument (the "Restart the server" button in an open dashboard tab, through
' the claudedashboard:// link): the tab is already open, so no new tab is opened and the
' assistant conversation is kept. The argument itself is never used.
If WScript.Arguments.Count > 0 Then
  mode = "--resume"
Else
  mode = "--open"
End If
shell.Run "node --import tsx server\index.ts --exit-with-browser --log " & mode, 0, False
