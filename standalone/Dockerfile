# Standalone Orgtree engine (docs/rust-engine/STANDALONE-ENGINE.md).
# Build from the repository root:
#   docker build -f standalone/Dockerfile -t orgtree-engine-standalone .
# Or use standalone/docker-compose.yml.
#
# The runtime image carries the engine and PostgreSQL only. Provider CLIs
# (Claude Code, Codex, ...) are NOT included yet: install and sign in to the
# ones you need in a derived image, or use API-key/OpenRouter accounts.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY engine/rs/Cargo.toml engine/rs/Cargo.lock engine/rs/
COPY engine/rs/orgtree-logged engine/rs/orgtree-logged
COPY engine/rs/orgtree-engine engine/rs/orgtree-engine
# Rust embeds templates/charters and the Changelog's release list with
# include_str!, and build.rs embeds the complete glossary and each stable
# release's notes. These are build inputs even though no UI is bundled.
COPY engine/docs/charters engine/docs/charters
COPY engine/docs/templates engine/docs/templates
COPY docs/skills docs/skills
COPY docs/releases.json docs/release-notes-*.md docs/
# The custom-apps example a template test parses with include_str!. The
# release build compiles no tests, but every include path is copied, so the
# stage never depends on where an include sits.
COPY docs/examples/apps/annotation-notes.orgtree-app docs/examples/apps/
ARG CARGO_BUILD_JOBS=1
ARG ORGTREE_BUILD_COMMIT=unknown
ARG CARGO_PROFILE_RELEASE_OPT_LEVEL=3
ARG CARGO_PROFILE_RELEASE_LTO=thin
ARG CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
RUN --mount=type=cache,target=/src/engine/rs/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    ORGTREE_RELEASE_BUILD=1 ORGTREE_BUILD_COMMIT="$ORGTREE_BUILD_COMMIT" \
    CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_OPT_LEVEL="$CARGO_PROFILE_RELEASE_OPT_LEVEL" \
    CARGO_PROFILE_RELEASE_LTO="$CARGO_PROFILE_RELEASE_LTO" \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS="$CARGO_PROFILE_RELEASE_CODEGEN_UNITS" \
    cargo build --locked --release --jobs "$CARGO_BUILD_JOBS" \
    --manifest-path engine/rs/Cargo.toml -p orgtree-engine --bin orgtree-engine \
 && cp engine/rs/target/release/orgtree-engine /orgtree-engine

FROM debian:trixie-slim
# PostgreSQL refuses to run as root, and the engine starts it as its own
# child, so the whole image runs as an unprivileged user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17 ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /usr/sbin/nologin orgtree \
 && mkdir -p /data && chown orgtree:orgtree /data
COPY --from=build /orgtree-engine /usr/local/bin/orgtree-engine
ARG ORGTREE_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision="$ORGTREE_IMAGE_REVISION"
USER orgtree
ENV ORGTREE_DATA=/data \
    ORGTREE_P03_PG_BIN=/usr/lib/postgresql/17/bin \
    ORGTREE_BIND=0.0.0.0 \
    ORGTREE_PORT=7430
VOLUME ["/data"]
EXPOSE 7430
ENTRYPOINT ["orgtree-engine", "standalone"]
