//! wmux collab rendezvous server.
//!
//! Skeleton for Phase 0 of the multiplayer design. Currently exposes a single
//! `/health` endpoint; signaling, token mint/redeem, and audit-log endpoints
//! land in subsequent PRs (0.3 / 0.4 of the phase plan).

use std::net::SocketAddr;

use axum::{routing::get, Json, Router};
use serde::Serialize;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    protocol_version: u32,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        protocol_version: collab_proto::PROTOCOL_VERSION,
    })
}

fn router() -> Router {
    Router::new()
        .route("/health", get(health))
        .layer(TraceLayer::new_for_http())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let addr: SocketAddr = std::env::var("COLLAB_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".to_string())
        .parse()?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "collab-server listening");
    axum::serve(listener, router())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_returns_ok() {
        let response = router()
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let bytes = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["protocol_version"], collab_proto::PROTOCOL_VERSION);
    }
}
