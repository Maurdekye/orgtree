@echo off
setlocal enabledelayedexpansion
rem THROWAWAY WS6 spike phase 2: run every check and control once, sequentially.
set BIN=E:\Libraries\Desktop\orgtree\.worktrees\p03-ws6-spike\artifacts\cargo-target\debug\orgtree-ws6-spike.exe
set ENVF=E:\Libraries\Desktop\orgtree\.worktrees\p03-ws6-spike\artifacts\devdb.env
set LOG=E:\Libraries\Desktop\orgtree\.worktrees\p03-ws6-spike\artifacts\phase2-run.log
set DEVDB=E:\Libraries\Desktop\orgtree\artifacts\p03-tools\devdb.cmd
echo === run started %DATE% %TIME% > "%LOG%"
call "%DEVDB%" up --agent p03-lead-opus55 --qual-logging off >> "%LOG%" 2>&1
for %%A in ("snapshot" "snapshot --control" "toast" "toast --control" "feedback" "feedback --control" "invalidate") do (
  echo --- %%~A >> "%LOG%"
  "%BIN%" --env "%ENVF%" %%~A >> "%LOG%" 2>&1
  echo exit=!ERRORLEVEL! >> "%LOG%"
)
call "%DEVDB%" down --agent p03-lead-opus55 >> "%LOG%" 2>&1
echo === run ended %DATE% %TIME% >> "%LOG%"
type "%LOG%" | findstr /B /C:"RESULT" /C:"CONTROL_EXECUTED" /C:"---" /C:"Error" /C:"==="
