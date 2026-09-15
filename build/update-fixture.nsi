; orgtree-update-fixture.exe — THE HARMLESS UPDATE FIXTURE.
;
; This is the ONE binary both supported upgrade entry points target:
;   1. the in-app Update button's self-update handoff, which substitutes this
;      for the downloaded installer on a build composed to permit it, and
;   2. the manual installer Upgrade route, which is this file, launched by hand.
;
; Because it is the same file reached the same way, the two routes' arguments,
; parsed destination, process ancestry, visibility and exit behaviour can be
; compared by diffing two receipts rather than by argument.
;
; ⚠ IT INSTALLS NOTHING. No Section body runs — it quits in .onInit — so no file
; is written to $INSTDIR, no registry key is touched, no elevation is requested
; and no process is started. It records what it was handed and exits 0. That is
; what makes it safe to route a real update attempt into.
;
; ⚠ IT IS SILENT AND WINDOWLESS. SilentInstall silent, no pages, no MessageBox.
; The incident this ticket exists for was a console appearing during an update,
; so a fixture that flashed one would be measuring the wrong thing.
;
; THE CONTRACT IT HONOURS is the real installer's:
;   --updated /S --force-run /D=<directory>
; with /D= LAST and unquoted by the sender.
;
; ⚠ THE DESTINATION IS REPORTED AS $INSTDIR, WHICH IS THE POINT. NSIS's own
; runtime is what applies /D=, and assignment to $INSTDIR sanitises the value as
; a filename — that is the mechanism the 2.1.3 -> 2.1.4 incident turned on, and
; the reason an earlier trailing-quote hypothesis was refuted. A fixture that
; re-parsed the command line itself would report what SOME parser thinks, not
; what the installer would actually have used. The raw command line is recorded
; beside it so both halves of that comparison are in one receipt.

Unicode true
Name "Orgtree update fixture"
; The output path is a build decision, so the builder supplies it with
; /DOUTFILE=<path>. A /XOutFile command would be overridden by this script's own
; OutFile line, because makensis runs command-line commands BEFORE the script.
!ifndef OUTFILE
  !define OUTFILE "orgtree-update-fixture.exe"
!endif
OutFile "${OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow

!include LogicLib.nsh

Var Receipt
Var Raw
Var LingerMs

; The receipt goes beside this executable, the way the real installer's own log
; chooses its location ($EXEDIR). ORGTREE_UPDATE_FIXTURE_RECEIPT overrides that
; so a harness can put it somewhere it controls.
; ⚠ THE RAW COMMAND LINE IS CAPTURED IN .onInit, THE RECEIPT IS WRITTEN IN THE
; SECTION, and the split is not stylistic. NSIS applies /D= to $INSTDIR AFTER
; .onInit returns — measured here, not assumed: writing the receipt from .onInit
; recorded an empty $INSTDIR while the same run in the Section recorded the real
; destination. Reporting an empty destination as the parsed one would have been
; a fixture that lies about the exact field the 2.1.3 -> 2.1.4 incident turned on.
Function .onInit
  ReadEnvStr $Receipt "ORGTREE_UPDATE_FIXTURE_RECEIPT"
  ${If} $Receipt == ""
    StrCpy $Receipt "$EXEDIR\orgtree-update-fixture-receipt.txt"
  ${EndIf}

  ; The RAW command line, not a re-quoted reconstruction: the quoting Windows
  ; applies on the way is then visible in the receipt rather than inferred.
  System::Call 'kernel32::GetCommandLine() t .r0'
  StrCpy $Raw $0
FunctionEnd

; ⚠ THIS SECTION WRITES THE RECEIPT AND NOTHING ELSE. No File, no WriteRegStr,
; no CreateDirectory, no Exec, no SetOutPath — $INSTDIR is READ and never
; created. That is the whole safety argument for pointing a real update attempt
; at this binary.
Section
  ; ⚠ AN OBSERVABLE LIFETIME, BECAUSE THE PROOF SAMPLES A PROCESS TABLE.
  ; A fixture that returns instantly is never caught running, which reads
  ; exactly like an installer that died on launch. The receipt tells those
  ; apart after the fact, and this lets the OTHER half be rehearsed too: with
  ; ORGTREE_UPDATE_FIXTURE_LINGER_MS set, the fixture is alive long enough to
  ; be seen, which is the path a real installer takes. Default 0 keeps the
  ; fast completion as the default case.
  ReadEnvStr $LingerMs "ORGTREE_UPDATE_FIXTURE_LINGER_MS"
  ${If} $LingerMs != ""
    Sleep $LingerMs
  ${EndIf}
  FileOpen $9 "$Receipt" w
  FileWrite $9 "[fixture] orgtree update fixture ran; nothing was installed$\r$\n"
  FileWrite $9 "[fixture-cmdline] $Raw$\r$\n"
  FileWrite $9 "[fixture-instdir] $INSTDIR$\r$\n"
  FileWrite $9 "[fixture-exedir] $EXEDIR$\r$\n"
  ${If} ${Silent}
    FileWrite $9 "[fixture-silent] yes$\r$\n"
  ${Else}
    FileWrite $9 "[fixture-silent] no$\r$\n"
  ${EndIf}
  FileClose $9
  SetErrorLevel 0
SectionEnd
