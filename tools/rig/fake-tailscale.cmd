@echo off
rem The rig's fake Tailscale CLI (copied into each run as bin\tailscale.cmd;
rem the engine reaches it through ORGTREE_TAILSCALE_BIN, never a real one).
rem A proof scripts it with files in <data>\rig-home\rig-tailscale:
rem   status.json  what `tailscale status --json` prints (absent: the service
rem                is not running, like the real CLI's daemon error)
rem   login-url    what `tailscale login` prints as the sign-in address
rem Every call is appended to calls.log. Deleting bin\tailscale.cmd is
rem "Tailscale is not installed".
setlocal
set "D=%ORGTREE_FAKECLI_HOME%\rig-tailscale"
if not exist "%D%" mkdir "%D%"
echo %*>>"%D%\calls.log"
if /i "%~1"=="status" goto status
if /i "%~1"=="login" goto login
if /i "%~1"=="up" goto login
>&2 echo fake tailscale: unsupported command %*
exit /b 2

:status
if not exist "%D%\status.json" (
  >&2 echo failed to connect to local Tailscale daemon for status; Is Tailscale running?
  exit /b 1
)
type "%D%\status.json"
exit /b 0

:login
if exist "%D%\login-url" (
  echo.
  echo To authenticate, visit:
  echo.
  for /f "usebackq delims=" %%u in ("%D%\login-url") do echo 	%%u
  echo.
)
exit /b 0
