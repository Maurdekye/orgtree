#!/usr/bin/env bash
# Puts a stand-in CLI where only the user's login shell finds it, as an npm user prefix
# does: the program in ~/.npm-global/bin, and the PATH line (as npm's docs give it) in the
# profile the login shell reads. The background engine's registration must carry that
# PATH, or the engine started at login cannot find the CLI.
# Usage: login-shell-cli.sh <name>
set -euo pipefail
name="$1" dir="$HOME/.npm-global/bin"
mkdir -p "$dir"
printf '#!/bin/sh\necho "%s 0.0.0 (CI stand-in)"\n' "$name" > "$dir/$name"
chmod +x "$dir/$name"
case "$(basename "${SHELL:-/bin/sh}")" in
  zsh) profile="$HOME/.zprofile" ;;
  bash) profile="$HOME/.profile"
        for f in .bash_profile .bash_login; do [ -f "$HOME/$f" ] && { profile="$HOME/$f"; break; }; done ;;
  *) profile="$HOME/.profile" ;;
esac
grep -qs 'npm-global/bin' "$profile" || printf '\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$profile"
if command -v "$name" >/dev/null 2>&1; then echo "note: this step's own PATH also has $name: $(command -v "$name")"; fi
echo "login shell ${SHELL:-(unset)}: the PATH line is in $profile; $name is at $dir/$name"
