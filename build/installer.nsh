# No task operation in customInit: mode and final directory are not selected.
# ORGTREE_DEV_CHANNEL (defined by installer-dev.nsh for `npm run package:dev`)
# builds the same installer for the side-by-side development identity, with the
# all-users scope refused outright: that scope is where the published install's
# boot-engine task and HKLM uninstall entry live, and a development build must
# not be able to touch either.
!include "StrFunc.nsh"
!include "getProcessInfo.nsh"
Var pid
# ⚠ DECLARED HERE, AT TOP LEVEL, AND THE POSITION IS THE WHOLE POINT. These back
# the OrgLog macro below. They used to be declared inside `customHeader`, which
# electron-builder expands AFTER `customWelcomePage` — so the first OrgLog
# expansion reached StrCpy before the names existed, and NSIS read the undeclared
# long name as a built-in short variable plus trailing text and refused the whole
# compile with "Usage: StrCpy $(user_var: output) str [maxlen] [startoffset]".
# A Var must be declared before the first expansion that assigns it, not merely
# before the function that reads it. Keep these above every macro definition.
!ifndef BUILD_UNINSTALLER
  Var OrgLogPath
  Var OrgLogStage
  Var OrgLogDetail
!endif
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
    # ⚠ THE FIRST LOG LINE IS WRITTEN HERE, AND THE POSITION IS THE POINT. This
    # is the earliest code in the run: everything that can quit, be refused, or
    # be declined happens after it. A log whose first entry came later would be
    # empty for exactly the failures it exists to explain.
    #
    # The received command line is recorded verbatim because it is the one fact
    # nobody could reconstruct afterwards — the field incident turned on which
    # arguments reached the installer, and the only record of them was the
    # application's own guess at what it had sent.
    ${StdUtils.GetAllParameters} $R0 "0"
    !insertmacro OrgLog "init" "setup=$EXEPATH"
    !insertmacro OrgLog "init-cmdline" "$R0"
    ${if} ${UAC_IsInnerInstance}
      !insertmacro OrgLog "init-elevated-instance" "this process IS the elevated inner instance"
    ${else}
      ${if} ${UAC_IsAdmin}
        !insertmacro OrgLog "init-rights" "started WITH administrator rights"
      ${else}
        !insertmacro OrgLog "init-rights" "started WITHOUT administrator rights"
      ${endif}
    ${endif}
    # The upgrade page runs before install sections, so its graceful process
    # helper must be available before the first page is shown. File extracts
    # only to NSIS's private temporary plugin directory.
    InitPluginsDir
    File /oname=$PLUGINSDIR\installer-upgrade.ps1 "${PROJECT_DIR}\tools\installer-upgrade.ps1"
    # Loaded by the upgrade-only finish hook and launched under the original
    # user token; it waits for this installer process to exit before starting
    # the replaced application. It is run by the application's own pythonw.exe
    # because the dispatch is a ShellExecute, which allocates a console for any
    # console-subsystem target — see orgtreeDispatchUpgradeRelaunch.
    File /oname=$PLUGINSDIR\installer-relaunch.py "${PROJECT_DIR}\tools\installer-relaunch.py"

    # An elevated inner instance is a BRAND NEW installer process. It re-runs
    # onInit and every page from the beginning and knows nothing about the
    # choice the user already made in the outer one, so without this it would
    # present the whole wizard a second time and ask again for a decision that
    # has already been taken. Carrying the selection across is what makes an
    # elevated upgrade look like one continuous installer: the user picks
    # Upgrade, approves the prompt, and the next thing they see is Installing.
    #
    # UAC_AsUser_GetGlobalVar reads the OUTER instance's live value, and the
    # outer instance is blocked inside UAC::_ for as long as we run, so these
    # values cannot change underneath us while they are being read.
    #
    # This is also why customInit gates silence on ${orgtreeOriginalIsUpdated}
    # and not on the redefined ${isUpdated}: after this inheritance the inner
    # instance satisfies the redefined predicate, and keying `SetSilent silent`
    # off it left the elevated child with no window at all. See customInit.
    ${if} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeSelected
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeChoice
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeAvailable
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeInstallMode
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeInstallDir
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeExe
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeRelaunchDir
      !insertmacro UAC_AsUser_GetGlobalVar $OrgUpgradeRelaunchPrepared
    ${endif}
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
Var OrgUpgradeElevateAttempts
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
Var OrgUpgradeRelaunchAcknowledged
Var OrgUpgradeRelaunchArgs
Var OrgUpgradeRelaunchDir
Var OrgUpgradeRelaunchHost
Var OrgUpgradeRelaunchReadyMarker
Var OrgUpgradeRelaunchPrepared
Var OrgUpgradeRelaunchReady
Var OrgUpgradeRelaunchScheduled
!endif

# Snapshot the generated update predicate before the assisted installer
# redefines `isUpdated` for the manual Upgrade choice below. The snapshot is
# only expanded inside customInit, after electron-builder has added its NSIS
# plugin directory; expanding `_isUpdated` while this custom include is parsed
# would run before StdUtils.dll is available.
#
# Defined for the uninstaller build too. `isUpdated` is generated for both
# builds (electron-builder's own uninstaller.nsh tests it), only the
# redefinition below is installer-only, and customInit now needs the snapshot
# on every path rather than only where the redefinition exists.
!define orgtreeOriginalIsUpdated `${isUpdated}`

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
  # $PLUGINSDIR is deleted when the installer exits, so the lifecycle record is
  # written outside it. RC1 failed here with three anonymous words and no way to
  # tell which step produced them, which took two release candidates to read
  # correctly; this file is what makes the next failure answerable without
  # asking the operator to reproduce it.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-upgrade.ps1" -InstallDir "$OrgUpgradeInstallDir" -ExecutablePath "$OrgUpgradeExe" -TimeoutSeconds 45 -LogPath "$TEMP\orgtree-installer-upgrade.log"'
  Pop $0
  Pop $1
  ${if} $0 == 0
    DetailPrint "Orgtree is closed; continuing the upgrade."
    !insertmacro OrgLog "app-closed" "the running Orgtree confirmed a graceful shutdown"
    Push "1"
    Return
  ${endif}
  DetailPrint "Graceful shutdown did not complete: $1"
  !insertmacro OrgLog "app-close-failed" "graceful shutdown did not complete: $1"
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Orgtree is still running or could not be verified as closed.$\r$\n$1$\r$\nRetry to request a graceful close again, or Cancel to leave the existing installation untouched." /SD IDCANCEL IDRETRY orgtreeUpgradeShutdownAttempt IDCANCEL orgtreeUpgradeShutdownCancel
  Push "0"
  Return
orgtreeUpgradeShutdownCancel:
  !insertmacro OrgLog "app-close-cancelled" "the user chose to leave the existing installation untouched"
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
      # The choice is already made — by the --updated entry point, or by the
      # outer instance whose selection an elevated inner instance inherits in
      # preInit. Skip the page WITHOUT re-detecting: detection rewrites
      # $OrgUpgradeInstallDir and the other recorded values from whatever this
      # process can read, and an elevated instance does not see the same
      # per-user registry as the one that made the choice. Re-deriving them
      # here could point the install at a different directory than the one the
      # user was shown and agreed to.
      ${if} $OrgUpgradeSelected == "1"
        Abort
      ${endif}
      Call orgtreeDetectUpgradeInstall
      ${if} $OrgUpgradeAvailable != "1"
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
        Call orgtreePrepareUpgradeRelaunch
        ${if} $OrgUpgradeRelaunchPrepared != "1"
          SetErrorLevel 2
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
        # ELEVATE HERE, AT INSTALL-MODE SELECTION.
        #
        # This is where electron-builder elevates for every other all-users
        # install (templates/nsis/multiUserUi.nsh, both the page PRE and the
        # page LEAVE), and its own comment in installer.nsi says so: "For a
        # non-silent install, the elevation will be triggered when the install
        # mode is selected in the UI". The Upgrade choice reaches this macro
        # and then Aborts the mode page, so before this fix it skipped the one
        # place the installer ever elevated, and the first thing to notice was
        # the boot preflight section — half way through "Installing".
        #
        # Elevating from a section is what produced the 2.1.3-RC4 field
        # failure: UAC_RunElevated starts a SECOND complete wizard, and the
        # first one sits blocked waiting for it. Because that call did not
        # hide its own window first, the user was left looking at an
        # "Installing" page frozen at 3% with a second Setup window behind it,
        # and nothing ever moved again.
        #
        # ShowWindow ... SW_HIDE is therefore not cosmetic. Every elevation
        # site in electron-builder does it, and it is what makes the outer
        # instance disappear instead of impersonating a hung installer.
        ${ifNot} ${UAC_IsAdmin}
          # ⚠ WRITTEN BEFORE THE PROMPT, NOT AFTER IT. This is the point
          # decision 8 is about: from here the next thing that happens is a
          # Windows permission prompt, and if it is declined the only process
          # that could describe the decline is this one. A log line written
          # after the call would already be a log line written after the answer.
          #
          # It also marks the one stage that can legitimately take a long time.
          # An installer that sits here for thirty seconds is a person reading a
          # prompt, not a wedge — and on the machine that failed, the app
          # restarted about thirty seconds after launching the installer twice.
          !insertmacro OrgLog "elevation-requested" "asking for administrator rights to upgrade [$OrgUpgradeInstallDir]; a prompt is now in front of the user"
          ShowWindow $HWNDPARENT ${SW_HIDE}
          !insertmacro UAC_RunElevated
          ${if} $0 == 0
          ${andif} $1 == 1
            # The elevated instance ran the entire upgrade. This process is
            # only the wrapper around it and has nothing left to do.
            !insertmacro OrgLog "elevation-approved" "an elevated instance ran the upgrade; this outer process is done"
            Quit
          ${endif}

          # Anything else means no elevated instance did the work. Show this
          # window again and say what happened, rather than vanishing or —
          # far worse — carrying on without the rights needed to replace
          # files in a per-machine installation.
          ShowWindow $HWNDPARENT ${SW_SHOW}
          BringToFront
          # ⚠ THE EXACT REFUSAL, DISTINGUISHED AND MADE DURABLE. These three
          # cases were already told apart here and said out loud in a message
          # box — which is useless twice over on the silent update path, where
          # /SD IDOK dismisses it and nobody is watching anyway. The refusal is
          # now recorded as well as announced, and 1223 (the user said No) is
          # kept distinct from "this account cannot elevate at all" and from a
          # failure to even ask, because the three call for different answers.
          ${if} $0 == 1223
            !insertmacro OrgLog "elevation-declined" "the Windows permission prompt was DISMISSED by the user (1223); nothing was changed"
            MessageBox MB_OK|MB_ICONINFORMATION "Administrator approval is required to upgrade the installation in $OrgUpgradeInstallDir.$\r$\nNothing has been changed." /SD IDOK
          ${elseif} $0 == 0
            !insertmacro OrgLog "elevation-unavailable" "no administrator account was available to elevate to; nothing was changed"
            MessageBox MB_OK|MB_ICONSTOP "Upgrading the installation in $OrgUpgradeInstallDir requires an administrator account.$\r$\nNothing has been changed." /SD IDOK
          ${else}
            !insertmacro OrgLog "elevation-error" "could not request administrator approval, Windows error $0; nothing was changed"
            MessageBox MB_OK|MB_ICONSTOP "Setup could not request administrator approval (error $0).$\r$\nNothing has been changed." /SD IDOK
          ${endif}
          !insertmacro OrgLog "exit" "exit code 2 from install-mode elevation; the existing installation is untouched"
          SetErrorLevel 2
          Quit
        ${endif}
        !insertmacro setInstallModePerAllUsers
        !insertmacro OrgLog "mode" "all users, with administrator rights held"
      ${else}
        !insertmacro setInstallModePerUser
        !insertmacro OrgLog "mode" "per user"
      ${endif}
      StrCpy $INSTDIR $OrgUpgradeInstallDir
      !insertmacro OrgLog "destination-final" "installing into [$INSTDIR]"
      Abort
    ${endif}
  !endif
!macroend

!macro customInit
  # Existing clients already pass --updated, even when they omit /S.
  # Make the update entry point silent so upgrading FROM those clients also
  # skips the wizard. Every manually launched Setup keeps its pages — including
  # the elevated child of a manual Upgrade, which is a manual run too.
  !ifndef BUILD_UNINSTALLER
    # An --updated run is an Upgrade by definition, so record the selection the
    # page would otherwise have made. Every skip hook downstream reads it.
    ${if} ${orgtreeOriginalIsUpdated}
      StrCpy $OrgUpgradeSelected "1"
    ${endif}
  !endif
  # GATE ON THE REAL --updated ENTRY POINT, NOT ON THE REDEFINED ${isUpdated}.
  #
  # This whole block belongs to the auto-updater's entry point: electron-updater
  # runs Setup with --updated (and --force-run), and that run is meant to be
  # silent and to relaunch the app by itself. The redefinition of `isUpdated`
  # further down exists for one narrow purpose — making electron-builder's page
  # skip hooks respond to a manual Upgrade choice — and it must not drag the
  # silent update entry point along with it.
  #
  # This line used to read `${if} ${isUpdated}`, which was safe only while the
  # comment below was true: a manual Upgrade selection happened on a page, long
  # after customInit. Carrying $OrgUpgradeSelected into the elevated inner
  # instance made it false. The inner instance now arrives at customInit with
  # the selection already set, matched the redefined predicate, and silenced
  # ITSELF. That was the 2.1.3-RC5 field failure: the outer instance hides
  # before elevating, the inner instance then had no window at all, so after
  # approving the prompt the user saw nothing — no Installing page, and no
  # finish page, which is the only place an assisted installer offers to run
  # the app. The install completed and the desktop was never relaunched.
  #
  # The snapshot expands here, after electron-builder's StdUtils plugin
  # directory is registered. Expanding `_isUpdated` while this include is
  # parsed would run before StdUtils.dll is available.
  ${if} ${orgtreeOriginalIsUpdated}
    SetSilent silent
    # The entry point, recorded before the destination is resolved below, so a
    # log that stops here still says which route the run took.
    !insertmacro OrgLog "entry" "silent update entry point (--updated); INSTDIR at init = $INSTDIR"
    # Preserve the old one-click/update entry point. Only --updated reaches
    # here, so these never overwrite the values an elevated inner instance
    # inherited in preInit from the outer instance's recorded selection.
    !ifndef BUILD_UNINSTALLER
      StrCpy $OrgUpgradeChoice "upgrade"
      StrCpy $OrgUpgradeInstallMode $installMode
      StrCpy $OrgUpgradeInstallDir $INSTDIR
    !endif
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !insertmacro GetDParameter $R2
      # ⚠ THE DESTINATION AS PARSED, not as sent. This is the field the incident
      # investigation most needed and did not have: the application could only
      # record what it PASSED, and the question was what the installer received
      # and made of it. Logged before the mode switches below act on it.
      !insertmacro OrgLog "destination" "/D= parsed as [$R2]; per-machine registered [$perMachineInstallationFolder]; per-user registered [$perUserInstallationFolder]"
      ${if} $R2 != ""
        GetFullPathName $R2 $R2
        GetFullPathName $R3 $perMachineInstallationFolder
        GetFullPathName $R4 $perUserInstallationFolder
        ${if} $perMachineInstallationFolder != ""
        ${andif} $R2 == $R3
          !insertmacro setInstallModePerAllUsers
          !insertmacro OrgLog "scope" "all users, matched the registered per-machine location"
        ${elseif} $perUserInstallationFolder != ""
        ${andif} $R2 == $R4
          !insertmacro setInstallModePerUser
          !insertmacro OrgLog "scope" "per user, matched the registered per-user location"
        ${else}
          !insertmacro OrgLog "scope" "kept the default scope: the parsed destination matched neither registered location"
        ${endif}
      ${endif}
    !endif

    # THE TARGET, RE-RECORDED FROM THE RESOLVED DESTINATION. Everything above
    # this line can still move it: setInstallModePerAllUsers and
    # setInstallModePerUser both rewrite $INSTDIR from the registered location
    # (and then from /D= again), so the values copied a few lines up are the
    # ones this run STARTED with, not the ones it will install into.
    #
    # ⚠ $OrgUpgradeExe WAS NEVER SET ON THIS PATH AT ALL, and that stranded the
    # silent route twice over. The only other assignment lives in
    # orgtreeDetectUpgradeInstall, which is reached from the upgrade PAGE —
    # skipped under silence — so a silent --updated run carried an empty
    # executable into orgtreeCloseForUpgrade. That call passes it as
    # -ExecutablePath to installer-upgrade.ps1, where the parameter is a
    # mandatory non-empty string: PowerShell refuses the binding with "Cannot
    # bind argument to parameter 'ExecutablePath' because it is an empty
    # string", the helper's body never runs, no graceful shutdown is ever
    # requested, and the silent message box defaults to Cancel. An elevated
    # inner instance inherited the same empty value and did not repair it.
    # Elevating correctly would still have hit that wall.
    #
    # Recorded BEFORE the elevation below so a log that stops at a declined
    # prompt still names the destination the run had resolved.
    !ifndef BUILD_UNINSTALLER
      StrCpy $OrgUpgradeInstallMode $installMode
      StrCpy $OrgUpgradeInstallDir $INSTDIR
      StrCpy $OrgUpgradeExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${if} $installMode == "all"
        StrCpy $OrgUpgradeRegistryRoot "HKLM"
      ${else}
        StrCpy $OrgUpgradeRegistryRoot "HKCU"
      ${endif}
      !insertmacro OrgLog "target" "silent update target resolved: scope [$OrgUpgradeInstallMode], directory [$OrgUpgradeInstallDir], executable [$OrgUpgradeExe]"
    !endif

    # ELEVATE HERE FOR A SILENT ALL-USERS UPDATE, AND THE POSITION IS THE WHOLE
    # POINT. This is the defect that stranded 2.1.3 clients: they could not
    # update at all, and every retry took the identical route.
    #
    # A silent --updated run reaches NO PAGE, so it never reaches
    # customInstallMode — the install-mode page PRE callback is the only place
    # this installer elevated, and page callbacks do not run under silence.
    #
    # electron-builder DOES ship a silent counterpart, and it is worth being
    # precise about why it did not save us. templates/nsis/installer.nsi has an
    # elevation block whose own comment reads "If we're running a silent upgrade
    # of a per-machine installation, elevate so extracting the new app will
    # succeed" — but it sits at the TOP OF `Section "install"`. Our boot
    # preflight section is defined through customHeader, which installer.nsi
    # expands at line 45, while `Section "install"` is declared at line 94. NSIS
    # runs sections in declaration order, so OUR section runs FIRST, finds no
    # administrator rights, and quits with error 2 before the stock elevation
    # block is ever reached. The stock path is not missing; it is unreachable.
    #
    # Elevating here rather than relying on that block is deliberate. Its guard
    # is `$hasPerMachineInstallation == "1"`, which is read from the HKLM
    # InstallLocation value, while the decision that actually matters to us is
    # the resolved $installMode — and the /D= block directly above can make
    # those two disagree. Depending on a condition that is merely usually the
    # same as ours is how this class of bug returns.
    #
    # WHY .onInit AND NOT A SECTION. Elevating from a section is the 2.1.3-RC4
    # field failure recorded in the boot preflight below: UAC_RunElevated starts
    # a second complete wizard and blocks the first, which sat visible at 3%
    # forever. .onInit runs before every section and before every page, so there
    # is no half-drawn installer to strand.
    #
    # WHY THIS DOES NOT REPEAT THE RC5 FAILURE. The inner instance inherits
    # --updated on its command line, so it is silent too — which is correct
    # here, because a background update is meant to be invisible. RC5 was a
    # MANUAL upgrade whose inner instance was silenced by the redefined
    # ${isUpdated}; this block is gated on ${orgtreeOriginalIsUpdated}, the real
    # command-line entry point, so a manual Upgrade never enters it at all and
    # keeps every page it has today.
    !ifndef BUILD_UNINSTALLER
    !ifndef INSTALL_MODE_PER_ALL_USERS
      ${if} $installMode == "all"
        ${ifNot} ${UAC_IsAdmin}
          # An inner instance that lacked admin has already been refused by
          # electron-builder's own initMultiUser, so reaching this line as the
          # inner instance should be impossible. It is guarded rather than
          # assumed, because the failure it would produce is an elevation loop.
          ${ifNot} ${UAC_IsInnerInstance}
            # THE RETURN CONTRACT, QUOTED FROM THE PINNED PLUGIN. Every branch
            # below exists because of a specific line of
            # node_modules/app-builder-lib/templates/nsis/include/UAC.nsh:
            #   $0  Win32 error; 0 = the elevation OPERATION succeeded, 1223 =
            #       the user dismissed the prompt, anything else is fatal.
            #   $1  when $0 == 0: 0 = UAC unsupported by this OS, 1 = an
            #       elevated CHILD was started and this process is only its
            #       wrapper, 2 = this process is already high-integrity,
            #       3 = call RunElevated again (a NON-ADMIN account was typed
            #       into the credential prompt).
            #   $2  when $0 == 0 && $1 == 1: THE CHILD'S EXIT CODE. The NSIS
            #       error level is set from it as well.
            #   $3  when $0 == 0: 1 if the user is in the administrators group.
            #
            # ⚠ STARTING A CHILD IS NOT INSTALLING SUCCESSFULLY. $1 == 1 says a
            # child ran to completion, not that it worked — the child's own
            # result is in $2, and an earlier version of this block wrote
            # SetErrorLevel 0 for every $1 == 1, which turned a child that died
            # with 1603 into "update succeeded" for the only reader of that
            # code, the auto-updater. Elevation ACCEPTANCE and installation
            # OUTCOME are two different answers and both are reported.
            StrCpy $OrgUpgradeElevateAttempts "0"
orgtreeSilentElevateAttempt:
            IntOp $OrgUpgradeElevateAttempts $OrgUpgradeElevateAttempts + 1
            # Written BEFORE the prompt for the same reason as the manual path:
            # from here the next thing that happens is a permission prompt, and
            # if it is declined this is the only process that can say so.
            !insertmacro OrgLog "elevation-requested" "silent update of an all-users installation in [$INSTDIR]; asking for administrator rights (attempt $OrgUpgradeElevateAttempts)"
            ShowWindow $HWNDPARENT ${SW_HIDE}
            !insertmacro UAC_RunElevated
            ${if} $0 == 0
            ${andif} $1 == 1
              ${if} $2 == 0
                !insertmacro OrgLog "elevation-child-succeeded" "the elevated instance ran the silent update and exited 0; this outer process is done"
                # ⚠ SAY SUCCESS EXPLICITLY. Quitting from .onInit exits with
                # code 2 by default — measured, not assumed: every other cell of
                # the fixture matrix in tools/test-installer-silent-elevation.mjs
                # exits 0 and only this one returned 2. On the SILENT path that
                # exit code is the auto-updater's only signal, so leaving the
                # default would report a successful handoff as a failed update
                # and invite a retry of an upgrade that already happened.
                SetErrorLevel 0
              ${else}
                # The child is the process that actually installed, so its code
                # is the update's result and it is passed through UNCHANGED.
                # Reporting 0 here is what hides a failed all-users update from
                # the updater; reporting a flat 2 would hide WHICH failure it
                # was (1603 and friends are the diagnosable part).
                !insertmacro OrgLog "elevation-child-failed" "the elevated instance ran and FAILED with exit code $2; the update did not complete and this outer process reports that code unchanged"
                SetErrorLevel $2
              ${endif}
              Quit
            ${endif}
            ${if} $0 == 0
            ${andif} $1 == 3
              # Non-admin credentials were typed into the prompt. The plugin's
              # documented answer to this is to ask again, so this is a retry
              # rather than a failure — but a BOUNDED one: an unbounded loop
              # would re-prompt a machine with no usable administrator account
              # forever, and this path is entered by an unattended update.
              ${if} $OrgUpgradeElevateAttempts < 2
                !insertmacro OrgLog "elevation-retry" "the credentials supplied were not an administrator account; asking again (attempt $OrgUpgradeElevateAttempts of 2)"
                Goto orgtreeSilentElevateAttempt
              ${endif}
              !insertmacro OrgLog "elevation-refused" "no administrator credentials were supplied in 2 attempts; nothing was changed"
              SetErrorLevel 2
              Quit
            ${endif}
            ${if} $0 == 0
            ${andif} $1 == 2
              # Already high-integrity. ${UAC_IsAdmin} answered otherwise a few
              # lines above, so this should be unreachable — but the plugin
              # defines the value, and the safe reading of "you are already
              # elevated" is to CONTINUE this process rather than quit it.
              !insertmacro OrgLog "elevation-unnecessary" "UAC reports this process is already elevated; continuing without starting a child"
              Goto orgtreeSilentElevateDone
            ${endif}
            # No MessageBox on any of these paths. SetSilent is already in
            # force, so /SD would auto-dismiss it unseen; the exit code is what
            # the updater can act on, and the log is what a person can read
            # afterwards.
            ${if} $0 == 1223
              !insertmacro OrgLog "elevation-declined" "the Windows permission prompt was DISMISSED by the user (1223); nothing was changed"
            ${elseif} $0 == 0
              # $0 == 0 with $1 neither 1, 2 nor 3 means $1 == 0: the operating
              # system does not support UAC at all, so there is nothing to
              # elevate to.
              !insertmacro OrgLog "elevation-unavailable" "this system reports no UAC support, so an all-users update cannot be elevated; nothing was changed"
            ${else}
              !insertmacro OrgLog "elevation-error" "could not request administrator approval, Windows error $0; nothing was changed"
            ${endif}
            SetErrorLevel 2
            Quit
orgtreeSilentElevateDone:
          ${endif}
        ${else}
          !insertmacro OrgLog "elevation-held" "silent update already has administrator rights; no prompt needed"
        ${endif}
      ${endif}
    !endif
    !endif
  ${endif}
!macroend
!macro customFinishPage
  !ifndef BUILD_UNINSTALLER
    # Fresh and Advanced setup retain electron-builder's normal Finish page.
    # An accepted Upgrade reaches this page only after install bookkeeping has
    # succeeded; schedule a post-exit launch and skip the extra click.
    !define MUI_PAGE_CUSTOMFUNCTION_PRE orgtreeUpgradeFinishPagePre
    !insertmacro MUI_PAGE_FINISH

    # The dispatch is its own function so the compiled upgrade harness can
    # drive it against the REAL StdUtils.dll: the 2.1.4-RC4 field failure
    # ("error ok") lived exactly here, and a fixture that stubs the plugin
    # can never see it again.
    Function orgtreeDispatchUpgradeRelaunch
      # Start under the original user token, including for an elevated
      # all-users inner instance. The helper waits for this exact installer PID
      # before launching the newly installed desktop.
      #
      # ⚠ THE HOST MUST STAY GUI-SUBSYSTEM. ExecShellAsUser is a ShellExecute,
      # and ShellExecute cannot pass CREATE_NO_WINDOW, so Windows allocates a
      # console for any CONSOLE-SUBSYSTEM target. This line used to name
      # powershell.exe, which is console-subsystem, and on Windows 11 with
      # Windows Terminal as the default terminal that console appeared as a
      # visible WindowsTerminal.exe + OpenConsole.exe pair one second before the
      # upgraded app started, then sat there orphaned after PowerShell exited.
      #
      # -WindowStyle Hidden WAS ALREADY IN THOSE ARGUMENTS AND DID NOT PREVENT
      # IT: that is a PowerShell preference applied after PowerShell starts,
      # acting on its own console window, and under Windows Terminal there is no
      # classic window of its own to hide. Do not attempt to fix a recurrence by
      # adding hiding flags — hiding a console after it exists is the defect.
      #
      # ⚠ AND THE HOST MUST NOT BE SOMETHING POLICY CAN SWITCH OFF. The first
      # fix for the console used wscript.exe, which is GUI-subsystem and ships
      # with Windows — but Windows Script Host is disabled by policy on plenty
      # of managed machines, and a disabled WSH cannot run the script that would
      # have reported that it could not run. The dispatch would answer "ok", the
      # Finish page would be skipped, and nothing would start or be logged.
      #
      # pythonw.exe is the runtime this application already ships and already
      # needs in order to run at all, so on a machine where a relaunch means
      # anything it is present — and unlike a policy switch, its absence is a
      # FILE that can be checked, which is what the guard below does before this
      # process commits to skipping the Finish page. It is GUI-subsystem, so no
      # console is ever created, and it reaches the real Win32 process APIs, so
      # the helper waits on a handle instead of interrogating WMI.
      #
      # tests/installer-upgrade.test.mjs reads the PE subsystem byte of the
      # executable this line names and fails if it is console-subsystem, so a
      # regression here is caught without running an installer.
      StrCpy $OrgUpgradeRelaunchHost "$INSTDIR\resources\engine\runtime\pythonw.exe"
      ${ifNot} ${FileExists} "$OrgUpgradeRelaunchHost"
        # Checked BEFORE the dispatch, because the only thing worse than not
        # relaunching is skipping the Finish page and then not relaunching: the
        # user is left with no application and no button that would have started
        # one. Falling through leaves the normal Finish page in place.
        !insertmacro OrgLog "relaunch-host-missing" "no runtime host at [$OrgUpgradeRelaunchHost]; leaving the Finish page in place instead of scheduling a relaunch"
        Return
      ${endif}
      System::Call 'kernel32::GetCurrentProcessId() i .r0'
      StrCpy $OrgUpgradeRelaunchReadyMarker "$OrgUpgradeRelaunchDir\relaunch-started.txt"
      Delete "$OrgUpgradeRelaunchReadyMarker"
      StrCpy $OrgUpgradeRelaunchArgs '"$OrgUpgradeRelaunchDir\installer-relaunch.py" $0 "$OrgUpgradeExe" "$OrgUpgradeRelaunchReadyMarker"'
      ${StdUtils.ExecShellAsUser} $1 "$OrgUpgradeRelaunchHost" "open" "$OrgUpgradeRelaunchArgs"
      # StdUtils.ExecShellAsUser answers with a TOKEN, not an exit code —
      # testing it against 0 is the 2.1.4-RC4 field failure: the call
      # SUCCEEDED, returned "ok", and "ok" != 0 walked the success into the
      # error dialog as "(error ok)" while the Finish page stayed up.
      #   ok       — dispatched under the original (non-elevated) user
      #   fallback — the impersonation path was unavailable and the helper
      #              was dispatched with this process's own rights instead;
      #              the launch still happens exactly once after Setup exits
      # Anything else is a real failure and is shown verbatim.
      ${if} $1 == "ok"
      ${orif} $1 == "fallback"
        # ⚠ A SUCCESSFUL DISPATCH IS NOT A RUNNING HELPER. The token says the
        # shell accepted the request, nothing more. The helper writes its ready
        # marker before it begins waiting, so this is the point where "it
        # started" stops being an assumption — and it is the check that makes
        # this path safe against a host that cannot execute, whatever the reason.
        Call orgtreeAwaitUpgradeRelaunchHelper
        ${if} $OrgUpgradeRelaunchAcknowledged == "1"
          StrCpy $OrgUpgradeRelaunchScheduled "1"
          !insertmacro OrgLog "relaunch-scheduled" "the launch helper acknowledged; the replaced application will be started once this installer exits"
          StrCpy $OrgUpgradeRelaunchReady "1"
        ${else}
          !insertmacro OrgLog "relaunch-unacknowledged" "the launch helper was dispatched (result $1) but never acknowledged; keeping the Finish page so the user can start Orgtree"
          MessageBox MB_OK|MB_ICONEXCLAMATION "The upgrade completed, but Orgtree could not confirm that it will start after Setup closes. Use Finish to start it, or its shortcut." /SD IDOK
        ${endif}
      ${else}
        !insertmacro OrgLog "relaunch-dispatch-failed" "the launch helper could not be dispatched (result $1); keeping the Finish page"
        MessageBox MB_OK|MB_ICONEXCLAMATION "The upgrade completed, but Orgtree could not be scheduled to start after Setup closes (result: $1). You can start Orgtree from its shortcut." /SD IDOK
      ${endif}
    FunctionEnd

    # The acceptance handshake. Bounded by design: this runs on the Finish page
    # of an upgrade the user is waiting on, so it may cost a moment and must not
    # cost more than one. A helper that has not written its marker within this
    # window is treated as not running, which keeps the Finish page — the
    # conservative direction, because the alternative leaves the user with no
    # application and no button.
    Function orgtreeAwaitUpgradeRelaunchHelper
      StrCpy $OrgUpgradeRelaunchAcknowledged "0"
      StrCpy $R5 0
      ${do}
        ${if} ${FileExists} "$OrgUpgradeRelaunchReadyMarker"
          StrCpy $OrgUpgradeRelaunchAcknowledged "1"
          ${break}
        ${endif}
        Sleep 100
        IntOp $R5 $R5 + 1
      ${loopUntil} $R5 >= 50
    FunctionEnd

    Function orgtreeScheduleUpgradeRelaunch
      StrCpy $OrgUpgradeRelaunchReady "0"
      ${if} $OrgUpgradeRelaunchScheduled == "1"
        StrCpy $OrgUpgradeRelaunchReady "1"
        Return
      ${endif}
      # A silent/unattended invocation must not acquire this interactive
      # upgrade relaunch path.
      ${if} ${Silent}
        Return
      ${endif}
      ${if} $OrgUpgradeRelaunchPrepared != "1"
        Return
      ${endif}
      Call orgtreeDispatchUpgradeRelaunch
    FunctionEnd

    Function orgtreePrepareUpgradeRelaunch
      StrCpy $OrgUpgradeRelaunchPrepared "0"
      System::Call 'kernel32::GetCurrentProcessId() i .r0'
      StrCpy $OrgUpgradeRelaunchDir "$TEMP\OrgtreeInstallerRelaunch-$0"
      # Filesystem instructions inherit NSIS's process-wide Error flag. The
      # upgrade probe and page flow legitimately perform optional reads before
      # reaching this function, so stale Errors must not turn a successful
      # extraction into a destructive-looking preparation failure.
      ClearErrors
      CreateDirectory $OrgUpgradeRelaunchDir
      ${if} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The upgrade could not prepare its post-Setup launch helper. Nothing has been changed." /SD IDOK
        Return
      ${endif}
      ClearErrors
      CopyFiles /SILENT "$PLUGINSDIR\installer-relaunch.py" $OrgUpgradeRelaunchDir
      ${if} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The upgrade could not prepare its post-Setup launch helper. Nothing has been changed." /SD IDOK
        Return
      ${endif}
      StrCpy $OrgUpgradeRelaunchPrepared "1"
    FunctionEnd

    Function orgtreeUpgradeFinishPagePre
      ${if} $OrgUpgradeSelected == "1"
        Call orgtreeScheduleUpgradeRelaunch
        ${if} $OrgUpgradeRelaunchReady == "1"
          # Finish is the final page, so its normal page-pre skip closes the
          # successful upgrade without presenting Start Orgtree/Finish.
          Abort
        ${endif}
      ${endif}
    FunctionEnd
  !endif
!macroend

# ---------------------------------------------------------------- installer log
# WHY THIS EXISTS. A 2.1.3 → 2.1.4 update failed in the field, twice on one
# machine. The application's own log proved what the APPLICATION did — attempt,
# layout, engine observed stopped, installer launched — and then said nothing,
# because from that point everything happens inside this installer and the
# installer left nothing behind. The one diagnostic it did write
# (orgtreeCloseForUpgrade's helper log) never ran on the silent path. So the
# investigation could not say which internal branch ended the run, and the
# leading hypothesis was later refuted by measurement, leaving the incident
# unexplained. This is the instrument that would have answered it.
#
# ⚠ APPENDED AS EACH STAGE COMPLETES, NEVER ASSEMBLED AND FLUSHED AT EXIT. The
# failure being diagnosed is an installer that stops partway; a log written at
# the end records nothing in exactly the case it exists for, and "last completed
# stage" only means anything if each stage was committed when it finished. Every
# call here opens, writes one line, and closes.
#
# ⚠ NOT IN $PLUGINSDIR. That directory is NSIS's private temporary plugin
# folder and is removed when the installer exits, which is half of why nothing
# survived last time. $EXEDIR is preferred: it is where Setup itself sits, so for
# an updater run it is the pending-download folder the application already knows
# the path of, and it belongs to the invoking user no matter which account
# approved elevation. $TEMP is the fallback when Setup was launched from
# somewhere unwritable.
#
# WHAT IS RECORDED: the received command line, the destination as parsed, the
# install scope, whether this process is elevated or an elevated inner instance,
# the elevation OUTCOME including the exact refusal, meaningful stages, the exit
# code where one is set, and the relaunch. No credentials and no user content —
# paths and switches only, which is what the application log already carries.
!define ORGTREE_LOG_MAX_BYTES 262144
!macro OrgLog stage detail
  StrCpy $OrgLogStage "${stage}"
  StrCpy $OrgLogDetail "${detail}"
  Call orgtreeInstallerLog
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    # OrgLogPath/OrgLogStage/OrgLogDetail are declared at the top of this file,
    # not here: this macro expands after the first OrgLog expansion.
    # Defined at top level so preInit can call it: preInit runs inside .onInit
    # and cannot declare functions, and it is also the earliest point in the
    # whole run — which is where the first line has to be written, because
    # anything later is after something that can already quit or be declined.
    Function orgtreeInstallerLog
      Push $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      Push $6
      Push $7
      ${if} $OrgLogPath == "-"
        # A previous call found nowhere writable. Never ask the filesystem again.
        Goto orgLogDone
      ${endif}
      ${if} $OrgLogPath == ""
        StrCpy $OrgLogPath "$EXEDIR\orgtree-installer.log"
        ClearErrors
        FileOpen $0 "$OrgLogPath" a
        ${if} ${errors}
          StrCpy $OrgLogPath "$TEMP\orgtree-installer.log"
          ClearErrors
          FileOpen $0 "$OrgLogPath" a
          ${if} ${errors}
            StrCpy $OrgLogPath "-"
            Goto orgLogDone
          ${endif}
        ${endif}
        # BOUNDED, and rotated on the FIRST write of a run rather than mid-run,
        # so a single installer's own lines are never split across a rotation.
        FileSeek $0 0 END $1
        ${if} $1 > ${ORGTREE_LOG_MAX_BYTES}
          FileClose $0
          Delete "$OrgLogPath"
          ClearErrors
          FileOpen $0 "$OrgLogPath" a
          ${if} ${errors}
            StrCpy $OrgLogPath "-"
            Goto orgLogDone
          ${endif}
        ${endif}
      ${else}
        ClearErrors
        FileOpen $0 "$OrgLogPath" a
        ${if} ${errors}
          # Transient: do not latch. A later stage may still be recordable, and
          # losing one line is better than losing the rest of the run.
          Goto orgLogDone
        ${endif}
        FileSeek $0 0 END
      ${endif}
      ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $R9
      FileWrite $0 "$4-$3-$2 $6:$7:$R9 [$OrgLogStage] $OrgLogDetail$\r$\n"
      FileClose $0
      orgLogDone:
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd
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
            !insertmacro OrgLog "exit" "stopped before the boot preflight because Orgtree could not be confirmed closed; nothing was changed"
            Quit
          ${endif}
        ${endif}
        # NO ELEVATION HERE — this is the 2.1.3-RC4 field failure.
        #
        # This section used to call UAC_RunElevated at exactly this point.
        # That starts a second complete installer wizard and blocks this one
        # until it finishes, and because this window was never hidden the user
        # was left staring at an "Installing" page stopped at 3% with the text
        # "Orgtree is closed; continuing the upgrade." and a second Setup
        # window behind it. Nothing was ever written, and it never recovered.
        # The user confirmed the second window; the boot task being left
        # enabled confirms this section never got past this line.
        #
        # Elevation belongs at install-mode selection, where electron-builder
        # puts it and where customInstallMode now performs it. Arriving here
        # without administrator rights is therefore a defect in that ordering,
        # not a situation a user can be in — so it is named and stops, rather
        # than silently opening another installer.
        ${ifNot} ${UAC_IsAdmin}
          DetailPrint "Boot preflight reached without administrator rights."
          !insertmacro OrgLog "exit" "exit code 2: the boot preflight was reached without administrator rights, which is an ordering defect rather than a user situation"
          MessageBox MB_OK|MB_ICONSTOP "Setup does not have the administrator rights it needs to update the Orgtree boot startup entry.$\r$\nThe existing installation has not been changed." /SD IDOK
          SetErrorLevel 2
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
  # The one line that says the files and registry work actually completed. Its
  # ABSENCE after the earlier stages is the shape of the reported incident.
  !insertmacro OrgLog "install-complete" "files and registry written for [$INSTDIR] at version ${VERSION}"
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
