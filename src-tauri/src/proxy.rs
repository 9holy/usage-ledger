//! Desktop loopback bridge for APIs that do not support browser CORS.
//!
//! Only the Tauri frontend can obtain the per-process token through IPC. Binding
//! the socket succeeds before setup returns, so an occupied port never receives
//! a user's upstream credentials. Each request carries its own target and auth.

use axum::{
    body::Bytes,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use std::{
    net::{SocketAddr, TcpListener},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tower_http::cors::{AllowHeaders, AllowOrigin, Any, CorsLayer};

/// Kept in sync with src/api/url.ts.
pub const PROXY_PORT: u16 = 18765;
const TARGET_HEADER: &str = "x-target-base";
const TOKEN_HEADER: &str = "x-proxy-token";
const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
static PROXY_TOKEN: OnceLock<String> = OnceLock::new();

struct ProxyState {
    client: OnceLock<reqwest::Client>,
    token: String,
    address: SocketAddr,
    max_request_bytes: usize,
}

#[tauri::command]
pub fn get_proxy_token() -> Result<String, String> {
    PROXY_TOKEN
        .get()
        .cloned()
        .ok_or_else(|| "Local API bridge is not available".into())
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Cannot initialize local API bridge: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn bind_listener(address: SocketAddr) -> Result<TcpListener, String> {
    let listener = TcpListener::bind(address)
        .map_err(|error| format!("Cannot bind local API bridge at {address}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    Ok(listener)
}

/// Setup gets a synchronous error if the bridge cannot own its socket.
pub fn spawn_proxy() -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], PROXY_PORT));
    let listener = bind_listener(address)?;
    let token = new_token()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Cannot start local API bridge: {error}"))?;
    let listener = {
        let _entered = runtime.enter();
        tokio::net::TcpListener::from_std(listener).map_err(|error| error.to_string())?
    };
    let state = Arc::new(ProxyState {
        client: OnceLock::new(),
        token: token.clone(),
        address,
        max_request_bytes: MAX_REQUEST_BYTES,
    });
    std::thread::Builder::new()
        .name("local-api-bridge".into())
        .spawn(move || {
            runtime.block_on(async move {
                if let Err(error) = axum::serve(listener, router(state)).await {
                    eprintln!("Local API bridge stopped: {error}");
                }
            })
        })
        .map_err(|error| format!("Cannot start local API bridge thread: {error}"))?;
    PROXY_TOKEN
        .set(token)
        .map_err(|_| "Local API bridge was already initialized".to_string())
}

fn allowed_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions)
        && matches!(origin, "http://127.0.0.1:5180" | "http://localhost:5180"))
}

fn router(state: Arc<ProxyState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| allowed_origin(origin)))
        .allow_methods(Any)
        // Authorization is a CORS non-wildcard header. Echo the explicit
        // preflight list so authenticated browser requests are admitted too.
        .allow_headers(AllowHeaders::mirror_request());
    Router::new()
        .route("/", any(forward))
        .route("/*path", any(forward))
        .with_state(state)
        .layer(cors)
}

fn authorized(headers: &HeaderMap, state: &ProxyState) -> bool {
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| !allowed_origin(origin))
    {
        return false;
    }
    // A correct token is required even for native clients without an Origin.
    // Keep the comparison independent of the matching prefix.
    let Some(token) = headers.get(TOKEN_HEADER) else {
        return false;
    };
    let provided = token.as_bytes();
    if provided.len() != state.token.len() {
        return false;
    }
    let different = provided
        .iter()
        .zip(state.token.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b));
    if different != 0 {
        return false;
    }
    // Reject DNS-rebinding hosts even if they resolve to our loopback listener.
    headers.get(header::HOST).is_none_or(|host| {
        host.to_str().ok().is_some_and(|host| {
            host == state.address.to_string()
                || host == format!("localhost:{}", state.address.port())
        })
    })
}

fn hop_by_hop(name: &str, headers: &HeaderMap) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) || headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case(name))
}

async fn forward(State(state): State<Arc<ProxyState>>, req: Request) -> Response {
    if !authorized(req.headers(), &state) {
        return api_error_response(StatusCode::FORBIDDEN, "Local API bridge access denied");
    }
    let target_base = match req
        .headers()
        .get(TARGET_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if !value.is_empty() => value.trim_end_matches('/'),
        _ => return no_target_response(),
    };
    let target = match reqwest::Url::parse(target_base) {
        Ok(target)
            if matches!(target.scheme(), "http" | "https")
                && target.host_str().is_some()
                && target.username().is_empty()
                && target.password().is_none()
                && target.query().is_none()
                && target.fragment().is_none() =>
        {
            target
        }
        _ => {
            return api_error_response(
                StatusCode::BAD_REQUEST,
                "Target must be an HTTP(S) base URL without credentials, query or fragment",
            )
        }
    };
    if matches!(target.host_str(), Some("127.0.0.1" | "localhost"))
        && target.port_or_known_default() == Some(state.address.port())
    {
        return api_error_response(
            StatusCode::BAD_REQUEST,
            "Local API bridge cannot proxy to itself",
        );
    }
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("");
    let url = format!("{}{path_and_query}", target.as_str().trim_end_matches('/'));
    if req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > state.max_request_bytes as u64)
    {
        return api_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Proxy request body exceeds 64 MiB",
        );
    }

    let (parts, body) = req.into_parts();
    let body_bytes: Bytes = match axum::body::to_bytes(body, state.max_request_bytes).await {
        Ok(body) => body,
        Err(_) => {
            return api_error_response(
                StatusCode::BAD_REQUEST,
                "Cannot read proxy request body (maximum 64 MiB)",
            )
        }
    };
    let mut forward_headers = HeaderMap::new();
    for (name, value) in &parts.headers {
        if matches!(
            name.as_str(),
            TARGET_HEADER | TOKEN_HEADER | "host" | "content-length"
        ) || hop_by_hop(name.as_str(), &parts.headers)
        {
            continue;
        }
        forward_headers.append(name.clone(), value.clone());
    }
    let client = match reqwest_client(&state.client) {
        Ok(client) => client,
        Err(error) => {
            return upstream_error_response(&format!("Cannot initialize upstream client: {error}"))
        }
    };
    let response = match client
        .request(parts.method, &url)
        .headers(forward_headers)
        .body(body_bytes)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return upstream_error_response(&format!(
                "Upstream request failed: {}",
                error.without_url()
            ))
        }
    };

    let mut out = Response::builder().status(response.status());
    for (name, value) in response.headers() {
        if name == header::CONTENT_LENGTH
            || name.as_str().starts_with("access-control-")
            || hop_by_hop(name.as_str(), response.headers())
        {
            continue;
        }
        out = out.header(name, value);
    }
    // Stream SSE/downloads immediately. Buffering the full response hid every
    // progress event and allowed an upstream to grow desktop memory without bound.
    out.body(axum::body::Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| upstream_error_response("Cannot construct upstream response"))
}

fn reqwest_client(cache: &OnceLock<reqwest::Client>) -> Result<reqwest::Client, reqwest::Error> {
    if let Some(client) = cache.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        // Account imports/refreshes and plugin operations allow 120–180 seconds
        // in the frontend. Give those quiet upstream operations room to finish;
        // this is an idle read limit, not a total deadline for an active SSE flow.
        .read_timeout(Duration::from_secs(300))
        .build()?;
    Ok(cache.get_or_init(|| client).clone())
}

fn api_error_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({"code": -1, "message": message}).to_string(),
    )
        .into_response()
}

fn no_target_response() -> Response {
    api_error_response(
        StatusCode::BAD_GATEWAY,
        "未配置连接目标(X-Target-Base 缺失),请先在连接页选择或新建连接",
    )
}

fn upstream_error_response(message: &str) -> Response {
    api_error_response(StatusCode::BAD_GATEWAY, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_port_is_pinned() {
        // 前端 url.ts 硬编码同端口,改动需两端同步。
        assert_eq!(PROXY_PORT, 18765);
        assert_eq!(TARGET_HEADER, "x-target-base");
    }

    #[test]
    fn no_target_response_is_502_with_api_error_shape() {
        let resp = no_target_response();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            resp.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .map(|v| v.to_str().unwrap_or("")),
            Some("application/json")
        );
    }

    #[test]
    fn upstream_error_response_carries_message() {
        let resp = upstream_error_response("转发失败: dns error");
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    /// reqwest client 必须可用且不跟重定向(否则重定向会丢 Authorization)。
    #[test]
    fn reqwest_client_builds_without_redirect() {
        let client = reqwest_client(&OnceLock::new()).expect("reqwest client must build");
        // 无公开 API 直接断言 redirect policy,但能构造即证明 rustls-tls feature 链路通。
        let _ = client;
    }

    #[tokio::test]
    async fn shared_client_reuses_connections_without_sharing_targets_or_authorization() {
        use axum::{extract::ConnectInfo, http::header, Json};

        async fn upstream(
            State(label): State<&'static str>,
            ConnectInfo(peer): ConnectInfo<SocketAddr>,
            req: Request,
        ) -> Response {
            if req.uri().path() == "/redirect" {
                return (StatusCode::FOUND, [(header::LOCATION, "/must-not-follow")])
                    .into_response();
            }
            Json(serde_json::json!({
                "target": label,
                "authorization": req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                "control": req.headers().get(TARGET_HEADER).is_some() || req.headers().get(TOKEN_HEADER).is_some(),
                "path": req.uri().to_string(),
                "peer": peer.port(),
            }))
            .into_response()
        }

        let mut servers = Vec::new();
        let mut targets = Vec::new();
        for label in ["first", "second"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            targets.push(format!("http://{}", listener.local_addr().unwrap()));
            let app = Router::new()
                .route("/*path", any(upstream))
                .with_state(label);
            servers.push(tokio::spawn(async move {
                axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
                .unwrap();
            }));
        }

        let cache = Arc::new(ProxyState {
            client: OnceLock::new(),
            token: "test-token".into(),
            address: SocketAddr::from(([127, 0, 0, 1], PROXY_PORT)),
            max_request_bytes: MAX_REQUEST_BYTES,
        });
        let mut replies = Vec::new();
        for (target, authorization) in [
            (0, Some("Bearer first")),
            (0, Some("Bearer changed")),
            (1, Some("Bearer second")),
            (0, None),
        ] {
            let mut req = Request::builder()
                .uri("/usage?scope=current")
                .header(TARGET_HEADER, &targets[target])
                .header(TOKEN_HEADER, "test-token");
            if let Some(authorization) = authorization {
                req = req.header(header::AUTHORIZATION, authorization);
            }
            let reply = forward(
                State(cache.clone()),
                req.body(axum::body::Body::empty()).unwrap(),
            )
            .await;
            assert_eq!(reply.status(), StatusCode::OK);
            let body = axum::body::to_bytes(reply.into_body(), usize::MAX)
                .await
                .unwrap();
            replies.push(serde_json::from_slice::<serde_json::Value>(&body).unwrap());
        }
        assert_eq!(
            replies
                .iter()
                .map(|r| r["authorization"].clone())
                .collect::<Vec<_>>(),
            vec![
                serde_json::json!("Bearer first"),
                serde_json::json!("Bearer changed"),
                serde_json::json!("Bearer second"),
                serde_json::Value::Null,
            ]
        );
        assert_eq!(
            replies
                .iter()
                .map(|r| r["target"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["first", "first", "second", "first"]
        );
        assert_eq!(replies[0]["peer"], replies[1]["peer"]);
        assert_eq!(replies[0]["peer"], replies[3]["peer"]);
        assert!(replies
            .iter()
            .all(|r| r["control"] == false && r["path"] == "/usage?scope=current"));
        let req = Request::builder()
            .uri("/redirect")
            .header(TARGET_HEADER, &targets[0])
            .header(TOKEN_HEADER, "test-token")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(forward(State(cache), req).await.status(), StatusCode::FOUND);
        for server in servers {
            server.abort();
        }
    }
    fn test_state(address: SocketAddr) -> Arc<ProxyState> {
        Arc::new(ProxyState {
            client: OnceLock::new(),
            token: "test-token".into(),
            address,
            max_request_bytes: 1024,
        })
    }

    #[test]
    fn occupied_port_fails_before_starting_the_bridge() {
        let first = bind_listener(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let address = first.local_addr().unwrap();
        let error = bind_listener(address).unwrap_err();
        assert!(error.contains("Cannot bind local API bridge"));
        assert!(error.contains(&address.to_string()));
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn bridge_rejects_missing_wrong_tokens_foreign_origins_and_rebinding_hosts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(test_state(address));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::new();
        let url = format!("http://{address}/test");
        for (origin, token) in [
            (Some("http://tauri.localhost"), None),
            (Some("http://tauri.localhost"), Some("wrong-token")),
            (Some("https://attacker.example"), Some("test-token")),
            (Some("null"), Some("test-token")),
            (None, None),
        ] {
            let mut request = client
                .get(&url)
                .header(TARGET_HEADER, "https://example.invalid");
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            if let Some(token) = token {
                request = request.header(TOKEN_HEADER, token);
            }
            assert_eq!(
                request.send().await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        // A native client may omit Origin, but still needs the nonce. Missing
        // target is checked only after authenticating, so this proves admission.
        for origin in [
            None,
            Some("tauri://localhost"),
            Some("http://tauri.localhost"),
            Some("https://tauri.localhost"),
        ] {
            let mut request = client.get(&url).header(TOKEN_HEADER, "test-token");
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            assert_eq!(
                request.send().await.unwrap().status(),
                StatusCode::BAD_GATEWAY
            );
        }
        let rebound = client
            .get(&url)
            .header(TOKEN_HEADER, "test-token")
            .header(header::HOST, "attacker.example")
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), StatusCode::FORBIDDEN);
        for (origin, allowed) in [
            ("tauri://localhost", true),
            ("http://tauri.localhost", true),
            ("https://attacker.example", false),
        ] {
            let response = client
                .request(reqwest::Method::OPTIONS, &url)
                .header(header::ORIGIN, origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "x-proxy-token,x-target-base,authorization",
                )
                .send()
                .await
                .unwrap();
            assert_eq!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .is_some(),
                allowed
            );
            if allowed {
                assert_eq!(
                    response
                        .headers()
                        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                        .unwrap(),
                    origin
                );
                let allowed_headers = response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .split(',')
                    .map(str::trim)
                    .collect::<Vec<_>>();
                for required in ["authorization", "x-proxy-token", "x-target-base"] {
                    assert!(
                        allowed_headers.contains(&required),
                        "missing explicit CORS permission for {required}"
                    );
                }
                // The frontend uses bearer/API-key headers, not browser cookies.
                assert!(response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                    .is_none());
            }
        }
        server.abort();
    }

    #[tokio::test]
    async fn invalid_or_oversized_request_bodies_are_never_forwarded_as_empty_requests() {
        let state = test_state(SocketAddr::from(([127, 0, 0, 1], PROXY_PORT)));
        for declared in [false, true] {
            let mut req = Request::builder()
                .method("POST")
                .uri("/write")
                .header(TARGET_HEADER, "http://127.0.0.1:1")
                .header(TOKEN_HEADER, "test-token");
            if declared {
                req = req.header(header::CONTENT_LENGTH, "1025");
            }
            let response = forward(
                State(state.clone()),
                req.body(axum::body::Body::from(vec![0u8; 1025])).unwrap(),
            )
            .await;
            assert_eq!(
                response.status(),
                if declared {
                    StatusCode::PAYLOAD_TOO_LARGE
                } else {
                    StatusCode::BAD_REQUEST
                }
            );
        }
        for target in [
            "file:///tmp/test",
            "http://user:password@example.invalid",
            "https://example.invalid/?target=wrong",
            "https://example.invalid/#ignored",
            "http://127.0.0.1:18765",
        ] {
            let req = Request::builder()
                .uri("/write")
                .header(TARGET_HEADER, target)
                .header(TOKEN_HEADER, "test-token")
                .body(axum::body::Body::empty())
                .unwrap();
            assert_eq!(
                forward(State(state.clone()), req).await.status(),
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn proxy_removes_all_hop_headers_but_preserves_security_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, X-Private-Hop"),
        );
        assert!(hop_by_hop("x-private-hop", &headers));
        assert!(hop_by_hop("upgrade", &headers));
        assert!(hop_by_hop("proxy-authorization", &headers));
        assert!(!hop_by_hop("authorization", &headers));
        assert!(!hop_by_hop("content-security-policy", &headers));
        assert!(!hop_by_hop("x-frame-options", &headers));
    }

    #[tokio::test]
    async fn sse_events_are_available_before_upstream_closes() {
        use std::io::{Read, Write};
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = format!("http://{}", upstream.local_addr().unwrap());
        let (release, wait_for_reader) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let (mut socket, _) = upstream.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'none'\r\nX-Frame-Options: DENY\r\nConnection: keep-alive, x-private-hop\r\nX-Private-Hop: strip-me\r\nTransfer-Encoding: chunked\r\n\r\nD\r\ndata: first\n\n\r\n").unwrap();
            if wait_for_reader.recv_timeout(Duration::from_secs(5)).is_ok() {
                socket.write_all(b"0\r\n\r\n").unwrap();
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(test_state(address));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut response = tokio::time::timeout(
            Duration::from_secs(2),
            reqwest::Client::new()
                .get(format!("http://{address}/events"))
                .header(TARGET_HEADER, target)
                .header(TOKEN_HEADER, "test-token")
                .send(),
        )
        .await
        .expect("response headers must not wait for stream EOF")
        .unwrap();
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap(),
            "default-src 'self'; frame-ancestors 'none'"
        );
        assert_eq!(
            response.headers().get(header::X_FRAME_OPTIONS).unwrap(),
            "DENY"
        );
        assert!(response.headers().get("x-private-hop").is_none());
        let first = tokio::time::timeout(Duration::from_secs(2), response.chunk())
            .await
            .expect("first SSE event must be forwarded immediately")
            .unwrap()
            .unwrap();
        assert_eq!(&first[..], b"data: first\n\n");
        release.send(()).unwrap();
        assert!(response.chunk().await.unwrap().is_none());
        writer.join().unwrap();
        server.abort();
    }
}
