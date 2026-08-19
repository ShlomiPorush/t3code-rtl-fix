Option Explicit

Dim shell, fileSystem, baseDir, nodePath, launcherPath, appPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

baseDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
nodePath = ReadTrimmedFile(baseDir & "\node-path.txt")
appPath = ReadTrimmedFile(baseDir & "\app-path.txt")
launcherPath = baseDir & "\t3-rtl-launcher.js"

If fileSystem.FileExists(nodePath) And fileSystem.FileExists(launcherPath) Then
  command = Chr(34) & nodePath & Chr(34) & " " & _
    Chr(34) & launcherPath & Chr(34)
  shell.Run command, 0, False
ElseIf fileSystem.FileExists(appPath) Then
  shell.Run Chr(34) & appPath & Chr(34), 1, False
Else
  MsgBox "T3 Code or Node.js was not found. Run install.ps1 again.", _
    48, "T3 Code RTL Fix"
End If

Function ReadTrimmedFile(filePath)
  Dim stream
  If Not fileSystem.FileExists(filePath) Then
    ReadTrimmedFile = ""
    Exit Function
  End If
  Set stream = fileSystem.OpenTextFile(filePath, 1, False)
  ReadTrimmedFile = Trim(stream.ReadAll)
  stream.Close
End Function
