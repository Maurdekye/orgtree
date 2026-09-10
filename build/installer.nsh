# No task operation in customInit: mode and final directory are not selected.
!include "StrFunc.nsh"
!include "getProcessInfo.nsh"
Var pid
!ifndef BUILD_UNINSTALLER
  ${StrTrimNewLines}
!endif

!macro BootHelpers
  InitPluginsDir
  File /oname=$PLUGINSDIR\boot-engine-task.ps1 "${PROJECT_DIR}\tools\boot-engine-task.ps1"
  File /oname=$PLUGINSDIR\register-boot-engine.ps1 "${PROJECT_DIR}\tools\register-boot-engine.ps1"
  File /oname=$PLUGINSDIR\unregister-boot-engine.ps1 "${PROJECT_DIR}\tools\unregister-boot-engine.ps1"
!macroend
!macro BootResult
  Pop $0
  Pop $1
  ${if} $0 != 0
    DetailPrint "Boot engine operation failed: $1"
    MessageBox MB_OK|MB_ICONSTOP "Orgtree could not complete the boot engine operation.$\r$\n$1$\r$\nSetup will stop; boot startup has not been confirmed." /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ${if} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_GetGlobalVar $BootOperatorSid
    ${else}
      # Actual process token, not inherited USERNAME/USERDOMAIN environment.
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"'
      Pop $0
      Pop $BootOperatorSid
      ${StrTrimNewLines} $BootOperatorSid $BootOperatorSid
      ${if} $0 != 0
        StrCpy $BootOperatorSid ""
      ${endif}
    ${endif}
  !endif
!macroend
!macro customInit
  # Existing clients already pass --updated, even when they omit /S.
  # Make the update entry point silent so upgrading FROM those clients also
  # skips the wizard. Ordinary manual installs retain their setup pages.
  ${if} ${isUpdated}
    SetSilent silent
    # If both scopes exist, select the scope belonging to the running app's
    # explicit /D directory rather than the assisted installer's user default.
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !insertmacro GetDParameter $R2
      ${if} $R2 != ""
        GetFullPathName $R2 $R2
        GetFullPathName $R3 $perMachineInstallationFolder
        GetFullPathName $R4 $perUserInstallationFolder
        ${if} $perMachineInstallationFolder != ""
        ${andif} $R2 == $R3
          !insertmacro setInstallModePerAllUsers
        ${elseif} $perUserInstallationFolder != ""
        ${andif} $R2 == $R4
          !insertmacro setInstallModePerUser
        ${endif}
      ${endif}
    !endif
  ${endif}
!macroend
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var BootOperatorSid
    # Sections execute in declaration order, before bundled uninstall/copy.
    # Unlike a page hook, this also runs during silent installations.
    Section "-Orgtree boot preflight"
      ${if} $installMode == "all"
        ${ifNot} ${UAC_IsAdmin}
          !insertmacro UAC_RunElevated
          ${if} $0 != 0
            MessageBox MB_OK|MB_ICONSTOP "Administrator approval is required for boot startup." /SD IDOK
            SetErrorLevel 2
          ${endif}
          Quit
        ${endif}
        !insertmacro BootHelpers
        nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\register-boot-engine.ps1" -Action Prepare -InstallMode all -InstallDir "$INSTDIR" -OperatorSid "$BootOperatorSid"'
        !insertmacro BootResult
      ${endif}
    SectionEnd
  !endif
!macroend
# Default all-users check can kill every process under INSTDIR. Our preflight
# refuses open desktops and only stops the verified task. Per-user stays normal.
!macro customCheckAppRunning
  ${if} $installMode == "CurrentUser"
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${endif}
!macroend
!macro customInstall
  ${if} $installMode == "all"
    !insertmacro BootHelpers
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\register-boot-engine.ps1" -Action Register -InstallMode all -InstallDir "$INSTDIR"'
    !insertmacro BootResult
  ${endif}
!macroend
!macro customUnInstall
  ${if} $installMode == "all"
    !insertmacro BootHelpers
    ${if} ${isUpdated}
      StrCpy $2 "Stop"
    ${else}
      StrCpy $2 "Remove"
    ${endif}
    # Bundled hook precedes atomicRMDir / RMDir. Stop timeout aborts removal.
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\unregister-boot-engine.ps1" -Action $2 -InstallMode all -InstallDir "$INSTDIR"'
    !insertmacro BootResult
  ${elseif} $installMode == "CurrentUser"
    # Silent un.onInit runs before initMultiUser. Check here with known mode.
    Call un.checkAppRunning
  ${endif}
!macroend
