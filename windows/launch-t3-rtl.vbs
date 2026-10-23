Option Explicit

Dim shell, fileSystem, baseDir, launcherPath, appPath, repairListPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

baseDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
appPath = ReadTrimmedFile(baseDir & "\app-path.txt")
launcherPath = baseDir & "\t3-rtl-launcher.js"
' The installer lists the shortcuts it pointed at this launcher. The
' uninstaller deletes the list before it restores them, so a repair can never
' undo an uninstall.
repairListPath = baseDir & "\repair-shortcuts.txt"

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

If WScript.Arguments.Named.Exists("repair") Then
  WScript.Quit RepairShortcuts()
End If

If WScript.Arguments.Named.Exists("updated") Then
  WaitForUpdate
  WScript.Quit 0
End If

' A T3 Code update points the Start Menu shortcut at the app again. Repairing
' it is best effort and never keeps T3 Code from opening.
RepairShortcuts

If fileSystem.FileExists(appPath) And fileSystem.FileExists(launcherPath) Then
  shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
  command = Chr(34) & appPath & Chr(34) & " " & _
    Chr(34) & launcherPath & Chr(34)
  shell.Run command, 0, False
ElseIf fileSystem.FileExists(appPath) Then
  shell.Run Chr(34) & appPath & Chr(34), 1, False
Else
  MsgBox "T3 Code was not found. Run the install command again.", _
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

' Points every listed shortcut that opens T3 Code directly at this launcher
' again, the same way the installer does. Returns the number of shortcuts that
' could not be read or saved.
Function RepairShortcuts()
  Dim stream, text, line, shortcut, failures
  RepairShortcuts = 0
  If appPath = "" Or Not fileSystem.FileExists(repairListPath) Then Exit Function

  On Error Resume Next
  text = ""
  Set stream = fileSystem.OpenTextFile(repairListPath, 1, False, -1)
  If Not stream.AtEndOfStream Then text = stream.ReadAll
  stream.Close
  If Err.Number <> 0 Then
    RepairShortcuts = 1
    Exit Function
  End If

  failures = 0
  For Each line In Split(Replace(text, vbCr, ""), vbLf)
    line = Trim(line)
    If line <> "" Then
      If fileSystem.FileExists(line) Then
        Err.Clear
        Set shortcut = shell.CreateShortcut(line)
        If Err.Number = 0 Then
          If LCase(shortcut.TargetPath) = LCase(appPath) Then
            shortcut.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
            shortcut.Arguments = Chr(34) & WScript.ScriptFullName & Chr(34)
            shortcut.WorkingDirectory = baseDir
            shortcut.IconLocation = appPath & ",0"
            shortcut.WindowStyle = 1
            shortcut.Save
          End If
        End If
        If Err.Number <> 0 Then failures = failures + 1
      End If
    End If
  Next
  RepairShortcuts = failures
End Function

' Started by the launcher when the T3 Code executable changed after T3 Code
' exited. The installer of the update reopens T3 Code with --updated, without
' the fix. Waits for that, repairs the shortcuts, and tells the user to reopen
' T3 Code. An update installed on quit, without reopening, only repairs.
Sub WaitForUpdate()
  Dim lockPath, waitSeconds, deadline, reopened
  lockPath = baseDir & "\update-notice.lock"
  ' Every launcher that was open when the update started hands over, but only
  ' one helper waits and shows the message.
  If Not TakeLock(lockPath) Then Exit Sub

  waitSeconds = 300
  If WScript.Arguments.Named.Exists("wait") Then waitSeconds = CLng(WScript.Arguments.Named("wait"))
  deadline = DateAdd("s", waitSeconds, Now)
  reopened = ""
  Do
    If Not fileSystem.FileExists(repairListPath) Then Exit Do
    reopened = FindUpdatedApp()
    If reopened <> "" Or Now >= deadline Then Exit Do
    WScript.Sleep 2000
  Loop

  If fileSystem.FileExists(repairListPath) Then
    ' The installer writes its shortcuts before it reopens the app. Give it a
    ' moment to finish before repairing them.
    If reopened <> "" Then WScript.Sleep 3000
    RepairShortcuts
    If reopened <> "" And LCase(reopened) = LCase(appPath) Then
      Notify "T3 Code was updated and reopened without the RTL fix. " & _
        "Quit T3 Code fully, then open it again from its shortcut."
    ElseIf reopened <> "" Or Not fileSystem.FileExists(appPath) Then
      Notify "T3 Code was updated and renamed, so the RTL fix no longer starts with it. " & _
        "Run the install command again, then open T3 Code from its shortcut."
    End If
  End If
  ReleaseLock lockPath
End Sub

' Returns the executable of a T3 Code main process in the installed app's
' folder that an update reopened, or "" when there is none. Electron's own
' child processes carry --type= and are skipped.
Function FindUpdatedApp()
  Dim service, processes, process, appFolder, commandLine, executable
  FindUpdatedApp = ""
  appFolder = LCase(fileSystem.GetParentFolderName(appPath))
  On Error Resume Next
  Set service = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
  If Err.Number <> 0 Then Exit Function
  Set processes = service.ExecQuery( _
    "SELECT ExecutablePath, CommandLine FROM Win32_Process WHERE Name LIKE 'T3 Code%'")
  If Err.Number <> 0 Then Exit Function
  For Each process In processes
    commandLine = "" & process.CommandLine
    executable = "" & process.ExecutablePath
    If executable <> "" And LCase(fileSystem.GetParentFolderName(executable)) = appFolder Then
      If InStr(1, commandLine, " --updated", vbTextCompare) > 0 And _
        InStr(1, commandLine, "--type=", vbTextCompare) = 0 Then
        FindUpdatedApp = executable
        Exit Function
      End If
    End If
  Next
End Function

Function TakeLock(lockPath)
  Dim stream
  TakeLock = False
  On Error Resume Next
  If fileSystem.FileExists(lockPath) Then
    ' A helper that was stopped never removed its lock. Ignore it after the
    ' longest wait has passed.
    If DateDiff("n", fileSystem.GetFile(lockPath).DateLastModified, Now) < 10 Then Exit Function
    fileSystem.DeleteFile lockPath, True
  End If
  Err.Clear
  Set stream = fileSystem.CreateTextFile(lockPath, False)
  If Err.Number <> 0 Then Exit Function
  stream.Close
  TakeLock = True
End Function

Sub ReleaseLock(lockPath)
  On Error Resume Next
  fileSystem.DeleteFile lockPath, True
End Sub

Sub Notify(message)
  Dim stream
  If WScript.Arguments.Named.Exists("notice") Then
    ' The installer test reads the message from a file instead of a dialog.
    Set stream = fileSystem.CreateTextFile(WScript.Arguments.Named("notice"), True, True)
    stream.Write message
    stream.Close
  Else
    MsgBox message, vbInformation + vbSystemModal, "T3 Code RTL Fix"
  End If
End Sub
