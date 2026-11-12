' Double-click to start the dashboard with no terminal window.
' It opens in your browser and stops by itself after you close the last dashboard tab.
'
' The server is started directly by Windows Script Host with a hidden console (window style 0).
' Everything the server starts later (for example Claude Code) inherits that hidden console,
' so no terminal window appears at any point.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "node --import tsx server\index.ts --exit-with-browser --open --log", 0, False
