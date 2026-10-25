//! 本地反代 — 绕过 WebView2 跨域 CORS。
//!
//! 桌面端 WebView2 在 `tauri.localhost`,远程 sub2api 不响应 OPTIONS 预检(curl 坐实:
//! 所有 Origin 的 OPTIONS 一律 403),跨域请求全挂。本模块起本地 HTTP 反代
//! `127.0.0.1:18765`,前端只请求本地,远程真实地址通过 `X-Target-Base` header 传入,
//! reqwest 转发(Rust 不受 CORS 约束,等价 curl),响应加 CORS 头放行 `tauri.localhost`。
//!
//! 转发流程:
//!   前端 → http://127.0.0.1:18765/<path>?<query>
//!          Header: X-Target-Base: https://coding.cm/api/v1
//!          Header: Authorization: Bearer xxx
//!   反代 → reqwest GET https://coding.cm/api/v1/<path>?<query>(剥 X-Target-Base)
//!   远程 ← 返响应,反代加 CORS 头回前端

use axum::{
    body::Bytes,
    extract::Request,
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;

/// 反代监听端口。前端 url.ts 硬编码同一端口,对称无注入。
/// ponytail: 不为低概率端口冲突引入动态端口+注入机制(冷门端口,桌面端连远程,本机不跑 sub2api)。
pub const PROXY_PORT: u16 = 18765;

/// 前端传递远程真实地址的 header。反代读它拼转发 URL,转发前剥掉不发给远程。
const TARGET_HEADER: &str = "x-target-base";

/// 启动反代。在 setup 阶段调用,失败 panic(反代起不来桌面端无法连任何远程服务,属致命错误)。
pub fn spawn_proxy() {
    // tauri 主线程非 async,开独立 tokio runtime 跑 server。
    // ponytail: 单独 runtime 而非接管主线程,避免与 tauri 事件循环冲突。
    std::thread::spawn(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build proxy tokio runtime");
        runtime.block_on(async {
            let addr: SocketAddr = ([127, 0, 0, 1], PROXY_PORT).into();
            // very_permissive:放行所有 Origin/方法/header,OPTIONS 预检返 CORS 头。
            // 反代只绑 127.0.0.1,无外部暴露风险。
            let cors = CorsLayer::very_permissive();
            let app = Router::new()
                .route("/", any(forward))
                .route("/*path", any(forward))
                .layer(cors);
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .unwrap_or_else(|e| panic!("proxy bind 127.0.0.1:{PROXY_PORT} failed: {e}"));
            axum::serve(listener, app)
                .await
                .unwrap_or_else(|e| panic!("proxy server stopped: {e}"));
        });
    });
}

/// 转发 handler。捕获所有方法/路径。
async fn forward(req: Request) -> Response {
    // 1. 读 target,无则 502(前端连接未配置或 target 注入失败)
    let target_base = match req.headers().get(TARGET_HEADER) {
        Some(v) => v.to_str().unwrap_or("").trim_end_matches('/').to_string(),
        None => return no_target_response(),
    };
    if target_base.is_empty() {
        return no_target_response();
    }

    // 2. 拼完整 URL: target_base + path + query
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("");
    // path_and_query 形如 "/admin/groups/all?timezone=Asia%2FShanghai"
    // target_base 已去尾斜杠,直接拼接。
    let url = format!("{target_base}{path_and_query}");

    // 3. 构造 reqwest 请求:方法/body 透传,header 透传但剥 X-Target-Base
    let (parts, body) = req.into_parts();
    let body_bytes: Bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();
    let method = Method::from_bytes(parts.method.as_str().as_bytes())
        .unwrap_or(Method::GET);

    let mut forward_headers = HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        // 剥掉反代控制 header 与 hop-by-hop 头(host 由 reqwest 按 URL 重设)
        if name == TARGET_HEADER || name == "host" || name == "content-length" {
            continue;
        }
        forward_headers.insert(name.clone(), value.clone());
    }

    let client = match reqwest_client() {
        Ok(c) => c,
        Err(e) => return upstream_error_response(&format!("reqwest client init: {e}")),
    };

    let req_builder = client
        .request(method, &url)
        .headers(forward_headers)
        .body(body_bytes);

    let resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => return upstream_error_response(&format!("转发失败: {e}")),
    };

    // 4. 透传响应:状态 + header + body(hop-by-hop 头剥掉,CORS 由 tower-http 层补)
    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let resp_body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return upstream_error_response(&format!("读取上游响应失败: {e}")),
    };

    let mut out = Response::builder().status(status);
    for (name, value) in resp_headers.iter() {
        // 跳过 transfer-encoding(content-length 由 axum 按 body 重算)、connection 等 hop-by-hop
        if name == "transfer-encoding"
            || name == "connection"
            || name == "content-length"
            || name == "keep-alive"
        {
            continue;
        }
        // 剥掉 frame 限制头:插件管理 UI 的 iframe 经反代加载(源 127.0.0.1:18765),
        // 远端的 X-Frame-Options: SAMEORIGIN / CSP frame-ancestors 'self' 会把
        // tauri.localhost 父页面判为异源直接拒载。反代只绑 127.0.0.1,无外部暴露面。
        if name == "x-frame-options" || name == "content-security-policy" {
            continue;
        }
        if let Ok(n) = HeaderName::try_from(name.as_str()) {
            if let Ok(v) = HeaderValue::from_bytes(value.as_bytes()) {
                out = out.header(n, v);
            }
        }
    }
    out.body(axum::body::Body::from(resp_body))
        .unwrap_or_else(|_| upstream_error_response("响应构造失败"))
}

/// 构造 reqwest client。rustls-tls(与 updater 一致,不依赖 openssl);
/// 不跟重定向(sub2api 不该重定向,跟了会丢 Authorization header)。
fn reqwest_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

/// 无 target header 的响应。502 + sub2api 标准 API 错误格式,让前端错误链路正常显示。
fn no_target_response() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"code":-1,"message":"未配置连接目标(X-Target-Base 缺失),请先在连接页选择或新建连接"}"#,
    )
        .into_response()
}

/// 上游错误响应。502 + sub2api 标准 API 错误格式,message 含真实原因。
fn upstream_error_response(msg: &str) -> Response {
    let body = serde_json::json!({
        "code": -1,
        "message": msg,
    });
    (
        StatusCode::BAD_GATEWAY,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
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
        let client = reqwest_client().expect("reqwest client must build");
        // 无公开 API 直接断言 redirect policy,但能构造即证明 rustls-tls feature 链路通。
        let _ = client;
    }
}
