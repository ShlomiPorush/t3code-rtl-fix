Option Explicit

Dim shell, fileSystem, baseDir, launcherPath, appPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

baseDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
appPath = ReadTrimmedFile(baseDir & "\app-path.txt")
launcherPath = baseDir & "\t3-rtl-launcher.js"

If WScript.Arguments.Named.Exists("check") Then
  If Not fileSystem.FileExists(appPath) Then
    WScript.Echo "T3 Code was not found at the saved path: " & appPath
    WScript.Quit 2
  End If
  If Not fileSystem.FileExists(launcherPath) Then
    WScript.Echo "The launcher was not found at: " & launcherPath
    WScript.Quit 3
  End If
  WScript.Echo "Launcher configuration check passed."
  WScript.Quit 0
End If

If fileSystem.FileExists(appPath) And fileSystem.FileExists(launcherPath) Then
  shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
  command = Chr(34) & appPath & Chr(34) & " " & _
    Chr(34) & launcherPath & Chr(34)
  shell.Run command, 0, False
ElseIf fileSystem.FileExists(appPath) Then
  shell.Run Chr(34) & appPath & Chr(34), 1, False
Else
  MsgBox "T3 Code was not found. Run install.ps1 again.", _
    48, "T3 Code RTL Fix"
End If

Function ReadTrimmedFile(filePath)
  Dim stream
  If Not fileSystem.FileExists(filePath) Then
    ReadTrimmedFile = ""
    Exit Function
  End If
  Set stream = fileSystem.OpenTextFile(filePath, 1, False, -1)
  ReadTrimmedFile = Replace(Replace(Trim(stream.ReadAll), vbCr, ""), vbLf, "")
  stream.Close
End Function
