# Builder stage — compiles the collab-server binary from the workspace.
FROM rust:1-slim AS builder
WORKDIR /build

# Workspace manifests first, for dep-graph caching.
COPY Cargo.toml Cargo.lock ./
COPY src-tauri/Cargo.toml src-tauri/Cargo.toml
COPY browser-helper/Cargo.toml browser-helper/Cargo.toml
COPY collab-proto/Cargo.toml collab-proto/Cargo.toml
COPY collab-server/Cargo.toml collab-server/Cargo.toml

# Sources for the crates this binary actually needs. Other workspace members
# are listed in the root Cargo.toml but are not required to build this bin.
COPY collab-proto/src collab-proto/src
COPY collab-server/src collab-server/src

RUN cargo build --release --bin collab-server \
    -p collab-server \
    --manifest-path collab-server/Cargo.toml

# Runtime stage — minimal Debian, no Rust toolchain.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/collab-server /usr/local/bin/collab-server

ENV COLLAB_BIND=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/collab-server"]
