# The LOCAL DEVELOPMENT channel's installer include, pointed at by
# tools/dev-build.mjs (npm run package:dev). Same installer sources as the
# release channel with the dev guard armed: a development install is per-user
# only, so it can never reach the all-users paths where the published
# install's boot-engine task and HKLM uninstall entry live.
!define ORGTREE_DEV_CHANNEL
!include "${PROJECT_DIR}\build\installer.nsh"
