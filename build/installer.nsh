# Orgtree boot-engine task lifecycle for the ALL-USERS installer.
#
# Registration uses a task XML (written to $PLUGINSDIR) because the schtasks
# command line cannot express the settings that matter: ExecutionTimeLimit
# PT0S (the default 72h would kill a long-running engine), restart-on-failure
# and IgnoreNew — the same settings as tools/register-boot-engine.ps1. The
# principal is $BootOperator with an S4U logon — captured PRE-ELEVATION, so
# the task runs as whoever launched the installer, never as an alternate
# admin who merely approved the UAC prompt.
#
# OWNERSHIP RULE (root review): the fixed task name is only ever stopped,
# overwritten or deleted when the EXISTING task's action references THIS
# install's runtime path. A task registered by a different Orgtree install —
# or anything else that happens to hold the name — is left untouched and the
# conflict is surfaced. Current-user installs never touch the task at all.
# Failures are surfaced with a dialog (silent installs auto-acknowledge and
# keep the detail log); a task failure never aborts the install because the
# application still works per-logon. ASCII-safe XML only; a non-ASCII
# USERDOMAIN\USERNAME is a packaged-acceptance caveat.

!include "StrFunc.nsh"
${StrStr}
${UnStrStr}

# Sets $R9 to "1" when the existing task's XML references this install's
# runtime; "0" when the task is absent or foreign. Read-only.
!macro _bootTaskState
  StrCpy $R9 "0"
  nsExec::ExecToStack 'schtasks /Query /TN "Orgtree Background Engine" /XML'
  Pop $0
  Pop $R7
  ${if} $0 == 0
    ${StrStr} $R8 $R7 "$INSTDIR\resources\engine\runtime\python.exe"
    ${ifNot} $R8 == ""
      StrCpy $R9 "1"
    ${else}
      StrCpy $R9 "foreign"
    ${endIf}
  ${endif}
!macroend

!macro customInit
  Var /GLOBAL BootTaskExisted
  Var /GLOBAL BootOperator
  ReadEnvStr $R1 USERDOMAIN
  ReadEnvStr $R2 USERNAME
  StrCpy $BootOperator "$R1\$R2"
  StrCpy $BootTaskExisted "0"
  ${if} $installMode == "all"
    !insertmacro _bootTaskState
    ${if} $R9 == "1"
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
    ${elseif} $R9 == "foreign"
      DetailPrint "A task named 'Orgtree Background Engine' belongs to a different installation; leaving it untouched."
    ${endif}
  ${endif}
!macroend

!macro customInstall
  ${if} $installMode == "all"
    ${if} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_GetGlobalVar $BootOperator
    ${endif}
    # Never overwrite a task this install does not own.
    !insertmacro _bootTaskState
    ${if} $R9 == "foreign"
      DetailPrint "WARNING: boot startup NOT registered - the task name is held by a different installation."
      MessageBox MB_OK|MB_ICONEXCLAMATION "Orgtree boot startup was not registered: a task named 'Orgtree Background Engine' belongs to a different installation. Remove it in Task Scheduler and reinstall, or register manually with tools\register-boot-engine.ps1." /SD IDOK
    ${else}
      ClearErrors
      FileOpen $R5 "$PLUGINSDIR\orgtree-boot-task.xml" w
      ${if} ${Errors}
        DetailPrint "WARNING: could not write boot task definition; boot startup NOT registered."
        MessageBox MB_OK|MB_ICONEXCLAMATION "Orgtree boot startup was not registered: the task definition could not be written. Register manually with tools\register-boot-engine.ps1." /SD IDOK
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
              MessageBox MB_OK|MB_ICONEXCLAMATION "The Orgtree background engine could not be restarted after the update (it will start at the next boot)." /SD IDOK
            ${endIf}
          ${endif}
        ${else}
          DetailPrint "WARNING: boot task registration failed ($0) for $BootOperator; Orgtree still starts per-logon, boot startup is NOT registered."
          MessageBox MB_OK|MB_ICONEXCLAMATION "Orgtree boot startup could not be registered (schtasks error $0). Orgtree still starts when you log in; register boot startup manually with tools\register-boot-engine.ps1." /SD IDOK
        ${endIf}
      ${endIf}
    ${endif}
  ${endif}
!macroend

!macro customUnInstall
  ${if} $installMode == "all"
    # Only ever touch a task whose action references THIS install.
    StrCpy $R9 "0"
    nsExec::ExecToStack 'schtasks /Query /TN "Orgtree Background Engine" /XML'
    Pop $0
    Pop $R7
    ${if} $0 == 0
      ${UnStrStr} $R8 $R7 "$INSTDIR\resources\engine\runtime\python.exe"
      ${ifNot} $R8 == ""
        StrCpy $R9 "1"
      ${endIf}
    ${endif}
    ${if} $R9 == "1"
      nsExec::Exec 'schtasks /End /TN "Orgtree Background Engine"'
      Pop $0
      DetailPrint "Orgtree boot engine stop request: $0"
      # Same release proof as install: file removal must not race a dying
      # engine that still holds its runtime open.
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
        DetailPrint "WARNING: Orgtree boot engine still holds its runtime after 15s; removal may prompt a retry."
      ${endIf}
      ${ifNot} ${isUpdated}
        nsExec::Exec 'schtasks /Delete /F /TN "Orgtree Background Engine"'
        Pop $0
        ${if} $0 == 0
          DetailPrint "Orgtree boot engine task removed."
        ${else}
          DetailPrint "WARNING: boot task removal failed ($0); remove it in Task Scheduler."
          MessageBox MB_OK|MB_ICONEXCLAMATION "The Orgtree boot task could not be removed (schtasks error $0). Remove 'Orgtree Background Engine' in Task Scheduler." /SD IDOK
        ${endIf}
      ${endIf}
    ${elseif} $0 == 0
      DetailPrint "A task named 'Orgtree Background Engine' belongs to a different installation; leaving it untouched."
    ${endif}
  ${endif}
!macroend
