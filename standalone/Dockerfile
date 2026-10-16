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
RUN cargo build --release --manifest-path engine/rs/Cargo.toml -p orgtree-engine --bin orgtree-engine

FROM debian:bookworm-slim
# PostgreSQL refuses to run as root, and the engine starts it as its own
# child, so the whole image runs as an unprivileged user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-15 ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /usr/sbin/nologin orgtree \
 && mkdir -p /data && chown orgtree:orgtree /data
COPY --from=build /src/engine/rs/target/release/orgtree-engine /usr/local/bin/orgtree-engine
USER orgtree
ENV ORGTREE_DATA=/data \
    ORGTREE_P03_PG_BIN=/usr/lib/postgresql/15/bin \
    ORGTREE_BIND=0.0.0.0 \
    ORGTREE_PORT=7430
VOLUME ["/data"]
EXPOSE 7430
ENTRYPOINT ["orgtree-engine", "standalone"]
