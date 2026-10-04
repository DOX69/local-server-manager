mod monitor;
use serde_json::{Value, json};
use std::{
    env,
    io::Read,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

fn header(req: &Request, name: &'static str) -> String {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.to_string())
        .unwrap_or_default()
}
fn respond(req: Request, status: u16, body: String, mime: &str) {
    let mut response = Response::from_string(body).with_status_code(StatusCode(status));
    for (name, value) in [
        ("Content-Type", mime),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        (
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        ),
    ] {
        response.add_header(Header::from_bytes(name, value).unwrap());
    }
    let _ = req.respond(response);
}
fn main() {
    let collector = env::args().any(|a| a == "--collector");
    let port: u16 = env::var("LOCALDECK_PORT")
        .unwrap_or_else(|_| if collector { "4781" } else { "4780" }.into())
        .parse()
        .expect("Port invalide");
    let host_token = env::var("LOCALDECK_TOKEN").unwrap_or_default();
    if collector && host_token.len() < 32 {
        panic!("LOCALDECK_TOKEN doit contenir au moins 32 caractères");
    }
    let session_token = format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    );
    let host_url =
        env::var("LOCALDECK_HOST").unwrap_or_else(|_| "http://host.docker.internal:4781".into());
    let snapshot = Arc::new(Mutex::new(
        json!({"loading":true,"servers":[],"containers":[],"worktrees":[],"warnings":[]}),
    ));
    if collector {
        let snapshot = snapshot.clone();
        thread::spawn(move || {
            let mut monitor = monitor::Monitor::new();
            loop {
                let value = monitor.scan();
                *snapshot.lock().unwrap() = value;
                thread::sleep(Duration::from_secs(8));
            }
        });
    }
    let server = Server::http(format!("0.0.0.0:{port}")).expect("Port occupé ou accès refusé");
    println!(
        "Localdeck {} sur le port {port}",
        if collector {
            "collecteur Windows"
        } else {
            "interface Docker"
        }
    );
    for mut req in server.incoming_requests() {
        let path = req.url().to_string();
        let is_api = path.starts_with("/api/");
        if collector {
            if header(&req, "X-Localdeck-Token") != host_token {
                respond(req, 403, "{}".into(), "application/json");
                continue;
            }
        } else {
            let host = header(&req, "Host");
            if !matches!(host.split(':').next(), Some("localhost" | "127.0.0.1")) {
                respond(req, 403, "Hôte refusé".into(), "text/plain");
                continue;
            }
            if is_api
                && path != "/api/session"
                && header(&req, "X-Localdeck-Token") != session_token
            {
                respond(req, 403, "{}".into(), "application/json");
                continue;
            }
            if path == "/api/session" && req.method() == &Method::Get {
                respond(
                    req,
                    200,
                    json!({"token":session_token}).to_string(),
                    "application/json",
                );
                continue;
            }
        }
        if is_api {
            let valid = (path == "/api/snapshot" && req.method() == &Method::Get)
                || (path == "/api/stop" && req.method() == &Method::Post);
            if !valid {
                respond(req, 404, "{}".into(), "application/json");
                continue;
            }
            let mut body = String::new();
            if req
                .as_reader()
                .take(8193)
                .read_to_string(&mut body)
                .is_err()
                || body.len() > 8192
            {
                respond(
                    req,
                    400,
                    json!({"error":"Requête invalide"}).to_string(),
                    "application/json",
                );
                continue;
            }
            if collector {
                let (status, result) = if path == "/api/snapshot" {
                    (200, snapshot.lock().unwrap().clone())
                } else {
                    match serde_json::from_str::<Value>(&body) {
                        Ok(value) => match monitor::stop(&value, &snapshot.lock().unwrap()) {
                            Ok(message) => (200, json!({"message":message})),
                            Err(e) => (409, json!({"error":e})),
                        },
                        Err(_) => (400, json!({"error":"Requête invalide"})),
                    }
                };
                respond(req, status, result.to_string(), "application/json");
            } else {
                let agent = ureq::Agent::config_builder()
                    .timeout_global(Some(Duration::from_secs(25)))
                    .http_status_as_error(false)
                    .build()
                    .new_agent();
                let url = format!("{host_url}{path}");
                let result = if path == "/api/snapshot" {
                    agent
                        .get(&url)
                        .header("X-Localdeck-Token", &host_token)
                        .call()
                } else {
                    agent
                        .post(&url)
                        .header("X-Localdeck-Token", &host_token)
                        .header("Content-Type", "application/json")
                        .send(body.as_bytes())
                };
                match result {
                    Ok(mut response) => { let status = response.status().as_u16(); let body = response.body_mut().read_to_string().unwrap_or_else(|_| "{}".into()); respond(req, status, body, "application/json"); }
                    Err(_) => respond(req, 503, json!({"error":"Collecteur Windows indisponible. Relancez Start-Localdeck.ps1 sur Windows."}).to_string(), "application/json"),
                }
            }
        } else if !collector && req.method() == &Method::Get {
            let asset = match path.as_str() {
                "/" => Some((
                    include_str!("../web/index.html"),
                    "text/html; charset=utf-8",
                )),
                "/app.js" => Some((
                    include_str!("../web/app.js"),
                    "text/javascript; charset=utf-8",
                )),
                "/style.css" => Some((include_str!("../web/style.css"), "text/css; charset=utf-8")),
                _ => None,
            };
            if let Some((body, mime)) = asset {
                respond(req, 200, body.into(), mime);
            } else {
                respond(req, 404, "Introuvable".into(), "text/plain");
            }
        } else {
            respond(req, 404, "{}".into(), "application/json");
        }
    }
}
