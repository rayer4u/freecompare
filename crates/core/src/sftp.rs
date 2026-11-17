//! Pure-Rust SFTP client, `~/.ssh/config` resolver, passwordless auth chain, and connection pool.
//!
//! Zero external C dependencies (`libssh2` / `openssl`) or shell glue (`ssh` / `sftp` CLI).
//! Authentication priority matches Beyond Compare:
//! 1. `~/.ssh/config` (`HostName`, `User`, `Port`, `IdentityFile`, `CertificateFile`)
//! 2. Native SSH Agent (Unix `SSH_AUTH_SOCK`, Windows OpenSSH named pipe / Pageant)
//! 3. `IdentityFile` and default local private keys (`id_ed25519`, `id_ecdsa`, `id_rsa`)
//! 4. Explicit password / passphrase / keyboard-interactive fallback

use crate::buffer::expand_path;
use parking_lot::{Mutex, RwLock};
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{
    load_openssh_certificate, load_secret_key, HashAlg, PrivateKeyWithHashAlg,
    PublicKeyOrCertificate,
};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use ssh2_config::{ParseRule, SshConfig};
use std::collections::HashMap;
use std::fs::File;
use std::future::Future;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_SFTP_TIMEOUT_SECS: u64 = 30;

/// Returns `true` if the path string is an `sftp://` URI (case-insensitive scheme).
pub fn is_sftp_uri(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("sftp://")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SftpLocation {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    #[serde(skip_serializing)]
    pub password: Option<String>,
    pub remote_path: String,
}

impl SftpLocation {
    /// Parses `sftp://[user[:password]@]host[:port][/remote/path]`.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        if !is_sftp_uri(trimmed) {
            return Err(format!("Not an SFTP URI: {trimmed}"));
        }

        // Normalize scheme casing so `url::Url` parses cleanly even for `SFTP://`
        let normalized_scheme = format!("sftp://{}", &trimmed[7..]);
        let parsed = Url::parse(&normalized_scheme)
            .map_err(|e| format!("无效的 SFTP URI ({trimmed}): {e}"))?;

        let host = parsed
            .host_str()
            .map(|h| h.trim_matches(|c| c == '[' || c == ']').to_string())
            .filter(|h| !h.is_empty())
            .ok_or_else(|| format!("SFTP URI 缺少主机名: {trimmed}"))?;

        let port = parsed.port();
        let user = if parsed.username().is_empty() {
            None
        } else {
            Some(percent_decode(parsed.username()))
        };
        let password = parsed.password().map(percent_decode);

        let raw_path = parsed.path();
        let remote_path = if raw_path.is_empty() {
            ".".to_string()
        } else {
            let decoded = percent_decode(raw_path);
            if decoded == "/~" || decoded == "/~/" {
                ".".to_string()
            } else if let Some(rest) = decoded.strip_prefix("/~/") {
                format!("~/{rest}")
            } else {
                decoded
            }
        };

        Ok(Self {
            host,
            port,
            user,
            password,
            remote_path,
        })
    }

    /// Formats back to a canonical `sftp://` URI (without embedding password).
    pub fn to_uri(&self) -> String {
        self.to_uri_with_path(&self.remote_path)
    }

    /// Formats an `sftp://` URI sharing the same host/user/port with a different remote path.
    pub fn to_uri_with_path(&self, remote_path: &str) -> String {
        let mut out = String::from("sftp://");
        if let Some(ref u) = self.user {
            if !u.is_empty() {
                out.push_str(&percent_encode_userinfo(u));
                out.push('@');
            }
        }
        if self.host.contains(':') && !self.host.starts_with('[') {
            out.push('[');
            out.push_str(&self.host);
            out.push(']');
        } else {
            out.push_str(&self.host);
        }
        if let Some(p) = self.port {
            out.push(':');
            out.push_str(&p.to_string());
        }
        let clean_path = remote_path.trim();
        if clean_path.is_empty() || clean_path == "." {
            // Omit path to represent remote home directory
        } else {
            let encoded = percent_encode_path(clean_path);
            if !encoded.starts_with('/') {
                out.push('/');
            }
            out.push_str(&encoded);
        }
        out
    }

    pub fn join_rel(&self, rel: &str) -> Self {
        let clean_rel = rel.replace('\\', "/");
        let clean_rel = clean_rel.trim_matches('/');
        let joined = if clean_rel.is_empty() {
            self.remote_path.clone()
        } else if self.remote_path == "." || self.remote_path.is_empty() {
            clean_rel.to_string()
        } else if self.remote_path == "/" {
            format!("/{clean_rel}")
        } else {
            format!("{}/{}", self.remote_path.trim_end_matches('/'), clean_rel)
        };
        Self {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            password: self.password.clone(),
            remote_path: joined,
        }
    }

    pub fn file_name(&self) -> String {
        let trimmed = self.remote_path.trim_end_matches('/');
        if trimmed.is_empty() || trimmed == "/" {
            return self.host.clone();
        }
        trimmed
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.host)
            .to_string()
    }
}

fn percent_encode_userinfo(input: &str) -> String {
    percent_encode_bytes(input.as_bytes(), |b| {
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~')
    })
}

fn percent_encode_path(input: &str) -> String {
    percent_encode_bytes(input.as_bytes(), |b| {
        b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~')
    })
}

fn percent_encode_bytes<F: Fn(u8) -> bool>(bytes: &[u8], keep: F) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if keep(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0F) as usize] as char);
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SftpConnectOptions {
    pub uri: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub path: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostEntry {
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpConnectionTestResult {
    pub ok: bool,
    pub resolved_uri: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub remote_path: String,
    pub auth_method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntryInfo {
    pub name: String,
    pub uri: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpDirListing {
    pub current_uri: String,
    pub parent_uri: Option<String>,
    pub entries: Vec<SftpEntryInfo>,
}

#[derive(Debug, Clone)]
pub struct SftpMetadataInfo {
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ResolvedSftpTarget {
    pub alias: String,
    pub connect_host: String,
    pub port: u16,
    pub user: String,
    pub identity_files: Vec<PathBuf>,
    pub certificate_file: Option<PathBuf>,
    pub pubkey_auth_allowed: bool,
    pub connect_timeout: Duration,
}

#[derive(Debug, Clone, Default)]
struct SftpCredentials {
    password: Option<String>,
    private_key_path: Option<PathBuf>,
    passphrase: Option<String>,
}

fn home_dir_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

fn current_os_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "root".to_string())
}

fn parse_ssh_config_file(path: &Path) -> Option<SshConfig> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut cfg = SshConfig::default();
    if let Some(home) = home_dir_path() {
        cfg = cfg.home_dir(home);
    }
    cfg.parse(&mut reader, ParseRule::ALLOW_UNKNOWN_FIELDS).ok()
}

/// Lists non-wildcard hosts defined in `~/.ssh/config` for quick passwordless selection.
pub fn list_ssh_config_hosts() -> Vec<SshHostEntry> {
    let Some(home) = home_dir_path() else {
        return Vec::new();
    };
    list_ssh_config_hosts_from_file(&home.join(".ssh").join("config"))
}

/// Parses concrete host aliases from a specified SSH config file path.
pub fn list_ssh_config_hosts_from_file(config_path: &Path) -> Vec<SshHostEntry> {
    let Some(config) = parse_ssh_config_file(config_path) else {
        return Vec::new();
    };

    let mut seen = Vec::new();
    let mut out = Vec::new();

    for host in config.get_hosts() {
        for clause in &host.pattern {
            if clause.negated
                || clause.pattern.contains('*')
                || clause.pattern.contains('?')
                || clause.pattern.trim().is_empty()
            {
                continue;
            }
            let alias = clause.pattern.clone();
            if seen.contains(&alias) {
                continue;
            }
            seen.push(alias.clone());
            let params = config.query(&alias);
            let host_name = params.host_name.unwrap_or_else(|| alias.clone());
            let identity_files = params
                .identity_file
                .unwrap_or_default()
                .into_iter()
                .map(|p| expand_path(p).to_string_lossy().to_string())
                .collect();

            out.push(SshHostEntry {
                alias,
                host_name,
                user: params.user,
                port: params.port.unwrap_or(22),
                identity_files,
            });
        }
    }

    out
}

/// Resolves SSH target parameters by merging explicit URI fields with `~/.ssh/config` and defaults.
pub fn resolve_ssh_connection_params(loc: &SftpLocation) -> ResolvedSftpTarget {
    let ssh_cfg_path = home_dir_path().map(|h| h.join(".ssh").join("config"));
    resolve_ssh_connection_params_with_config(loc, ssh_cfg_path.as_deref())
}

pub fn resolve_ssh_connection_params_with_config(
    loc: &SftpLocation,
    ssh_config_path: Option<&Path>,
) -> ResolvedSftpTarget {
    let parsed_cfg = ssh_config_path.and_then(parse_ssh_config_file);
    let params = parsed_cfg.as_ref().map(|c| c.query(&loc.host));

    let connect_host = params
        .as_ref()
        .and_then(|p| p.host_name.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| loc.host.clone());

    let port = loc
        .port
        .or_else(|| params.as_ref().and_then(|p| p.port))
        .unwrap_or(22);

    let user = loc
        .user
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| params.as_ref().and_then(|p| p.user.clone()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(current_os_username);

    let mut identity_files: Vec<PathBuf> = Vec::new();
    if let Some(ref p) = params {
        if let Some(ref id_files) = p.identity_file {
            for f in id_files {
                let expanded = expand_path(f);
                if !identity_files.contains(&expanded) {
                    identity_files.push(expanded);
                }
            }
        }
    }

    if let Some(home) = home_dir_path() {
        for default_name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let candidate = home.join(".ssh").join(default_name);
            if !identity_files.contains(&candidate) {
                identity_files.push(candidate);
            }
        }
    }

    let certificate_file = params
        .as_ref()
        .and_then(|p| p.certificate_file.as_ref())
        .map(expand_path);

    let pubkey_auth_allowed = params
        .as_ref()
        .and_then(|p| p.pubkey_authentication)
        .unwrap_or(true);

    let connect_timeout = params
        .as_ref()
        .and_then(|p| p.connect_timeout)
        .unwrap_or(DEFAULT_CONNECT_TIMEOUT);

    ResolvedSftpTarget {
        alias: loc.host.clone(),
        connect_host,
        port,
        user,
        identity_files,
        certificate_file,
        pubkey_auth_allowed,
        connect_timeout,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PoolKey {
    connect_host: String,
    port: u16,
    user: String,
}

struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

struct PooledConn {
    ssh: Arc<client::Handle<ClientHandler>>,
    sftp: Arc<SftpSession>,
    auth_method: String,
}

struct SftpPool {
    runtime: tokio::runtime::Runtime,
    slots: Mutex<HashMap<PoolKey, Arc<tokio::sync::Mutex<Option<Arc<PooledConn>>>>>>,
    creds_cache: RwLock<HashMap<PoolKey, SftpCredentials>>,
}

static SFTP_POOL: OnceLock<Result<SftpPool, String>> = OnceLock::new();

fn global_pool() -> io::Result<&'static SftpPool> {
    let res = SFTP_POOL.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .thread_name("freecompare-sftp")
            .build()
            .map_err(|e| format!("无法初始化 SFTP Tokio 运行时: {e}"))?;
        Ok(SftpPool {
            runtime,
            slots: Mutex::new(HashMap::new()),
            creds_cache: RwLock::new(HashMap::new()),
        })
    });
    match res {
        Ok(pool) => Ok(pool),
        Err(msg) => Err(io::Error::new(io::ErrorKind::Other, msg.clone())),
    }
}

impl SftpPool {
    fn slot_for(&self, key: &PoolKey) -> Arc<tokio::sync::Mutex<Option<Arc<PooledConn>>>> {
        let mut map = self.slots.lock();
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone()
    }

    fn cache_credentials(&self, key: PoolKey, creds: SftpCredentials) {
        if creds.password.is_some()
            || creds.private_key_path.is_some()
            || creds.passphrase.is_some()
        {
            self.creds_cache.write().insert(key, creds);
        }
    }

    fn cached_credentials(&self, key: &PoolKey) -> Option<SftpCredentials> {
        self.creds_cache.read().get(key).cloned()
    }

    fn block_on<F: Future>(&self, fut: F) -> F::Output {
        self.runtime.block_on(fut)
    }
}

async fn establish_sftp_connection(
    target: &ResolvedSftpTarget,
    creds: &SftpCredentials,
) -> io::Result<Arc<PooledConn>> {
    let ssh_cfg = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });

    let addr = (target.connect_host.as_str(), target.port);
    let mut handle = tokio::time::timeout(
        target.connect_timeout,
        client::connect(ssh_cfg, addr, ClientHandler),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "连接 SFTP 服务器 {}:{} 超时（>{:?}）",
                target.connect_host, target.port, target.connect_timeout
            ),
        )
    })?
    .map_err(|e| {
        io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!(
                "无法连接 SFTP 服务器 {}:{}: {e}",
                target.connect_host, target.port
            ),
        )
    })?;

    let auth_method = authenticate_session(&mut handle, target, creds).await?;

    let channel = tokio::time::timeout(target.connect_timeout, handle.channel_open_session())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "打开 SSH 会话通道超时"))?
        .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, format!("打开 SSH 通道失败: {e}")))?;

    tokio::time::timeout(
        target.connect_timeout,
        channel.request_subsystem(true, "sftp"),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "请求 SFTP 子系统超时"))?
    .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, format!("启动 SFTP 子系统失败: {e}")))?;

    let sftp = tokio::time::timeout(
        target.connect_timeout,
        SftpSession::new(channel.into_stream()),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "初始化 SFTP 会话超时"))?
    .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("SFTP 初始化失败: {e}")))?;

    sftp.set_timeout(DEFAULT_SFTP_TIMEOUT_SECS);

    Ok(Arc::new(PooledConn {
        ssh: Arc::new(handle),
        sftp: Arc::new(sftp),
        auth_method,
    }))
}

async fn authenticate_session(
    handle: &mut client::Handle<ClientHandler>,
    target: &ResolvedSftpTarget,
    creds: &SftpCredentials,
) -> io::Result<String> {
    let mut attempts: Vec<String> = Vec::new();
    let rsa_hash_alg: Option<HashAlg> = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();

    // 1. Try SSH Agent first when pubkey auth is allowed
    if target.pubkey_auth_allowed {
        if let Some(method) =
            try_agent_authentication(handle, &target.user, rsa_hash_alg, &mut attempts).await
        {
            return Ok(method);
        }
    }

    // 2. Try explicit private key, ~/.ssh/config IdentityFile, and default keys
    if target.pubkey_auth_allowed {
        let mut key_candidates: Vec<PathBuf> = Vec::new();
        if let Some(ref explicit_key) = creds.private_key_path {
            key_candidates.push(explicit_key.clone());
        }
        for path in &target.identity_files {
            if !key_candidates.contains(path) {
                key_candidates.push(path.clone());
            }
        }

        let passphrase = creds.passphrase.as_deref().or(creds.password.as_deref());
        for key_path in key_candidates {
            if !key_path.is_file() {
                continue;
            }
            let key_label = key_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| key_path.to_string_lossy().to_string());

            let loaded = match load_secret_key(&key_path, None) {
                Ok(k) => Ok(k),
                Err(_) => {
                    if let Some(pass) = passphrase {
                        load_secret_key(&key_path, Some(pass))
                    } else {
                        Err(russh::keys::Error::KeyIsEncrypted)
                    }
                }
            };

            let Ok(secret_key) = loaded else {
                attempts.push(format!("key:{key_label}(需密码或格式无效)"));
                continue;
            };
            let secret_arc = Arc::new(secret_key);

            // Try OpenSSH certificate if configured or `<key>-cert.pub` exists
            let cert_candidate = target.certificate_file.clone().or_else(|| {
                let mut s = key_path.as_os_str().to_os_string();
                s.push("-cert.pub");
                let p = PathBuf::from(s);
                p.is_file().then_some(p)
            });
            if let Some(cert_path) = cert_candidate {
                if let Ok(cert) = load_openssh_certificate(&cert_path) {
                    if let Ok(AuthResult::Success) = handle
                        .authenticate_openssh_cert(&target.user, secret_arc.clone(), cert)
                        .await
                    {
                        return Ok(format!("openssh-cert:{key_label}"));
                    }
                }
            }

            let key_with_hash = PrivateKeyWithHashAlg::new(secret_arc, rsa_hash_alg);
            match handle
                .authenticate_publickey(&target.user, key_with_hash)
                .await
            {
                Ok(AuthResult::Success) => return Ok(format!("publickey:{key_label}")),
                Ok(AuthResult::Failure { .. }) => {
                    attempts.push(format!("key:{key_label}(被服务器拒绝)"));
                }
                Err(e) => {
                    attempts.push(format!("key:{key_label}({e})"));
                }
            }
        }
    }

    // 3. Password / keyboard-interactive fallback
    if let Some(ref password) = creds.password {
        match handle.authenticate_password(&target.user, password).await {
            Ok(AuthResult::Success) => return Ok("password".to_string()),
            Ok(AuthResult::Failure { .. }) => attempts.push("password(认证失败)".to_string()),
            Err(e) => attempts.push(format!("password({e})")),
        }

        if let Ok(KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. }) = handle
            .authenticate_keyboard_interactive_start(&target.user, None)
            .await
        {
            let responses = vec![password.clone(); prompts.len()];
            if let Ok(KeyboardInteractiveAuthResponse::Success) =
                handle.authenticate_keyboard_interactive_respond(responses).await
            {
                return Ok("keyboard-interactive".to_string());
            }
        }
    }

    let detail = if attempts.is_empty() {
        "未找到可用的 SSH Agent 或本地私钥，且未提供密码".to_string()
    } else {
        attempts.join("; ")
    };
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "SFTP 认证失败 ({}@{}:{}): {detail}",
            target.user, target.connect_host, target.port
        ),
    ))
}

#[cfg(unix)]
async fn try_agent_authentication(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    rsa_hash_alg: Option<HashAlg>,
    attempts: &mut Vec<String>,
) -> Option<String> {
    let mut agent = match AgentClient::connect_env().await {
        Ok(a) => a,
        Err(_) => return None,
    };
    try_agent_identities(handle, user, rsa_hash_alg, &mut agent, attempts).await
}

#[cfg(windows)]
async fn try_agent_authentication(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    rsa_hash_alg: Option<HashAlg>,
    attempts: &mut Vec<String>,
) -> Option<String> {
    if let Ok(mut pipe_agent) =
        AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
    {
        if let Some(m) =
            try_agent_identities(handle, user, rsa_hash_alg, &mut pipe_agent, attempts).await
        {
            return Some(m);
        }
    }
    if let Ok(mut pageant) = AgentClient::connect_pageant().await {
        if let Some(m) =
            try_agent_identities(handle, user, rsa_hash_alg, &mut pageant, attempts).await
        {
            return Some(m);
        }
    }
    None
}

async fn try_agent_identities<S: russh::keys::agent::client::AgentStream + Send + Unpin>(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    rsa_hash_alg: Option<HashAlg>,
    agent: &mut AgentClient<S>,
    attempts: &mut Vec<String>,
) -> Option<String> {
    let Ok(identities) = agent.request_identities().await else {
        return None;
    };
    for identity in identities {
        let pub_key = match identity {
            AgentIdentity::PublicKey { key, .. } => key,
            AgentIdentity::Certificate { certificate, .. } => {
                certificate.public_key().clone().into()
            }
        };
        let alg = if pub_key.algorithm().is_rsa() {
            rsa_hash_alg
        } else {
            None
        };
        match handle
            .authenticate_publickey_with(user, pub_key, alg, agent)
            .await
        {
            Ok(AuthResult::Success) => return Some("ssh-agent".to_string()),
            Ok(AuthResult::Failure { .. }) => {
                attempts.push("ssh-agent(密钥被拒绝)".to_string());
            }
            Err(e) => {
                attempts.push(format!("ssh-agent({e})"));
            }
        }
    }
    None
}

/// Primes the in-memory credential cache when an SFTP URI carries an explicit password.
pub fn prime_location_credentials(loc: &SftpLocation) {
    if loc.password.is_none() {
        return;
    }
    if let Ok(pool) = global_pool() {
        let (_target, key, creds) = build_creds(loc, None);
        pool.cache_credentials(key, creds);
    }
}

/// Primes the in-memory credential cache using explicit `SftpConnectOptions` (e.g. from saved site).
pub fn prime_location_credentials_with_opts(loc: &SftpLocation, opts: &SftpConnectOptions) {
    if let Ok(pool) = global_pool() {
        let (_target, key, creds) = build_creds(loc, Some(opts));
        if creds.password.is_some()
            || creds.private_key_path.is_some()
            || creds.passphrase.is_some()
        {
            pool.cache_credentials(key, creds);
        }
    }
}

fn build_creds(loc: &SftpLocation, opts: Option<&SftpConnectOptions>) -> (ResolvedSftpTarget, PoolKey, SftpCredentials) {
    let target = resolve_ssh_connection_params(loc);
    let key = PoolKey {
        connect_host: target.connect_host.clone(),
        port: target.port,
        user: target.user.clone(),
    };
    let explicit_creds = SftpCredentials {
        password: opts
            .and_then(|o| o.password.as_ref())
            .filter(|s| !s.is_empty())
            .cloned()
            .or_else(|| loc.password.clone()),
        private_key_path: opts
            .and_then(|o| o.private_key_path.as_ref())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(expand_path),
        passphrase: opts
            .and_then(|o| o.passphrase.as_ref())
            .filter(|s| !s.is_empty())
            .cloned(),
    };
    (target, key, explicit_creds)
}

fn run_with_sftp_session<T, F, Fut>(
    loc: &SftpLocation,
    opts: Option<&SftpConnectOptions>,
    op: F,
) -> io::Result<(Arc<PooledConn>, T)>
where
    F: Fn(Arc<SftpSession>, String) -> Fut,
    Fut: Future<Output = io::Result<T>>,
{
    let pool = global_pool()?;
    let (target, key, explicit_creds) = build_creds(loc, opts);
    pool.cache_credentials(key.clone(), explicit_creds.clone());

    let effective_creds = if explicit_creds.password.is_some()
        || explicit_creds.private_key_path.is_some()
        || explicit_creds.passphrase.is_some()
    {
        explicit_creds
    } else {
        pool.cached_credentials(&key).unwrap_or_default()
    };

    let slot = pool.slot_for(&key);

    pool.block_on(async {
        let mut retried = false;
        loop {
            let conn = {
                let mut guard = slot.lock().await;
                let need_connect = match guard.as_ref() {
                    Some(existing) => existing.ssh.is_closed(),
                    None => true,
                };
                if need_connect {
                    let fresh = establish_sftp_connection(&target, &effective_creds).await?;
                    *guard = Some(fresh.clone());
                    fresh
                } else {
                    guard.as_ref().unwrap().clone()
                }
            };

            let remote_path = resolve_remote_tilde(&conn.sftp, &loc.remote_path).await;
            match op(conn.sftp.clone(), remote_path).await {
                Ok(val) => return Ok((conn, val)),
                Err(err) => {
                    if !retried && (conn.ssh.is_closed() || is_transport_error(&err)) {
                        retried = true;
                        let mut guard = slot.lock().await;
                        if guard.as_ref().is_some_and(|c| Arc::ptr_eq(c, &conn)) {
                            *guard = None;
                        }
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    })
}

async fn resolve_remote_tilde(sftp: &SftpSession, raw_path: &str) -> String {
    if raw_path == "~" {
        if let Ok(home) = sftp.canonicalize(".").await {
            return home;
        }
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        if let Ok(home) = sftp.canonicalize(".").await {
            return if home == "/" {
                format!("/{rest}")
            } else {
                format!("{}/{}", home.trim_end_matches('/'), rest)
            };
        }
    }
    raw_path.to_string()
}

fn is_transport_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::NotConnected
    )
}

fn map_sftp_err(context: &str, err: russh_sftp::client::error::Error) -> io::Error {
    let msg = err.to_string();
    let lower = msg.to_ascii_lowercase();
    let kind = if lower.contains("no such file") || lower.contains("not found") {
        io::ErrorKind::NotFound
    } else if lower.contains("permission denied") {
        io::ErrorKind::PermissionDenied
    } else if lower.contains("timeout") || lower.contains("timed out") {
        io::ErrorKind::TimedOut
    } else if lower.contains("eof") || lower.contains("closed") || lower.contains("channel") {
        io::ErrorKind::BrokenPipe
    } else {
        io::ErrorKind::Other
    };
    io::Error::new(kind, format!("{context}: {msg}"))
}

/// Resolves a connection request from either an explicit URI or structured host/port/user/path fields.
pub fn location_from_connect_options(opts: &SftpConnectOptions) -> Result<SftpLocation, String> {
    if let Some(ref raw_uri) = opts.uri {
        let trimmed = raw_uri.trim();
        if !trimmed.is_empty() {
            let mut loc = if is_sftp_uri(trimmed) {
                SftpLocation::parse(trimmed)?
            } else {
                SftpLocation {
                    host: trimmed.to_string(),
                    port: None,
                    user: None,
                    password: None,
                    remote_path: ".".to_string(),
                }
            };
            if let Some(ref p) = opts.path {
                if !p.trim().is_empty() {
                    loc.remote_path = p.trim().to_string();
                }
            }
            if let Some(ref u) = opts.user {
                if !u.trim().is_empty() {
                    loc.user = Some(u.trim().to_string());
                }
            }
            if let Some(port) = opts.port {
                loc.port = Some(port);
            }
            if let Some(ref pwd) = opts.password {
                if !pwd.is_empty() {
                    loc.password = Some(pwd.clone());
                }
            }
            return Ok(loc);
        }
    }

    let host = opts
        .host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "请提供 SFTP 主机名或 sftp:// URI".to_string())?
        .to_string();

    let remote_path = opts
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(".")
        .to_string();

    Ok(SftpLocation {
        host,
        port: opts.port,
        user: opts
            .user
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        password: opts.password.as_ref().filter(|s| !s.is_empty()).cloned(),
        remote_path,
    })
}

/// Tests an SFTP connection and caches valid credentials/session in the pool.
pub fn test_sftp_connection(opts: &SftpConnectOptions) -> Result<SftpConnectionTestResult, String> {
    let loc = location_from_connect_options(opts)?;
    let target = resolve_ssh_connection_params(&loc);

    let (conn, canonical_path) = run_with_sftp_session(&loc, Some(opts), |sftp, path| async move {
        let resolved = sftp
            .canonicalize(path.clone())
            .await
            .unwrap_or(path);
        // Verify stat works on resolved path (or fallback to ".")
        if sftp.metadata(resolved.clone()).await.is_err() {
            let cwd = sftp
                .canonicalize(".")
                .await
                .map_err(|e| map_sftp_err("SFTP 路径验证失败", e))?;
            return Ok(cwd);
        }
        Ok(resolved)
    })
    .map_err(|e| e.to_string())?;

    let mut clean_loc = loc.clone();
    clean_loc.user = Some(target.user.clone());
    clean_loc.port = Some(target.port);
    clean_loc.remote_path = canonical_path.clone();

    Ok(SftpConnectionTestResult {
        ok: true,
        resolved_uri: clean_loc.to_uri(),
        host: target.connect_host,
        port: target.port,
        user: target.user,
        remote_path: canonical_path,
        auth_method: conn.auth_method.clone(),
    })
}

pub fn sftp_read_bytes(uri: &str) -> io::Result<Vec<u8>> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let (_, bytes) = run_with_sftp_session(&loc, None, |sftp, path| async move {
        sftp.read(path)
            .await
            .map_err(|e| map_sftp_err("读取 SFTP 文件失败", e))
    })?;
    Ok(bytes)
}

pub fn build_sftp_mtime_attrs(modified_ms: u64) -> Option<FileAttributes> {
    if modified_ms == 0 {
        return None;
    }
    let secs = u32::try_from(modified_ms / 1000).unwrap_or(u32::MAX);
    Some(FileAttributes {
        atime: Some(secs),
        mtime: Some(secs),
        ..Default::default()
    })
}

pub fn sftp_write_bytes(uri: &str, bytes: &[u8]) -> io::Result<()> {
    sftp_write_bytes_with_mtime(uri, bytes, None)
}

pub fn sftp_write_bytes_with_mtime(
    uri: &str,
    bytes: &[u8],
    modified_ms: Option<u64>,
) -> io::Result<()> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let payload = bytes.to_vec();
    let attrs = modified_ms.and_then(build_sftp_mtime_attrs);
    let (_, ()) = run_with_sftp_session(&loc, None, move |sftp, path| {
        let data = payload.clone();
        let attrs = attrs.clone();
        async move {
            ensure_remote_parent_dirs(&sftp, &path).await?;
            let mut file = sftp
                .open_with_flags(
                    &path,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(|e| map_sftp_err("打开 SFTP 写入文件失败", e))?;
            file.write_all(&data).await?;
            file.flush().await?;
            file.shutdown().await?;
            if let Some(attrs) = attrs {
                let _ = sftp.set_metadata(path, attrs).await;
            }
            Ok(())
        }
    })?;
    Ok(())
}

async fn ensure_remote_parent_dirs(sftp: &SftpSession, remote_file_path: &str) -> io::Result<()> {
    let Some((parent, _)) = remote_file_path.rsplit_once('/') else {
        return Ok(());
    };
    if parent.is_empty() || parent == "/" {
        return Ok(());
    }
    ensure_remote_dir_all_inner(sftp, parent).await
}

async fn ensure_remote_dir_all_inner(sftp: &SftpSession, dir_path: &str) -> io::Result<()> {
    let trimmed = dir_path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(());
    }
    if sftp.try_exists(trimmed).await.unwrap_or(false) {
        return Ok(());
    }
    let is_abs = trimmed.starts_with('/');
    let mut cur = if is_abs {
        String::from("/")
    } else {
        String::new()
    };
    for part in trimmed.split('/').filter(|s| !s.is_empty()) {
        if cur == "/" {
            cur.push_str(part);
        } else if cur.is_empty() {
            cur.push_str(part);
        } else {
            cur.push('/');
            cur.push_str(part);
        }
        if !sftp.try_exists(cur.as_str()).await.unwrap_or(false) {
            let _ = sftp.create_dir(cur.as_str()).await;
        }
    }
    Ok(())
}

pub fn sftp_create_dir_all(uri: &str) -> io::Result<()> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let (_, ()) = run_with_sftp_session(&loc, None, |sftp, path| async move {
        ensure_remote_dir_all_inner(&sftp, &path).await
    })?;
    Ok(())
}

pub fn sftp_metadata(uri: &str) -> io::Result<SftpMetadataInfo> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let (_, meta) = run_with_sftp_session(&loc, None, |sftp, path| async move {
        let attrs = sftp
            .metadata(path)
            .await
            .map_err(|e| map_sftp_err("获取 SFTP 文件元数据失败", e))?;
        Ok(SftpMetadataInfo {
            is_dir: attrs.is_dir(),
            is_file: attrs.is_regular() || (!attrs.is_dir() && attrs.size.is_some()),
            size: attrs.size.unwrap_or(0),
            modified_ms: attrs.mtime.map(|m| (m as u64) * 1000).unwrap_or(0),
        })
    })?;
    Ok(meta)
}

pub fn sftp_exists(uri: &str) -> bool {
    let Ok(loc) = SftpLocation::parse(uri) else {
        return false;
    };
    run_with_sftp_session(&loc, None, |sftp, path| async move {
        Ok(sftp.try_exists(path).await.unwrap_or(false))
    })
    .map(|(_, exists)| exists)
    .unwrap_or(false)
}

pub fn sftp_is_dir(uri: &str) -> bool {
    sftp_metadata(uri).map(|m| m.is_dir).unwrap_or(false)
}

pub fn sftp_list_dir(
    uri: &str,
    opts: Option<&SftpConnectOptions>,
) -> io::Result<SftpDirListing> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

    let (_, (canonical_dir, entries)) =
        run_with_sftp_session(&loc, opts, |sftp, path| async move {
            let resolved_dir = sftp
                .canonicalize(path.clone())
                .await
                .unwrap_or(path);
            let rd = sftp
                .read_dir(resolved_dir.clone())
                .await
                .map_err(|e| map_sftp_err("读取 SFTP 目录失败", e))?;

            let mut list = Vec::new();
            for entry in rd {
                let name = entry.file_name();
                let attrs = entry.metadata();
                let mut is_dir = attrs.is_dir();
                let mut size = attrs.size.unwrap_or(0);
                let mut modified_ms = attrs.mtime.map(|m| (m as u64) * 1000).unwrap_or(0);

                // Follow symlinks so symlinked dirs/files display accurate type and size
                if entry.file_type().is_symlink() {
                    let full_child = if resolved_dir == "/" {
                        format!("/{name}")
                    } else {
                        format!("{}/{}", resolved_dir.trim_end_matches('/'), name)
                    };
                    if let Ok(target_attrs) = sftp.metadata(full_child).await {
                        is_dir = target_attrs.is_dir();
                        size = target_attrs.size.unwrap_or(size);
                        modified_ms = target_attrs
                            .mtime
                            .map(|m| (m as u64) * 1000)
                            .unwrap_or(modified_ms);
                    }
                }

                list.push((name, is_dir, size, modified_ms));
            }
            Ok((resolved_dir, list))
        })?;

    let current_uri = loc.to_uri_with_path(&canonical_dir);
    let parent_uri = remote_parent_path(&canonical_dir).map(|p| loc.to_uri_with_path(&p));

    let mut mapped_entries: Vec<SftpEntryInfo> = entries
        .into_iter()
        .map(|(name, is_dir, size, modified_ms)| {
            let child_path = if canonical_dir == "/" {
                format!("/{name}")
            } else {
                format!("{}/{}", canonical_dir.trim_end_matches('/'), name)
            };
            SftpEntryInfo {
                uri: loc.to_uri_with_path(&child_path),
                name,
                is_dir,
                size: if is_dir { 0 } else { size },
                modified_ms,
            }
        })
        .collect();

    mapped_entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(SftpDirListing {
        current_uri,
        parent_uri,
        entries: mapped_entries,
    })
}

fn remote_parent_path(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return None;
    }
    match trimmed.rsplit_once('/') {
        Some(("", _)) => Some("/".to_string()),
        Some((parent, _)) => Some(parent.to_string()),
        None => None,
    }
}

pub fn sftp_hash_file_blake3(uri: &str) -> io::Result<blake3::Hash> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let (_, hash) = run_with_sftp_session(&loc, None, |sftp, path| async move {
        let mut file = sftp
            .open(path)
            .await
            .map_err(|e| map_sftp_err("打开 SFTP 文件计算哈希失败", e))?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize())
    })?;
    Ok(hash)
}

pub fn sftp_remove_any(uri: &str) -> io::Result<()> {
    let loc = SftpLocation::parse(uri)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let (_, ()) = run_with_sftp_session(&loc, None, |sftp, path| async move {
        if !sftp.try_exists(path.as_str()).await.unwrap_or(false) {
            return Ok(());
        }
        let attrs = sftp
            .metadata(path.as_str())
            .await
            .map_err(|e| map_sftp_err("获取 SFTP 删除目标属性失败", e))?;
        if attrs.is_dir() {
            remove_remote_dir_recursive(&sftp, &path).await
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|e| map_sftp_err("删除 SFTP 文件失败", e))
        }
    })?;
    Ok(())
}

fn remove_remote_dir_recursive<'a>(
    sftp: &'a SftpSession,
    dir_path: &'a str,
) -> std::pin::Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let rd = sftp
            .read_dir(dir_path)
            .await
            .map_err(|e| map_sftp_err("列出 SFTP 待删除目录失败", e))?;
        for entry in rd {
            let name = entry.file_name();
            let child = if dir_path == "/" {
                format!("/{name}")
            } else {
                format!("{}/{}", dir_path.trim_end_matches('/'), name)
            };
            if entry.metadata().is_dir() {
                remove_remote_dir_recursive(sftp, &child).await?;
            } else {
                sftp.remove_file(child)
                    .await
                    .map_err(|e| map_sftp_err("删除 SFTP 子文件失败", e))?;
            }
        }
        sftp.remove_dir(dir_path)
            .await
            .map_err(|e| map_sftp_err("删除 SFTP 空目录失败", e))
    })
}

#[cfg(test)]
mod mtime_tests {
    use super::*;

    #[test]
    fn build_sftp_mtime_attrs_converts_ms_and_skips_zero() {
        assert!(build_sftp_mtime_attrs(0).is_none());
        let attrs = build_sftp_mtime_attrs(1_700_000_123_456).expect("expected attrs");
        assert_eq!(attrs.atime, Some(1_700_000_123));
        assert_eq!(attrs.mtime, Some(1_700_000_123));
    }
}
