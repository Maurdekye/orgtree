# Orgtree boot-engine task lifecycle for the ALL-USERS installer.
#
# The task mirrors tools/register-boot-engine.ps1: S4U ("/NP", no stored
# password) as the installing identity, "at system startup", limited run
# level. Everything is guarded to $installMode == "all" — current-user
# installs keep today's login-item behavior and never see a machine task.
#
# customInit runs after initMultiUser in BOTH the outer instance and the
# elevated inner instance that actually copies files, so the running boot
# engine is stopped (releasing its file locks under $INSTDIR) before
# replacement; a non-elevated attempt failing is harmless because the
# elevated instance repeats it. customUnInstall runs before file removal;
# during an update (${isUpdated}) it only stops the task so registration
# survives, and the fresh customInstall re-registers with the new paths and
# restarts it only when it existed before — a first install registers without
# starting, avoiding a root-lock race with the app the installer launches,
# and the first boot picks it up.

!macro customInit
  Var /GLOBAL BootTaskExisted
  Var /GLOBAL BootOperator
  # Recorded in EVERY instance; the elevated inner instance later replaces
  # its own value with the OUTER instance's, so the task always runs as the
  # operator who launched the installer, never as an alternate admin account
  # that merely approved the UAC prompt.
  ReadEnvStr $R1 USERDOMAIN
  ReadEnvStr $R2 USERNAME
  StrCpy $BootOperator "$R1\$R2"
  StrCpy $BootTaskExisted "0"
  nsExec::Exec 'schtasks /Query /TN "Orgtree Background Engine"'
  Pop $0
  ${if} $0 == 0
    StrCpy $BootTaskExisted "1"
    nsExec::Exec 'schtasks /End /TN "Orgtree Background Engine"'
    Pop $0
  ${endif}
!macroend

!macro customInstall
  ${if} $installMode == "all"
    ${if} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_GetGlobalVar $BootOperator
    ${endif}
    nsExec::Exec 'schtasks /Create /F /NP /RL LIMITED /SC ONSTART /RU "$BootOperator" /TN "Orgtree Background Engine" /TR "$\"$INSTDIR\resources\engine\runtime\python.exe$\" $\"$INSTDIR\resources\engine\service_host.py$\""'
    Pop $0
    DetailPrint "Orgtree boot engine task registration for $BootOperator: $0"
    ${if} $BootTaskExisted == "1"
      nsExec::Exec 'schtasks /Run /TN "Orgtree Background Engine"'
      Pop $0
      DetailPrint "Orgtree boot engine restart after update: $0"
    ${endif}
  ${endif}
!macroend

!macro customUnInstall
  ${if} $installMode == "all"
    nsExec::Exec 'schtasks /End /TN "Orgtree Background Engine"'
    Pop $0
    ${ifNot} ${isUpdated}
      nsExec::Exec 'schtasks /Delete /F /TN "Orgtree Background Engine"'
      Pop $0
    ${endIf}
  ${endif}
!macroend
