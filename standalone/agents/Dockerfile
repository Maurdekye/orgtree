# The "agents" variant of the standalone engine image: the plain image plus
# what agents need to run in it (docs/standalone-engine.md, "The agents image"):
#   - Codex CLI (@openai/codex, Apache-2.0), pinned, in the image;
#   - Claude Code, pinned: by default NOT in the image. Its licence reserves
#     all rights, so the image carries only an integrity-pinned lockfile and
#     the entrypoint installs exactly that version from npm on the first start
#     (CLAUDE_CODE_INSTALL=first-start). CLAUDE_CODE_INSTALL=image puts it in
#     the image instead, for a publisher whose Anthropic terms allow that;
#   - Node.js (for the CLIs' npm packages), the OpenSSH client with a
#     git-over-ssh default, python3, curl and the Docker CLI;
#   - auto-update off for both CLIs, and a healthcheck that needs no Node.js.
# Built on the plain image of the same release, so the engine is the same
# binary (the release CI checks its hash):
#   docker build -f standalone/agents/Dockerfile \
#     --build-arg BASE=ghcr.io/maurdekye/orgtree-engine:<version> standalone/agents
ARG BASE=ghcr.io/maurdekye/orgtree-engine:latest
ARG NODE_IMAGE=node:22.23.4-trixie-slim

FROM ${NODE_IMAGE} AS node

FROM ${BASE}
USER root
ARG CLAUDE_CODE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.1
ARG CLAUDE_CODE_INSTALL=first-start
# Node.js and npm from the official image (Debian's nodejs is 20; Claude Code needs 22+)
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY agents-entrypoint.sh /usr/local/bin/orgtree-agents-entrypoint
COPY healthcheck.sh /usr/local/bin/orgtree-healthcheck
RUN set -eux; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssh-client python3 curl docker-cli; \
    rm -rf /var/lib/apt/lists/*; \
    chmod 0755 /usr/local/bin/orgtree-agents-entrypoint /usr/local/bin/orgtree-healthcheck; \
    # git over SSH out of the box: GitHub's published host keys are preinstalled; other
    # hosts are accepted on first use and remembered in ~/.ssh/known_hosts (HOME is on
    # the data volume); a changed key is still refused. Keys go in ~/.ssh as usual.
    printf 'Host *\n    StrictHostKeyChecking accept-new\n' > /etc/ssh/ssh_config.d/50-orgtree.conf; \
    curl -fsS https://api.github.com/meta | python3 -c 'import json,sys; [print("github.com", k) for k in json.load(sys.stdin)["ssh_keys"]]' > /etc/ssh/ssh_known_hosts; \
    test -s /etc/ssh/ssh_known_hosts; \
    # Codex: in the image, root-owned (it cannot update itself)
    npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}"; \
    codex="$(find /usr/local/lib/node_modules/@openai/codex -type f -name codex -path '*/vendor/*' -perm -u+x | head -n1)"; \
    test -n "$codex"; ln -s "$codex" /usr/local/bin/codex-native; \
    # Claude Code: an integrity-pinned lockfile (metadata only, no package bytes) ...
    mkdir -p /opt/orgtree/claude-code; cd /opt/orgtree/claude-code; \
    printf '{"name":"orgtree-claude-code","private":true,"dependencies":{"@anthropic-ai/claude-code":"%s"}}\n' "$CLAUDE_CODE_VERSION" > package.json; \
    npm install --package-lock-only --no-fund --no-audit; \
    grep -q '"integrity"' package-lock.json; \
    # ... and, only when asked, the package itself
    if [ "$CLAUDE_CODE_INSTALL" = image ]; then \
      npm ci --no-fund --no-audit; ln -s /opt/orgtree/claude-code/node_modules/.bin/claude /usr/local/bin/claude; \
    else \
      ln -s /data/agent-tools/claude-code/node_modules/.bin/claude /usr/local/bin/claude; \
    fi; \
    printf 'CLAUDE_CODE_VERSION=%s\nCODEX_VERSION=%s\nCLAUDE_CODE_INSTALL=%s\n' "$CLAUDE_CODE_VERSION" "$CODEX_VERSION" "$CLAUDE_CODE_INSTALL" > /opt/orgtree/agents.env; \
    rm -rf /root/.npm /tmp/*; \
    mkdir -p /data/home; chown -R orgtree:orgtree /data
# The same package-level description as the plain image: GHCR shows the
# last pushed tag's description on the package page.
LABEL org.opencontainers.image.title="orgtree-engine (agents)" \
      org.opencontainers.image.description="Runs Orgtree orgs headless, without the desktop app: the Orgtree engine with its own PostgreSQL 17 behind an authenticated HTTP, WebSocket and MCP API. Optional: the desktop app works without it. Tags <version> and latest are the plain engine; <version>-agents and latest-agents add Claude Code, Codex, Node.js, ssh, python3 and the Docker CLI for agents running inside. Docs: https://github.com/Maurdekye/orgtree/blob/main/docs/standalone-engine.md#the-orgtree-engine-package" \
      org.opencontainers.image.url="https://github.com/Maurdekye/orgtree" \
      org.opencontainers.image.documentation="https://github.com/Maurdekye/orgtree/blob/main/docs/standalone-engine.md#the-orgtree-engine-package" \
      dev.orgtree.claude-code.version="${CLAUDE_CODE_VERSION}" \
      dev.orgtree.claude-code.install="${CLAUDE_CODE_INSTALL}" \
      dev.orgtree.codex.version="${CODEX_VERSION}"
USER orgtree
# HOME on the data volume: the default ~/.claude, ~/.codex, ~/.ssh and
# ~/.gitconfig survive a new container. Auto-update off for both CLIs.
ENV HOME=/data/home \
    ORGTREE_CLAUDE_BIN=/usr/local/bin/claude \
    ORGTREE_CODEX_BIN=/usr/local/bin/codex-native \
    CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    CODEX_VERSION=${CODEX_VERSION} \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["orgtree-healthcheck"]
ENTRYPOINT ["orgtree-agents-entrypoint"]
CMD ["standalone"]
