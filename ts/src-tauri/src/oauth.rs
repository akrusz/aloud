//! Desktop Google sign-in — the loopback half of the PKCE flow (meditation-pal-fae).
//!
//! Google's in-webview popup (GIS) can't run in Tauri's custom-scheme origin, so
//! the desktop app signs in the way Claude Code and most native apps do: open the
//! system browser, let the user authenticate there, and catch the redirect on an
//! ephemeral `127.0.0.1` port. We hand the resulting authorization code + PKCE
//! verifier back to the UI, which posts them to the hosted server's
//! `POST /cloud/v1/auth/google/desktop`. The server holds the client secret and
//! redeems the code — so no secret ever ships in this binary. The (public)
//! client id comes from the server's `/cloud/v1/config`.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE: &str = "openid email profile";
/// How long to wait for the user to finish in the browser before giving up.
const WAIT: Duration = Duration::from_secs(300);

/// Request body for `POST /app/v1/google-oauth`.
#[derive(Deserialize)]
pub struct OauthStart {
    pub client_id: String,
}

/// What the UI needs to finish sign-in on the hosted server.
#[derive(Serialize)]
pub struct OauthResult {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `n` random bytes as a URL-safe base64 string (PKCE verifier / state nonce).
fn random_b64url(n: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    b64url(&buf)
}

/// Percent-encode a query-parameter value per RFC 3986 (unreserved set kept).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode a percent-encoded query value (`%2F`, `+` → space).
fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open `url` in the user's default browser (the system handler, not the webview).
///
/// Routed through the opener plugin (ShellExecuteW on Windows, `open`/`xdg-open`
/// on macOS/Linux). A hand-rolled `cmd /C start "" <url>` on Windows mangles the
/// auth URL: cmd treats the `&` query-param separators as command delimiters, so
/// only `?response_type=code` survives and everything after it (client_id,
/// redirect_uri, …) is dropped — sign-in then fails. ShellExecuteW takes the URL
/// whole, sidestepping that.
fn open_browser(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))
}

/// Run the loopback Google OAuth dance and return the code + PKCE verifier.
pub async fn google_loopback(client_id: &str) -> Result<OauthResult, String> {
    let verifier = random_b64url(48); // 64-char URL-safe verifier (43..128 allowed)
    let challenge = b64url(Sha256::digest(verifier.as_bytes()).as_slice());
    let state = random_b64url(24);

    // Google allows any loopback PORT for "Desktop app" clients, so an ephemeral
    // port is fine — and the token endpoint only needs the same redirect_uri back.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not bind a loopback port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = format!(
        "{GOOGLE_AUTH_URL}?response_type=code\
         &client_id={}&redirect_uri={}&scope={}\
         &code_challenge={}&code_challenge_method=S256&state={}\
         &access_type=offline&prompt=select_account",
        pct(client_id),
        pct(&redirect_uri),
        pct(SCOPE),
        pct(&challenge),
        pct(&state),
    );

    open_browser(&auth_url)?;

    let (code, got_state) = tokio::time::timeout(WAIT, accept_redirect(listener))
        .await
        .map_err(|_| "timed out waiting for Google sign-in".to_string())??;

    // CSRF guard: the redirect must echo the state we generated.
    if got_state != state {
        return Err("OAuth state mismatch (possible CSRF) — aborted".into());
    }
    Ok(OauthResult { code, code_verifier: verifier, redirect_uri })
}

/// Serve loopback connections until one carries the OAuth redirect (a `code` or
/// `error` query param), parse it, and reply with a small "you can close this
/// tab" page. Browsers open extra connections to a fresh local origin (favicon
/// probes, speculative preconnects) — consuming the first connection blindly
/// would eat one of those and miss the real redirect, so anything without
/// `code`/`error` gets a 404 and we keep listening. The caller's overall
/// timeout (`WAIT`) still bounds the loop.
async fn accept_redirect(listener: TcpListener) -> Result<(String, String), String> {
    loop {
        let (mut sock, _) =
            listener.accept().await.map_err(|e| format!("loopback accept: {e}"))?;
        let mut buf = [0u8; 8192];
        let n = sock.read(&mut buf).await.map_err(|e| format!("loopback read: {e}"))?;
        let req = String::from_utf8_lossy(&buf[..n]);

        // Request line: `GET /?code=...&state=... HTTP/1.1`
        let target = req
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");

        let (mut code, mut state, mut err) = (String::new(), String::new(), String::new());
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                match k {
                    "code" => code = pct_decode(v),
                    "state" => state = pct_decode(v),
                    "error" => err = pct_decode(v),
                    _ => {}
                }
            }
        }

        if code.is_empty() && err.is_empty() {
            let resp = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
            continue;
        }

        return finish_redirect(sock, code, state, err).await;
    }
}

/// Send the closing page for the real redirect and turn it into the result.
async fn finish_redirect(
    mut sock: tokio::net::TcpStream,
    code: String,
    state: String,
    err: String,
) -> Result<(String, String), String> {
    let ok = !code.is_empty() && err.is_empty();
    let (status, msg) = if ok {
        ("200 OK", "You're signed in. You can close this tab and return to aloud.")
    } else {
        ("400 Bad Request", "Sign-in didn't complete. You can close this tab and try again in aloud.")
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>aloud</title>\
         <body style=\"font-family:system-ui;padding:3rem;text-align:center\">\
         <h2>aloud</h2><p>{msg}</p></body>"
    );
    let resp = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\n\
         content-length: {}\r\nconnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
    let _ = sock.flush().await;

    if !err.is_empty() {
        return Err(format!("Google returned an error: {err}"));
    }
    if code.is_empty() {
        return Err("no authorization code in the redirect".into());
    }
    Ok((code, state))
}
