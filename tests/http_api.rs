use serde_json::Value;
use std::{
    io::{BufRead, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};

const COLLECTOR_TOKEN: &str = "localdeck-functional-test-token-with-more-than-32-chars";

struct RunningLocaldeck {
    child: Child,
    port: u16,
}

impl Drop for RunningLocaldeck {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn client() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

fn start_localdeck(collector: bool) -> RunningLocaldeck {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve a local port");
    let port = listener.local_addr().expect("read reserved port").port();
    drop(listener);

    let mut command = Command::new(env!("CARGO_BIN_EXE_localdeck"));
    command
        .env("LOCALDECK_PORT", port.to_string())
        .env("LOCALDECK_ROOTS", "[]")
        .env(
            "USERPROFILE",
            std::env::temp_dir().join(format!("localdeck-test-home-{port}")),
        )
        .env_remove("LOCALDECK_TOKEN")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if collector {
        command
            .arg("--collector")
            .env("LOCALDECK_TOKEN", COLLECTOR_TOKEN);
        // Keep the functional test away from the host's actual Docker engine.
        #[cfg(windows)]
        command.env("DOCKER_HOST", "npipe:////./pipe/localdeck-functional-test");
        #[cfg(not(windows))]
        command.env("DOCKER_HOST", "unix:///tmp/localdeck-functional-test.sock");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut server = RunningLocaldeck {
        child: command.spawn().expect("start Localdeck for API test"),
        port,
    };
    let agent = client();
    let url = format!("http://127.0.0.1:{port}/api/snapshot");
    for _ in 0..80 {
        if server
            .child
            .try_wait()
            .expect("check Localdeck process")
            .is_some()
        {
            panic!("Localdeck exited before accepting API requests");
        }
        if let Ok(mut response) = agent.get(&url).call() {
            let status = response.status().as_u16();
            let _ = response.body_mut().read_to_string();
            if status == 403 {
                return server;
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("Localdeck did not start its API in time");
}

#[test]
fn collector_api_requires_its_token_and_returns_a_snapshot() {
    let server = start_localdeck(true);
    let agent = client();
    let url = format!("http://127.0.0.1:{}/api/snapshot", server.port);

    let response = agent.get(&url).call().expect("unauthorized API response");
    assert_eq!(response.status().as_u16(), 403);

    let mut snapshot = None;
    for _ in 0..300 {
        let mut response = agent
            .get(&url)
            .header("X-Localdeck-Token", COLLECTOR_TOKEN)
            .call()
            .expect("authorized snapshot response");
        assert_eq!(response.status().as_u16(), 200);
        let body = response
            .body_mut()
            .read_to_string()
            .expect("read snapshot body");
        let value: Value = serde_json::from_str(&body).expect("snapshot is JSON");
        if value["loading"] == false {
            snapshot = Some(value);
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let snapshot = snapshot.expect("collector finishes its first scan");
    for key in ["servers", "containers", "worktrees", "warnings"] {
        assert!(snapshot[key].is_array(), "snapshot field {key} is an array");
    }

    let stop_url = format!("http://127.0.0.1:{}/api/stop", server.port);

    let malformed = agent
        .post(&stop_url)
        .header("X-Localdeck-Token", COLLECTOR_TOKEN)
        .content_type("application/json")
        .send("not json")
        .expect("malformed stop response");
    assert_eq!(malformed.status().as_u16(), 400);

    let unsupported = agent
        .post(&stop_url)
        .header("X-Localdeck-Token", COLLECTOR_TOKEN)
        .content_type("application/json")
        .send(r#"{"kind":"unsupported"}"#)
        .expect("unsupported stop response");
    assert_eq!(unsupported.status().as_u16(), 409);
}

#[test]
fn interface_session_token_gates_api_and_nonlocal_hosts_are_refused() {
    let server = start_localdeck(false);
    let agent = client();
    let base = format!("http://127.0.0.1:{}", server.port);

    let mut response = agent
        .get(&format!("{base}/api/session"))
        .call()
        .expect("session response");
    assert_eq!(response.status().as_u16(), 200);
    let body = response
        .body_mut()
        .read_to_string()
        .expect("read session body");
    let session: Value = serde_json::from_str(&body).expect("session is JSON");
    let token = session["token"].as_str().expect("session includes token");
    assert_eq!(token.len(), 64);
    assert!(token.chars().all(|character| character.is_ascii_hexdigit()));

    let unauthorized = agent
        .get(&format!("{base}/api/snapshot"))
        .call()
        .expect("unauthorized response");
    assert_eq!(unauthorized.status().as_u16(), 403);

    let authorized_unknown = agent
        .get(&format!("{base}/api/not-supported"))
        .header("X-Localdeck-Token", token)
        .call()
        .expect("authenticated route response");
    assert_eq!(authorized_unknown.status().as_u16(), 404);

    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).expect("connect to interface");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set response timeout");
    write!(
        stream,
        "GET /api/session HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n"
    )
    .expect("send request with a nonlocal host");
    let mut reader = std::io::BufReader::new(stream);
    let mut status_line = String::new();
    reader
        .read_line(&mut status_line)
        .expect("read host validation response");
    assert!(
        status_line.contains(" 403 "),
        "nonlocal host response was {status_line:?}"
    );
}
