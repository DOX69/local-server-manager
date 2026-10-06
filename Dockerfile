FROM node:22-bookworm-slim AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM rust:1.90-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY --from=web-builder /app/web/dist ./web/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN groupadd --gid 10001 localdeck && useradd --uid 10001 --gid 10001 --no-create-home localdeck
COPY --from=builder /app/target/release/localdeck /usr/local/bin/localdeck
USER localdeck
EXPOSE 4780
ENTRYPOINT ["/usr/local/bin/localdeck"]
