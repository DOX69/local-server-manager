use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub fn command(program: &str, args: &[&str], timeout: u64) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program}: délai dépassé"));
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if status.success() {
        Ok(stdout)
    } else {
        Err(stderr.chars().take(240).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Socket {
    pub protocol: String,
    pub address: String,
    pub port: u16,
    pub pid: u32,
    pub remote: String,
    pub listening: bool,
    pub connected: bool,
}
pub fn parse_netstat(input: &str) -> Vec<Socket> {
    input
        .lines()
        .filter_map(|line| {
            let p: Vec<_> = line.split_whitespace().collect();
            if p.len() < 4 || !matches!(p[0], "TCP" | "UDP") {
                return None;
            }
            let (address, port) = p[1].rsplit_once(':')?;
            Some(Socket {
                protocol: p[0].into(),
                address: address.trim_matches(['[', ']']).into(),
                port: port.parse().ok()?,
                pid: p.last()?.parse().ok()?,
                remote: p[2].into(),
                listening: p[0] == "UDP" || p[2].ends_with(":0"),
                connected: p[0] == "TCP"
                    && p.get(3)
                        .is_some_and(|s| matches!(*s, "ESTABLISHED" | "ETABLI" | "ÉTABLIE")),
            })
        })
        .collect()
}
pub fn git(path: &Path, args: &[&str]) -> Option<String> {
    let mut full = vec!["-C", path.to_str()?];
    full.extend_from_slice(args);
    command("git", &full, 4).ok().map(|s| s.trim().to_string())
}
fn parse_worktree_changes(output: &str) -> Vec<Value> {
    let mut entries = output.split('\0').filter(|entry| !entry.is_empty());
    let mut changes = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        let path = &entry[3..];
        let path = if code.contains('R') || code.contains('C') {
            entries
                .next()
                .map(|source| format!("{source} → {path}"))
                .unwrap_or_else(|| path.to_string())
        } else {
            path.to_string()
        };
        changes.push(json!({"path":path,"code":code}));
    }
    changes
}
fn discover(path: &Path, depth: usize, roots: &mut BTreeSet<PathBuf>, budget: &mut usize) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    if path.join(".git").exists() {
        roots.insert(path.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if entry
                .file_type()
                .map(|t| t.is_dir() && !t.is_symlink())
                .unwrap_or(false)
                && !matches!(
                    entry.file_name().to_str(),
                    Some("node_modules" | "target" | ".git" | "AppData" | ".venv")
                )
            {
                discover(&entry.path(), depth - 1, roots, budget);
            }
        }
    }
}
fn ancestry(system: &System, pid: u32) -> Vec<Value> {
    let mut chain = Vec::new();
    let mut current = Pid::from_u32(pid);
    let mut seen = BTreeSet::new();
    for _ in 0..24 {
        if !seen.insert(current) {
            break;
        }
        let Some(p) = system.process(current) else {
            break;
        };
        chain.push(json!({"pid":current.as_u32(),"name":p.name().to_string_lossy(),"started":p.start_time(),"cwd":p.cwd().map(|x|x.to_string_lossy()),"command":p.cmd().iter().map(|x|x.to_string_lossy()).collect::<Vec<_>>().join(" ")}));
        let Some(parent) = p.parent() else { break };
        if system
            .process(parent)
            .is_some_and(|a| a.start_time() > p.start_time())
        {
            break;
        }
        current = parent;
    }
    chain
}
fn agent(chain: &[Value]) -> (&'static str, String) {
    for item in chain {
        let name = item["name"].as_str().unwrap_or("").to_lowercase();
        if name.contains("opencode") {
            return (
                "OpenCode",
                format!(
                    "Ancêtre {} · PID {}",
                    item["name"].as_str().unwrap_or(""),
                    item["pid"]
                ),
            );
        }
        if name.contains("codex") {
            return (
                "Codex",
                format!(
                    "Ancêtre {} · PID {}",
                    item["name"].as_str().unwrap_or(""),
                    item["pid"]
                ),
            );
        }
    }
    (
        "Inconnu",
        "Aucun ancêtre Codex ou OpenCode identifiable. Le créateur peut avoir quitté.".into(),
    )
}
fn protected(pid: u32, name: &str) -> bool {
    let n = name.to_lowercase();
    let versioned_python = n
        .trim_end_matches(".exe")
        .strip_prefix("python")
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit() || c == '.')
        });
    pid <= 4
        || pid == std::process::id()
        || n.contains("localdeck")
        || n.contains("docker")
        || n.contains("wsl")
        || (!versioned_python
            && ![
                "node.exe",
                "node",
                "python.exe",
                "python",
                "python3.exe",
                "python3",
                "deno.exe",
                "deno",
                "bun.exe",
                "bun",
                "php.exe",
                "php",
                "ruby.exe",
                "ruby",
                "java.exe",
                "java",
                "dotnet.exe",
                "dotnet",
                "test-server.exe",
            ]
            .contains(&n.as_str()))
}
pub struct Monitor {
    system: System,
    worktrees: Vec<Value>,
    last_git: Option<Instant>,
}
fn can_stop(process: &sysinfo::Process, repo: Option<&str>) -> bool {
    let pid = process.pid().as_u32();
    let name = process.name().to_string_lossy().to_lowercase();
    if !protected(pid, &name) {
        return true;
    }
    // Custom binaries built inside a Git project, including Rust target/ servers.
    pid > 4
        && pid != std::process::id()
        && ![
            "localdeck",
            "codex",
            "opencode",
            "docker",
            "wsl",
            "chrome",
            "msedge",
        ]
        .iter()
        .any(|s| name.contains(s))
        && repo.is_some_and(|root| {
            process
                .exe()
                .is_some_and(|exe| exe.starts_with(Path::new(root)))
        })
}
impl Monitor {
    pub fn new() -> Self {
        Self {
            system: System::new_all(),
            worktrees: vec![],
            last_git: None,
        }
    }
    pub fn scan(&mut self) -> Value {
        let beginning = Instant::now();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::Always),
        );
        let mut warnings = vec![];
        let sockets = match command("netstat", &["-ano"], 8) {
            Ok(s) => parse_netstat(&s),
            Err(e) => {
                warnings.push(e);
                vec![]
            }
        };
        let mut repo_cache = BTreeMap::<PathBuf, Option<String>>::new();
        let mut rows = Vec::new();
        let mut seen = BTreeSet::new();
        for socket in sockets.iter().filter(|s| s.listening) {
            if !seen.insert((socket.pid, socket.port, socket.protocol.clone())) {
                continue;
            }
            let process = self.system.process(Pid::from_u32(socket.pid));
            let chain = ancestry(&self.system, socket.pid);
            let cwd = process.and_then(|p| p.cwd()).map(Path::to_path_buf);
            let mut root = None;
            for item in &chain {
                if let Some(path) = item["cwd"].as_str() {
                    let path = PathBuf::from(path);
                    let value = repo_cache
                        .entry(path.clone())
                        .or_insert_with(|| git(&path, &["rev-parse", "--show-toplevel"]));
                    if value.is_some() {
                        root = value.clone();
                        break;
                    }
                }
            }
            let (agent, evidence) = agent(&chain);
            let name = process
                .map(|p| p.name().to_string_lossy().into_owned())
                .unwrap_or_else(|| "Accès restreint".into());
            let bindings = sockets
                .iter()
                .filter(|s| {
                    s.listening
                        && s.pid == socket.pid
                        && s.port == socket.port
                        && s.protocol == socket.protocol
                })
                .map(|s| s.address.clone())
                .collect::<BTreeSet<_>>();
            let clients=sockets.iter().filter(|s|s.connected && s.pid>0 && s.protocol=="TCP" && s.remote.rsplit_once(':').is_some_and(|(_,p)|p.parse::<u16>().ok()==Some(socket.port)) && (s.remote.starts_with("127.")||s.remote.starts_with("[::1]"))).map(|s|json!({"pid":s.pid,"name":self.system.process(Pid::from_u32(s.pid)).map(|p|p.name().to_string_lossy()),"endpoint":s.remote})).collect::<Vec<_>>();
            rows.push(json!({"id":format!("{}:{}:{}",socket.pid,socket.protocol,socket.port),"pid":socket.pid,"port":socket.port,"protocol":socket.protocol,"bindings":bindings,"name":name,"started":process.map(|p|p.start_time()).unwrap_or(0),"memory":process.map(|p|p.memory()).unwrap_or(0),"cpu":process.map(|p|p.cpu_usage()).unwrap_or(0.0),"cwd":cwd,"repo":root,"agent":agent,"evidence":evidence,"ancestry":chain,"clients":clients,"connections":sockets.iter().filter(|s|s.connected && s.pid==socket.pid && s.port==socket.port).count(),"stoppable":process.is_some_and(|p|can_stop(p,root.as_deref()))}));
        }
        if self
            .last_git
            .is_none_or(|t| t.elapsed() > Duration::from_secs(60))
        {
            let mut roots = BTreeSet::new();
            for row in &rows {
                if let Some(root) = row["repo"].as_str() {
                    roots.insert(PathBuf::from(root));
                }
            }
            if let Ok(home) = env::var("USERPROFILE") {
                let mut budget = 2500;
                for folder in [
                    ".codex/worktrees",
                    "professional-projects",
                    "PycharmProjects",
                    "Documents/Codex",
                ] {
                    discover(&Path::new(&home).join(folder), 3, &mut roots, &mut budget);
                }
            }
            if let Ok(extra) = env::var("LOCALDECK_ROOTS")
                && let Ok(extra) = serde_json::from_str::<Vec<String>>(&extra)
            {
                let mut budget = 2500;
                for root in extra {
                    discover(Path::new(&root), 3, &mut roots, &mut budget);
                }
            }
            let mut worktrees = BTreeMap::new();
            let mut visited = BTreeSet::new();
            for root in roots {
                let common = git(
                    &root,
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                );
                if let Some(ref c) = common
                    && !visited.insert(c.clone())
                {
                    continue;
                }
                let repo = common
                    .as_deref()
                    .and_then(|s| Path::new(s).parent())
                    .unwrap_or(&root)
                    .to_string_lossy()
                    .into_owned();
                if let Some(list) = git(&root, &["worktree", "list", "--porcelain"]) {
                    for block in list.split("\n\n") {
                        if let Some(path) = block.lines().find_map(|l| l.strip_prefix("worktree "))
                        {
                            let branch = block
                                .lines()
                                .find_map(|l| l.strip_prefix("branch refs/heads/"))
                                .unwrap_or("HEAD détachée");
                            let exists = Path::new(path).exists();
                            let changes = exists
                                .then(|| {
                                    git(
                                        Path::new(path),
                                        &[
                                            "status",
                                            "--porcelain=v1",
                                            "-z",
                                            "--untracked-files=normal",
                                        ],
                                    )
                                })
                                .flatten()
                                .map(|status| parse_worktree_changes(&status));
                            let changes_available = changes.is_some();
                            let changes = changes.unwrap_or_default();
                            let changes_count = changes.len();
                            worktrees.insert(path.to_string(),json!({"path":path,"repo":repo,"branch":branch,"exists":exists,"locked":block.lines().any(|l|l.starts_with("locked")),"kind":if path.contains(".codex") {"Codex"} else {"Git"},"changes_available":changes_available,"changes_count":changes_count,"changes":changes}));
                        }
                    }
                }
            }
            self.worktrees = worktrees.into_values().collect();
            self.last_git = Some(Instant::now());
        }
        for tree in &mut self.worktrees {
            let path = tree["path"]
                .as_str()
                .unwrap_or("")
                .replace('\\', "/")
                .to_lowercase();
            tree["servers"] = json!(
                rows.iter()
                    .filter(|s| s["repo"]
                        .as_str()
                        .is_some_and(|r| r.replace('\\', "/").to_lowercase() == path))
                    .count()
            );
        }
        let containers = match docker_containers() {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!("Docker indisponible : {error}"));
                vec![]
            }
        };
        for row in &mut rows {
            let port = row["port"].as_u64().unwrap_or(0).to_string();
            let linked = containers
                .iter()
                .filter(|c| {
                    c["ports"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|p| p["host_port"] == port))
                })
                .map(|c| c["name"].clone())
                .collect::<Vec<_>>();
            if !linked.is_empty() {
                row["containers"] = json!(linked);
                row["stoppable"] = json!(false);
            }
        }
        rows.sort_by_key(|v| v["port"].as_u64());
        json!({"loading":false,"timestamp":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),"scan_ms":beginning.elapsed().as_millis(),"hostname":env::var("COMPUTERNAME").unwrap_or_default(),"servers":rows,"containers":containers,"worktrees":self.worktrees,"warnings":warnings})
    }
}
fn docker_containers() -> Result<Vec<Value>, String> {
    let context = command("docker", &["context", "show"], 4)?;
    if !matches!(
        context.trim(),
        "desktop-linux" | "default" | "desktop-windows"
    ) {
        return Err(format!(
            "Contexte {} ignoré, seuls les contextes locaux sont autorisés",
            context.trim()
        ));
    }
    let endpoint = env::var("DOCKER_HOST")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(command(
            "docker",
            &[
                "context",
                "inspect",
                "--format",
                "{{.Endpoints.docker.Host}}",
            ],
            4,
        )?);
    if !endpoint.trim().starts_with("npipe://") && !endpoint.trim().starts_with("unix://") {
        return Err(
            "Seuls les moteurs Docker locaux via pipe ou socket sont pris en charge".into(),
        );
    }
    let ids = command("docker", &["ps", "-aq", "--no-trunc"], 6)?;
    if ids.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut args = vec!["inspect"];
    args.extend(ids.split_whitespace());
    let values: Vec<Value> =
        serde_json::from_str(&command("docker", &args, 8)?).map_err(|e| e.to_string())?;
    Ok(values.iter().map(|v| {
        let labels=&v["Config"]["Labels"]; let mut ports=vec![];
        if let Some(map)=v["NetworkSettings"]["Ports"].as_object() { for (container,bindings) in map { if let Some(bindings)=bindings.as_array() { for binding in bindings { ports.push(json!({"container_port":container,"host_ip":binding["HostIp"],"host_port":binding["HostPort"]})); } } } }
        json!({"id":v["Id"],"name":v["Name"].as_str().unwrap_or("").trim_start_matches('/'),"image":v["Config"]["Image"],"state":v["State"]["Status"],"started":v["State"]["StartedAt"],"health":v["State"]["Health"]["Status"],"project":labels["com.docker.compose.project"],"service":labels["com.docker.compose.service"],"directory":labels["com.docker.compose.project.working_dir"],"ports":ports,"stoppable":v["State"]["Running"]==true && labels["com.docker.compose.project"]!="localdeck"})
    }).collect())
}
pub fn stop(value: &Value, snapshot: &Value) -> Result<String, String> {
    if value["kind"] == "container" {
        let id = value["id"].as_str().ok_or("Conteneur manquant")?;
        if id.len() != 64 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Identifiant invalide".into());
        }
        let known = snapshot["containers"]
            .as_array()
            .and_then(|a| a.iter().find(|c| c["id"] == id && c["stoppable"] == true))
            .ok_or("Conteneur absent ou protégé")?;
        let current = docker_containers()?
            .into_iter()
            .find(|c| c["id"] == id && c["stoppable"] == true)
            .ok_or("Conteneur absent ou protégé")?;
        if current["started"] != known["started"] || value["started"] != known["started"] {
            return Err("Le conteneur a redémarré. Actualisez avant de l'arrêter.".into());
        }
        command("docker", &["stop", "--time", "8", id], 15)?;
        return Ok("Conteneur arrêté.".into());
    }
    if value["kind"] != "process" {
        return Err("Type d'arrêt invalide".into());
    }
    let pid = value["pid"]
        .as_u64()
        .filter(|p| *p <= u32::MAX as u64)
        .ok_or("PID invalide")? as u32;
    let started = value["started"]
        .as_u64()
        .ok_or("Date de démarrage manquante")?;
    let row = snapshot["servers"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|r| r["pid"] == pid && r["started"] == started && r["stoppable"] == true)
        })
        .ok_or("Processus absent ou protégé")?;
    let mut system = System::new_all();
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or("Le processus est déjà arrêté")?;
    if process.start_time() != started || !can_stop(process, row["repo"].as_str()) {
        return Err("Le PID a changé ou le processus est protégé".into());
    }
    let sockets = parse_netstat(&command("netstat", &["-ano"], 8)?);
    if !sockets
        .iter()
        .any(|s| s.listening && s.pid == pid && s.port as u64 == row["port"].as_u64().unwrap_or(0))
    {
        return Err("Ce processus n'écoute plus sur ce port. Actualisez.".into());
    }
    if !process.kill() {
        return Err("Arrêt refusé par Windows. Vérifiez les droits du collecteur.".into());
    }
    for _ in 0..30 {
        system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
        if system
            .process(Pid::from_u32(pid))
            .is_none_or(|p| p.start_time() != started)
        {
            let remaining = parse_netstat(&command("netstat", &["-ano"], 8)?);
            if remaining.iter().any(|s| s.listening && s.pid == pid) {
                return Err(
                    "Le processus a quitté mais un port avec ce PID reste visible. Actualisez."
                        .into(),
                );
            }
            return Ok(format!(
                "Processus {pid} arrêté. Tous ses ports sont fermés."
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Arrêt demandé, fermeture non confirmée. Actualisez.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipv4_ipv6_udp_and_clients() {
        let rows = parse_netstat(
            "TCP 0.0.0.0:3004 0.0.0.0:0 LISTENING 123\nTCP [::1]:4567 [::]:0 ECOUTE 456\nTCP 127.0.0.1:50100 127.0.0.1:3004 ESTABLISHED 789\nUDP 0.0.0.0:5353 *:* 42",
        );
        assert_eq!(rows.len(), 4);
        assert!(rows[0].listening);
        assert_eq!(rows[1].address, "::1");
        assert!(!rows[2].listening);
        assert_eq!(rows[3].protocol, "UDP");
    }
    #[test]
    fn protect_infrastructure_and_self() {
        for (pid, name) in [
            (4, "node.exe"),
            (99, "com.docker.backend.exe"),
            (99, "svchost.exe"),
            (std::process::id(), "node.exe"),
        ] {
            assert!(protected(pid, name));
        }
        assert!(!protected(99999, "node.exe"));
    }
    #[test]
    fn refuse_unseen_target() {
        assert!(
            stop(
                &json!({"kind":"process","pid":999999,"started":1}),
                &json!({"servers":[]})
            )
            .is_err()
        );
        assert!(
            stop(
                &json!({"kind":"container","id":"--help"}),
                &json!({"containers":[]})
            )
            .is_err()
        );
    }
    #[test]
    fn refuses_stale_pid() {
        assert!(
            stop(
                &json!({"kind":"process","pid":std::process::id(),"started":1}),
                &json!({"servers":[{"pid":std::process::id(),"started":1,"stoppable":true}]})
            )
            .is_err()
        );
    }
}
