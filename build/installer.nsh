# No task operation in customInit: mode and final directory are not selected.
# ORGTREE_DEV_CHANNEL (defined by installer-dev.nsh for `npm run package:dev`)
# builds the same installer for the side-by-side development identity, with the
# all-users scope refused outright: that scope is where the published install's
# boot-engine task and HKLM uninstall entry live, and a development build must
# not be able to touch either.
!include "StrFunc.nsh"
!include "getProcessInfo.nsh"
Var pid
# The dev channel compiles out the preInit SID probe — this instantiation's
# only caller — and NSIS treats the resulting unreferenced function as an
# error, so the instantiation goes with it.
!ifndef BUILD_UNINSTALLER
!ifndef ORGTREE_DEV_CHANNEL
  ${StrTrimNewLines}
!endif
!endif

# Testable on its own (tools/test-dev-installer-guard.mjs drives it through a
# compiled fixture): quits with exit code 2 whenever the all-users mode was
# selected, before any section that could touch machine state runs.
!macro orgtreeDevScopeGuard
  ${if} $installMode == "all"
    MessageBox MB_OK|MB_ICONSTOP "Orgtree Dev is a local development build and installs per-user only.$\r$\nRun Setup again and choose to install it only for yourself." /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

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
  # Dev channel: no boot task will ever be registered, so the operator-SID
  # probe below has nothing to feed and is skipped.
  !ifndef BUILD_UNINSTALLER
    # The upgrade page runs before install sections, so its graceful process
    # helper must be available before the first page is shown. File extracts
    # only to NSIS's private temporary plugin directory.
    InitPluginsDir
    File /oname=$PLUGINSDIR\installer-upgrade.ps1 "${PROJECT_DIR}\tools\installer-upgrade.ps1"
  !ifndef ORGTREE_DEV_CHANNEL
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
  !endif
!macroend
# The stock electron-builder running-app include sends a friendly close first,
# then force-kills after its retry budget. The release installer must use the
# app's explicit second-instance control request instead and never kill either
# the desktop or its engine from the installer.
!ifndef BUILD_UNINSTALLER
Var OrgUpgradeAvailable
Var OrgUpgradeCandidateCount
Var OrgUpgradeChoice
Var OrgUpgradeSelected
Var OrgUpgradeInstallDir
Var OrgUpgradeInstallMode
Var OrgUpgradeRegistryRoot
Var OrgUpgradeExe
Var OrgUpgradeProbeValid
Var OrgUpgradeProbeDir
Var OrgUpgradeProbeMode
Var OrgUpgradeProbeRoot
Var OrgUpgradeProbeDisplay
Var OrgUpgradeProbeVersion
Var OrgUpgradeProbeUninstall
Var OrgUpgradeProbeIcon
Var OrgtreeUpgradePage
Var OrgUpgradePageLabel
Var OrgUpgradePathLabel
Var OrgUpgradeScopeLabel
Var OrgUpgradeButton
Var OrgUpgradeAdvancedButton
!endif

!ifndef BUILD_UNINSTALLER
# Snapshot the generated update predicate before the assisted installer
# redefines `isUpdated` for the manual Upgrade choice below. The snapshot is
# only expanded inside customInit, after electron-builder has added its NSIS
# plugin directory; expanding `_isUpdated` while this custom include is parsed
# would run before StdUtils.dll is available.
!define orgtreeOriginalIsUpdated `${isUpdated}`
!endif

!macro orgtreeUpgradeFunctions
Function orgtreeProbeUpgradeInstall
  Pop $0
  StrCpy $OrgUpgradeProbeValid "0"
  StrCpy $OrgUpgradeProbeDir ""
  StrCpy $OrgUpgradeProbeMode ""
  StrCpy $OrgUpgradeProbeRoot $0

  # The key itself is the application identity. Every additional value below
  # must agree with it before this installation can become an Upgrade target.
  ${if} $0 == "HKCU"
    ReadRegStr $OrgUpgradeProbeDisplay HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName
    # electron-builder stores InstallLocation on its application key, not on
    # the Add/Remove Programs key. Read the path from that authoritative
    # application record and keep the uninstall record for identity/version
    # checks below.
    ReadRegStr $OrgUpgradeProbeDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $OrgUpgradeProbeVersion HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ReadRegStr $OrgUpgradeProbeUninstall HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $OrgUpgradeProbeIcon HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayIcon
    ReadRegStr $1 HKCU "${UNINSTALL_REGISTRY_KEY}" OrgtreeUpgradeMetadata
    ReadRegStr $2 HKCU "${INSTALL_REGISTRY_KEY}" OrgtreeUpgradeMetadata
    StrCpy $OrgUpgradeProbeMode "CurrentUser"
  ${else}
    ReadRegStr $OrgUpgradeProbeDisplay HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayName
    ReadRegStr $OrgUpgradeProbeDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $OrgUpgradeProbeVersion HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ReadRegStr $OrgUpgradeProbeUninstall HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $OrgUpgradeProbeIcon HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayIcon
    ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY}" OrgtreeUpgradeMetadata
    ReadRegStr $2 HKLM "${INSTALL_REGISTRY_KEY}" OrgtreeUpgradeMetadata
    StrCpy $OrgUpgradeProbeMode "all"
  ${endif}

  # The generated uninstall DisplayName includes the installed version by
  # default, so validate the stable product prefix rather than this new
  # installer version. The exact uninstall registry key above still binds the
  # record to Orgtree's application identity.
  StrLen $6 "${PRODUCT_NAME}"
  StrCpy $7 $OrgUpgradeProbeDisplay $6
  ${if} $7 != "${PRODUCT_NAME}"
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}
  StrLen $7 $OrgUpgradeProbeDisplay
  ${if} $7 > $6
    StrCpy $7 $OrgUpgradeProbeDisplay 1 $6
    ${if} $7 != " "
      Goto orgtreeProbeUpgradeInstallInvalid
    ${endif}
  ${endif}
  ${if} $OrgUpgradeProbeDir == ""
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}
  ${if} $OrgUpgradeProbeVersion == ""
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}
  ${if} $OrgUpgradeProbeUninstall == ""
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}
  ${if} $OrgUpgradeProbeIcon == ""
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}
  ${if} $1 != "1"
    # Older V2 installs lack this marker and deliberately fall back to the
    # ordinary full setup flow rather than guessing their compatibility.
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}
  ${if} $2 != "1"
    Goto orgtreeProbeUpgradeInstallInvalid
  ${endif}

  GetFullPathName $4 $OrgUpgradeProbeDir
  IfFileExists "$4\${APP_EXECUTABLE_FILENAME}" 0 orgtreeProbeUpgradeInstallInvalid
  IfFileExists "$4\${UNINSTALL_FILENAME}" 0 orgtreeProbeUpgradeInstallInvalid
  StrCpy $OrgUpgradeProbeDir $4
  StrCpy $OrgUpgradeProbeValid "1"
  Return

orgtreeProbeUpgradeInstallInvalid:
  StrCpy $OrgUpgradeProbeValid "0"
FunctionEnd

Function orgtreeDetectUpgradeInstall
  StrCpy $OrgUpgradeAvailable "0"
  StrCpy $OrgUpgradeCandidateCount "0"
  StrCpy $OrgUpgradeInstallDir ""
  StrCpy $OrgUpgradeInstallMode ""
  StrCpy $OrgUpgradeRegistryRoot ""
  StrCpy $OrgUpgradeExe ""

  Push "HKCU"
  Call orgtreeProbeUpgradeInstall
  ${if} $OrgUpgradeProbeValid == "1"
    IntOp $OrgUpgradeCandidateCount $OrgUpgradeCandidateCount + 1
    StrCpy $OrgUpgradeInstallDir $OrgUpgradeProbeDir
    StrCpy $OrgUpgradeInstallMode $OrgUpgradeProbeMode
    StrCpy $OrgUpgradeRegistryRoot $OrgUpgradeProbeRoot
  ${endif}

  Push "HKLM"
  Call orgtreeProbeUpgradeInstall
  ${if} $OrgUpgradeProbeValid == "1"
    IntOp $OrgUpgradeCandidateCount $OrgUpgradeCandidateCount + 1
    StrCpy $OrgUpgradeInstallDir $OrgUpgradeProbeDir
    StrCpy $OrgUpgradeInstallMode $OrgUpgradeProbeMode
    StrCpy $OrgUpgradeRegistryRoot $OrgUpgradeProbeRoot
  ${endif}

  ${if} $OrgUpgradeCandidateCount == "1"
    StrCpy $OrgUpgradeAvailable "1"
    StrCpy $OrgUpgradeExe "$OrgUpgradeInstallDir\${APP_EXECUTABLE_FILENAME}"
  ${endif}
FunctionEnd

Function orgtreeCloseForUpgrade
orgtreeUpgradeShutdownAttempt:
  DetailPrint "Requesting a graceful Orgtree shutdown..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-upgrade.ps1" -InstallDir "$OrgUpgradeInstallDir" -ExecutablePath "$OrgUpgradeExe" -TimeoutSeconds 45'
  Pop $0
  Pop $1
  ${if} $0 == 0
    DetailPrint "Orgtree is closed; continuing the upgrade."
    Push "1"
    Return
  ${endif}
  DetailPrint "Graceful shutdown did not complete: $1"
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Orgtree is still running or could not be verified as closed.$\r$\n$1$\r$\nRetry to request a graceful close again, or Cancel to leave the existing installation untouched." /SD IDCANCEL IDRETRY orgtreeUpgradeShutdownAttempt IDCANCEL orgtreeUpgradeShutdownCancel
  Push "0"
  Return
orgtreeUpgradeShutdownCancel:
  Push "0"
FunctionEnd
!macroend

!macro customWelcomePage
  !ifndef BUILD_UNINSTALLER
    # Make every page's skip hook respond to the manual Upgrade choice. The
    # original `_isUpdated` test is evaluated from its snapshot during
    # customInit, so the established --updated entry point remains supported.
    !undef isUpdated
    !define isUpdated '$OrgUpgradeSelected == "1"'

    !insertmacro orgtreeUpgradeFunctions
    !insertmacro MUI_PAGE_INIT
    PageEx custom
      # A custom NSIS page has a creator and leave callback (the three-callback
      # form is for built-in pages). The creator performs the preflight before
      # creating controls, so an ineligible install never reaches the page.
      PageCallbacks orgtreeUpgradePageShow orgtreeUpgradePageLeave
      Caption " "
    PageExEnd

    Function orgtreeUpgradePageShow
      Call orgtreeDetectUpgradeInstall
      ${if} $OrgUpgradeAvailable != "1"
        Abort
      ${endif}
      ${if} $OrgUpgradeSelected == "1"
        Abort
      ${endif}
      StrCpy $OrgUpgradeChoice ""
      !insertmacro MUI_HEADER_TEXT "Upgrade Orgtree" "An existing Orgtree installation was found."
      nsDialogs::Create 1018
      Pop $OrgtreeUpgradePage
      ${if} $OrgtreeUpgradePage == error
        Abort
      ${endif}
      ${NSD_CreateLabel} 0u 0u 300u 22u "Upgrade the existing installation using its recorded settings."
      Pop $OrgUpgradePageLabel
      ${NSD_CreateLabel} 0u 27u 300u 34u "Install location: $OrgUpgradeInstallDir"
      Pop $OrgUpgradePathLabel
      ${if} $OrgUpgradeInstallMode == "all"
        ${NSD_CreateLabel} 0u 65u 300u 20u "Scope: all users (kept unchanged)"
      ${else}
        ${NSD_CreateLabel} 0u 65u 300u 20u "Scope: current user (kept unchanged)"
      ${endif}
      Pop $OrgUpgradeScopeLabel
      ${NSD_CreateButton} 0u 98u 110u 16u "&Upgrade"
      Pop $OrgUpgradeButton
      ${NSD_OnClick} $OrgUpgradeButton orgtreeUpgradeChooseUpgrade
      ${NSD_CreateButton} 122u 98u 110u 16u "&Advanced setup"
      Pop $OrgUpgradeAdvancedButton
      ${NSD_OnClick} $OrgUpgradeAdvancedButton orgtreeUpgradeChooseAdvanced
      nsDialogs::Show
    FunctionEnd

    Function orgtreeUpgradeChooseUpgrade
      Pop $0
      StrCpy $OrgUpgradeChoice "upgrade"
      GetDlgItem $1 $HWNDPARENT 1
      SendMessage $1 ${BM_CLICK} 0 0
    FunctionEnd

    Function orgtreeUpgradeChooseAdvanced
      Pop $0
      StrCpy $OrgUpgradeChoice "advanced"
      GetDlgItem $1 $HWNDPARENT 1
      SendMessage $1 ${BM_CLICK} 0 0
    FunctionEnd

    Function orgtreeUpgradePageLeave
      ${if} $OrgUpgradeChoice == "upgrade"
        # Set the recorded scope and directory before asking the app to close;
        # the subsequent mode/directory pages are skipped from this state.
        StrCpy $INSTDIR $OrgUpgradeInstallDir
        ${if} $OrgUpgradeInstallMode == "all"
          SetShellVarContext all
        ${else}
          SetShellVarContext current
        ${endif}
        Call orgtreeCloseForUpgrade
        Pop $0
        ${if} $0 != "1"
          Quit
        ${endif}
        StrCpy $OrgUpgradeSelected "1"
      ${elseif} $OrgUpgradeChoice == "advanced"
        StrCpy $OrgUpgradeSelected "0"
      ${else}
        # Pressing the standard Next button without choosing is the explicit
        # opt-out: continue through the normal full setup pages.
        StrCpy $OrgUpgradeChoice "advanced"
        StrCpy $OrgUpgradeSelected "0"
      ${endif}
    FunctionEnd
    !define ORGTREE_UPGRADE_PAGE_DEFINED
  !endif
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} $OrgUpgradeSelected == "1"
      ${if} $OrgUpgradeInstallMode == "all"
        !insertmacro setInstallModePerAllUsers
      ${else}
        !insertmacro setInstallModePerUser
      ${endif}
      StrCpy $INSTDIR $OrgUpgradeInstallDir
      Abort
    ${endif}
  !endif
!macroend

!macro customInit
  # Existing clients already pass --updated, even when they omit /S.
  # Make the update entry point silent so upgrading FROM those clients also
  # skips the wizard. Ordinary manual installs retain their setup pages.
  !ifndef BUILD_UNINSTALLER
    # The snapshot expands here, after electron-builder's StdUtils plugin
    # directory is registered. This preserves the established --updated
    # compatibility without invoking the plugin while this include is parsed.
    ${if} ${orgtreeOriginalIsUpdated}
      StrCpy $OrgUpgradeSelected "1"
    ${endif}
  !endif
  ${if} ${isUpdated}
    SetSilent silent
    # Preserve the old one-click/update entry point. A manual Upgrade selection
    # occurs after customInit, so it only affects page skip hooks from then on.
    !ifndef BUILD_UNINSTALLER
      StrCpy $OrgUpgradeChoice "upgrade"
      StrCpy $OrgUpgradeInstallMode $installMode
      StrCpy $OrgUpgradeInstallDir $INSTDIR
    !endif
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
    # Sections execute in declaration order, before bundled uninstall/copy.
    # Unlike a page hook, this also runs during silent installations.
    !ifdef ORGTREE_DEV_CHANNEL
      # The dev channel COMPILES the boot machinery out rather than gating it
      # at run time: the guard makes the all-users mode unreachable, and NSIS
      # treats the then-unreferenced Var/StrFunc pieces as fatal warnings.
      # Declared before everything else so it executes first: a dev install
      # that somehow selected the all-users scope ends here, before anything
      # elevates or touches the scheduled task.
      Section "-Orgtree dev channel scope guard"
        !insertmacro orgtreeDevScopeGuard
      SectionEnd
    !else
    Var BootOperatorSid
    Section "-Orgtree boot preflight"
      ${if} $installMode == "all"
        ${if} $OrgUpgradeSelected == "1"
          # Re-check immediately before touching boot state: a boot-managed
          # instance that reappeared after the page must be closed through the
          # same graceful, no-force-kill path.
          Call orgtreeCloseForUpgrade
          Pop $0
          ${if} $0 != "1"
            Quit
          ${endif}
        ${endif}
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
  !endif
!macroend
# For an explicit Upgrade, repeat the exact-path graceful close immediately
# before electron-builder copies files. Fresh/advanced installs retain the
# existing current-user running-app behavior.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
  ${if} $OrgUpgradeSelected == "1"
    Call orgtreeCloseForUpgrade
    Pop $0
    ${if} $0 != "1"
      Quit
    ${endif}
    ${elseif} $installMode == "CurrentUser"
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${endif}
  !else
    # The uninstaller has no upgrade page/helper functions. Preserve its
    # existing current-user running-app check and keep all installer-only
    # Call targets out of the uninstaller section at compile time.
    ${if} $installMode == "CurrentUser"
      !insertmacro IS_POWERSHELL_AVAILABLE
      !insertmacro _CHECK_APP_RUNNING
    ${endif}
  !endif
!macroend
!macro orgtreeRemoveLegacyShortcuts
  # `$SMPROGRAMS` follows the active shell context.  Select each context
  # explicitly so an all-users upgrade also cleans the installing user's old
  # link, then restore the context used by the install section.
  ${if} $installMode == "all"
    SetShellVarContext all
    Delete "$SMPROGRAMS\Orgtree v2.lnk"
    Delete "$SMPROGRAMS\Orgtree\Orgtree v2.lnk"
    SetShellVarContext current
    Delete "$SMPROGRAMS\Orgtree v2.lnk"
    Delete "$SMPROGRAMS\Orgtree\Orgtree v2.lnk"
    SetShellVarContext all
  ${else}
    SetShellVarContext current
    Delete "$SMPROGRAMS\Orgtree v2.lnk"
    Delete "$SMPROGRAMS\Orgtree\Orgtree v2.lnk"
  ${endif}
!macroend
!macro customInstall
  !ifndef ORGTREE_DEV_CHANNEL
  !insertmacro orgtreeRemoveLegacyShortcuts
  !endif
  !ifndef ORGTREE_DEV_CHANNEL
  ${if} $installMode == "all"
    !insertmacro BootHelpers
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\register-boot-engine.ps1" -Action Register -InstallMode all -InstallDir "$INSTDIR"'
    !insertmacro BootResult
  ${endif}
  !endif
  # This marker is written only after the normal registry/install work has
  # succeeded. It lets the next installer recognize this exact V2 contract;
  # older installs without it safely take the full setup path.
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" OrgtreeUpgradeMetadata "1"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" OrgtreeUpgradeMetadata "1"
!macroend
!macro customUnInstall
  !ifdef ORGTREE_DEV_CHANNEL
    # A dev build can only ever have installed per-user (the guard refuses the
    # other mode), so only the per-user running-app check applies here.
    ${if} $installMode == "CurrentUser"
      Call un.checkAppRunning
    ${endif}
  !else
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
  !endif
!macroend
