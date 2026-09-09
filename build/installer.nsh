# Orgtree boot-engine task lifecycle for the ALL-USERS installer.
#
# Registration uses a task XML (written to $PLUGINSDIR) because the schtasks
# command line cannot express the settings that matter: ExecutionTimeLimit
# PT0S (the default 72h would kill a long-running engine), restart-on-failure
# and IgnoreNew. The principal is $BootOperator with an S4U logon — captured
# PRE-ELEVATION, so the task runs as whoever launched the installer, never as
# an alternate admin who merely approved the UAC prompt. Every schtasks call
# is error-checked into the install log; a registration failure warns rather
# than aborting (the app still works per-logon), and a stop that cannot be
# proven is surfaced before file replacement. ASCII-safe XML only; a
# non-ASCII USERDOMAIN\USERNAME is a packaged-acceptance caveat.

!macro customInit
  Var /GLOBAL BootTaskExisted
  Var /GLOBAL BootOperator
  ReadEnvStr $R1 USERDOMAIN
  ReadEnvStr $R2 USERNAME
  StrCpy $BootOperator "$R1\$R2"
  StrCpy $BootTaskExisted "0"
  # Query is read-only and cheap; every WRITE below is conditioned on it.
  nsExec::Exec 'schtasks /Query /TN "Orgtree Background Engine"'
  Pop $0
  ${if} $0 == 0
    StrCpy $BootTaskExisted "1"
    ${if} ${UAC_IsAdmin}
      nsExec::Exec 'schtasks /End /TN "Orgtree Background Engine"'
      Pop $0
      DetailPrint "Orgtree boot engine stop request: $0"
      # PROOF the engine released its files, not an assumption: the packaged
      # runtime exe opens for append only when no process holds it. Bounded;
      # on timeout the copy step surfaces the lock through its own retry UI.
      StrCpy $R3 0
      ${DoWhile} $R3 < 30
        ClearErrors
        FileOpen $R4 "$INSTDIR\resources\engine\runtime\python.exe" a
        ${ifNot} ${Errors}
          FileClose $R4
          ${Break}
        ${endIf}
        Sleep 500
        IntOp $R3 $R3 + 1
      ${Loop}
      ${if} $R3 >= 30
        DetailPrint "WARNING: Orgtree boot engine still holds its runtime after 15s; file replacement may prompt a retry."
      ${else}
        DetailPrint "Orgtree boot engine runtime released."
      ${endIf}
    ${endIf}
  ${endif}
!macroend

!macro customInstall
  ${if} $installMode == "all"
    ${if} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_GetGlobalVar $BootOperator
    ${endif}
    ClearErrors
    FileOpen $R5 "$PLUGINSDIR\orgtree-boot-task.xml" w
    ${if} ${Errors}
      DetailPrint "WARNING: could not write boot task definition; boot startup NOT registered."
    ${else}
      FileWrite $R5 '<?xml version="1.0" encoding="UTF-8"?>$\r$\n'
      FileWrite $R5 '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n'
      FileWrite $R5 '  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>$\r$\n'
      FileWrite $R5 '  <Principals><Principal id="Author"><UserId>$BootOperator</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>$\r$\n'
      FileWrite $R5 '  <Settings>$\r$\n'
      FileWrite $R5 '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>$\r$\n'
      FileWrite $R5 '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>$\r$\n'
      FileWrite $R5 '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>$\r$\n'
      FileWrite $R5 '    <AllowHardTerminate>true</AllowHardTerminate>$\r$\n'
      FileWrite $R5 '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>$\r$\n'
      FileWrite $R5 '    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>$\r$\n'
      FileWrite $R5 '    <Enabled>true</Enabled>$\r$\n'
      FileWrite $R5 '  </Settings>$\r$\n'
      FileWrite $R5 '  <Actions Context="Author"><Exec>$\r$\n'
      FileWrite $R5 '    <Command>"$INSTDIR\resources\engine\runtime\python.exe"</Command>$\r$\n'
      FileWrite $R5 '    <Arguments>"$INSTDIR\resources\engine\service_host.py"</Arguments>$\r$\n'
      FileWrite $R5 '    <WorkingDirectory>$INSTDIR\resources\engine</WorkingDirectory>$\r$\n'
      FileWrite $R5 '  </Exec></Actions>$\r$\n'
      FileWrite $R5 '</Task>$\r$\n'
      FileClose $R5
      nsExec::Exec 'schtasks /Create /F /TN "Orgtree Background Engine" /XML "$PLUGINSDIR\orgtree-boot-task.xml"'
      Pop $0
      ${if} $0 == 0
        DetailPrint "Orgtree boot engine task registered for $BootOperator."
        ${if} $BootTaskExisted == "1"
          nsExec::Exec 'schtasks /Run /TN "Orgtree Background Engine"'
          Pop $0
          ${if} $0 == 0
            DetailPrint "Orgtree boot engine restarted after update."
          ${else}
            DetailPrint "WARNING: Orgtree boot engine restart failed ($0); it starts at next boot."
          ${endIf}
        ${endif}
      ${else}
        DetailPrint "WARNING: boot task registration failed ($0) for $BootOperator; Orgtree still starts per-logon, boot startup is NOT registered."
      ${endIf}
    ${endIf}
  ${endif}
!macroend

!macro customUnInstall
  ${if} $installMode == "all"
    nsExec::Exec 'schtasks /Query /TN "Orgtree Background Engine"'
    Pop $0
    ${if} $0 == 0
      nsExec::Exec 'schtasks /End /TN "Orgtree Background Engine"'
      Pop $0
      DetailPrint "Orgtree boot engine stop request: $0"
      ${ifNot} ${isUpdated}
        nsExec::Exec 'schtasks /Delete /F /TN "Orgtree Background Engine"'
        Pop $0
        ${if} $0 == 0
          DetailPrint "Orgtree boot engine task removed."
        ${else}
          DetailPrint "WARNING: boot task removal failed ($0); remove it in Task Scheduler."
        ${endIf}
      ${endIf}
    ${endif}
  ${endif}
!macroend
