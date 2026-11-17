use freecompare_core::{
    diff::two_way::{DiffOptions, TwoWaySession},
    encode_string, expand_path,
    folder::{
        apply_folder_item_operation, compare_folders, FolderCompareMode, FolderCompareOptions,
        FolderItemStatus, FolderSyncActionKind,
    },
    sftp::{
        is_sftp_uri, list_ssh_config_hosts_from_file, resolve_ssh_connection_params_with_config,
        sftp_list_dir, test_sftp_connection, SftpConnectOptions, SftpLocation,
    },
    vfs::{self, VfsPath},
    CliInvocation, EncodingKind, LineEnding, TextBuffer,
};
use russh::keys::decode_secret_key;
use russh::server::{Auth, Msg, Server as _, Session, VerifiedPublicKey};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::sync::Mutex;

const TEST_RSA_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEAuSvQ9m76zhRB4m0BUKPf17lwccj7KQ1Qtse63AOqP/VYItqEH8un
rxPogXNBgrcCEm/ccLZZsyE3qgp3DRQkkqvJhZ6O8VBPsXxjZesRCqoFNCczy+Mf0R/Qmv
Rnpu5+4DDLz0p7vrsRZW9ji/c98KzxeUonWgkplQaCBYLN875WdeUYMGtb1MLfNCEj177j
gZl3CzttLRK3su6dckowXcXYv1gPTPZAwJb49J43o1QhV7+1zdwXvuFM6zuYHdu9ZHSKir
6k1dXOET3/U+LWG5ofAo8oxUWv/7vs6h7MeajwkUeIBOWYtD+wGYRvVpxvj7nyOoWtg+jm
0X6ndnsD+QAAA8irV+ZAq1fmQAAAAAdzc2gtcnNhAAABAQC5K9D2bvrOFEHibQFQo9/XuX
BxyPspDVC2x7rcA6o/9Vgi2oQfy6evE+iBc0GCtwISb9xwtlmzITeqCncNFCSSq8mFno7x
UE+xfGNl6xEKqgU0JzPL4x/RH9Ca9Gem7n7gMMvPSnu+uxFlb2OL9z3wrPF5SidaCSmVBo
IFgs3zvlZ15Rgwa1vUwt80ISPXvuOBmXcLO20tErey7p1ySjBdxdi/WA9M9kDAlvj0njej
VCFXv7XN3Be+4UzrO5gd271kdIqKvqTV1c4RPf9T4tYbmh8CjyjFRa//u+zqHsx5qPCRR4
gE5Zi0P7AZhG9WnG+PufI6ha2D6ObRfqd2ewP5AAAAAwEAAQAAAQAdELqhI/RsSpO45eFR
9hcZtnrm8WQzImrr9dfn1w9vMKSf++rHTuFIQvi48Q10ZiOGH1bbvlPAIVOqdjAPtnyzJR
HhzmyjhjasJlk30zj+kod0kz63HzSMT9EfsYNfmYoCyMYFCKz52EU3xc87Vhi74XmZz0D0
CgIj6TyZftmzC4YJCiwwU8K+29nxBhcbFRxpgwAksFL6PCSQsPl4y7yvXGcX+7lpZD8547
v58q3jIkH1g2tBOusIuaiphDDStVJhVdKA55Z0Kju2kvCqsRIlf1efrq43blRgJFFFCxNZ
8Cpolt4lOHhg+o3ucjILlCOgjDV8dB21YLxmgN5q+xFNAAAAgQC1P+eLUkHDFXnleCEVrW
xL/DFxEyneLQz3IawGdw7cyAb7vxsYrGUvbVUFkxeiv397pDHLZ5U+t5cOYDBZ7G43Mt2g
YfWBuRNvYhHA9Sdf38m5qPA6XCvm51f+FxInwd/kwRKH01RHJuRGsl/4Apu4DqVob8y00V
WTYyV6JBNDkQAAAIEA322lj7ZJXfK/oLhMM/RS+DvaMea1g/q43mdRJFQQso4XRCL6IIVn
oZXFeOxrMIRByVZBw+FSeB6OayWcZMySpJQBo70GdJOc3pJb3js0T+P2XA9+/jwXS58K9a
+IkgLkv9XkfxNGNKyPEEzXC8QQzvjs1LbmO59VLko8ypwHq/cAAACBANQqaULI0qdwa0vm
d3Ae1+k3YLZ0kapSQGVIMT2lkrhKV35tj7HIFpUPa4vitHzcUwtjYhqFezVF+JyPbJ/Fsp
XmEc0g1fFnQp5/SkUwoN2zm8Up52GBelkq2Jk57mOMzWO0QzzNuNV/feJk02b2aE8rrAqP
QR+u0AypRPmzHnOPAAAAEXJvb3RAMTQwOTExNTQ5NDBkAQ==
-----END OPENSSH PRIVATE KEY-----";

#[test]
fn test_sftp_uri_parsing_and_expand_path_preservation() {
    assert!(is_sftp_uri("sftp://host/var/log"));
    assert!(is_sftp_uri("SFTP://user@host:2222/etc/nginx"));
    assert!(!is_sftp_uri("/tmp/file.txt"));

    let loc = SftpLocation::parse("sftp://alice:p%40ss@prod.example.com:2222/srv/app/cfg.toml")
        .unwrap();
    assert_eq!(loc.user.as_deref(), Some("alice"));
    assert_eq!(loc.password.as_deref(), Some("p@ss"));
    assert_eq!(loc.host, "prod.example.com");
    assert_eq!(loc.port, Some(2222));
    assert_eq!(loc.remote_path, "/srv/app/cfg.toml");
    // Display URI never leaks password
    assert_eq!(
        loc.to_uri(),
        "sftp://alice@prod.example.com:2222/srv/app/cfg.toml"
    );
    assert_eq!(loc.file_name(), "cfg.toml");

    let joined = SftpLocation::parse("sftp://deploy@prod-web/srv/app")
        .unwrap()
        .join_rel("sub/main.rs");
    assert_eq!(joined.remote_path, "/srv/app/sub/main.rs");
    assert_eq!(joined.to_uri(), "sftp://deploy@prod-web/srv/app/sub/main.rs");

    let home_loc = SftpLocation::parse("sftp://my_alias").unwrap();
    assert_eq!(home_loc.remote_path, ".");
    let tilde_loc = SftpLocation::parse("sftp://my_alias/~/projects/demo").unwrap();
    assert_eq!(tilde_loc.remote_path, "~/projects/demo");

    // Roundtrip special characters (`#`, `?`, `%`, spaces, Unicode) without fragment/query truncation
    let base_loc = SftpLocation::parse("sftp://deploy@prod-web:2222/srv/logs").unwrap();
    let special_name = "report #1?ok=100% final 日志.txt";
    let special_loc = base_loc.join_rel(special_name);
    let special_uri = special_loc.to_uri();
    assert!(special_uri.contains("%23"));
    assert!(special_uri.contains("%3F"));
    assert!(special_uri.contains("%25"));
    assert!(special_uri.contains("%20"));
    let reparsed = SftpLocation::parse(&special_uri).unwrap();
    assert_eq!(reparsed.remote_path, format!("/srv/logs/{special_name}"));
    assert_eq!(reparsed.file_name(), special_name);

    // `expand_path` and `CliInvocation::parse` must preserve `sftp://` URIs untouched
    let raw_uri = "sftp://deploy@prod-web:2222/var/log/app.log";
    assert_eq!(expand_path(raw_uri), PathBuf::from(raw_uri));

    let inv = CliInvocation::parse([
        raw_uri,
        "local.txt",
        "base.txt",
        "-mergeoutput=sftp://deploy@prod-web/var/log/merged.log",
    ])
    .unwrap();
    assert_eq!(inv.left_path(), Some(Path::new(raw_uri)));
    assert_eq!(
        inv.resolved_merge_output_path(),
        Some(PathBuf::from("sftp://deploy@prod-web/var/log/merged.log"))
    );
}

#[test]
fn test_ssh_config_host_listing_and_param_resolution() {
    let dir = tempdir().unwrap();
    let cfg_path = dir.path().join("ssh_config");
    fs::write(
        &cfg_path,
        r#"
Host prod-web
    HostName 10.20.30.40
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_prod_ed25519
    AddKeysToAgent yes

Host staging-api jump-box
    HostName staging.internal
    User ops

Host !excluded *
    User fallback_user
"#,
    )
    .unwrap();

    let hosts = list_ssh_config_hosts_from_file(&cfg_path);
    let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
    assert_eq!(aliases, vec!["prod-web", "staging-api", "jump-box"]);

    assert_eq!(hosts[0].host_name, "10.20.30.40");
    assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    assert_eq!(hosts[0].port, 2222);
    assert!(!hosts[0].identity_files.is_empty());

    // URI omits user/port -> resolved from ~/.ssh/config
    let loc_from_alias = SftpLocation::parse("sftp://prod-web/etc/app.conf").unwrap();
    let resolved = resolve_ssh_connection_params_with_config(&loc_from_alias, Some(&cfg_path));
    assert_eq!(resolved.connect_host, "10.20.30.40");
    assert_eq!(resolved.port, 2222);
    assert_eq!(resolved.user, "deploy");

    // URI overrides user/port explicitly -> URI takes precedence
    let loc_override = SftpLocation::parse("sftp://admin@prod-web:3333/etc/app.conf").unwrap();
    let resolved_override =
        resolve_ssh_connection_params_with_config(&loc_override, Some(&cfg_path));
    assert_eq!(resolved_override.connect_host, "10.20.30.40");
    assert_eq!(resolved_override.port, 3333);
    assert_eq!(resolved_override.user, "admin");
}

#[test]
fn test_vfs_local_operations() {
    let dir = tempdir().unwrap();
    let src_dir = dir.path().join("src_dir");
    let dst_dir = dir.path().join("dst_dir");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(src_dir.join("hello.txt"), b"hello vfs").unwrap();

    let src_vfs = VfsPath::parse(&src_dir.to_string_lossy()).unwrap();
    assert!(!src_vfs.is_sftp());
    assert_eq!(src_vfs.join_rel("hello.txt").extension().as_deref(), Some("txt"));

    vfs::copy_recursive(&src_dir.to_string_lossy(), &dst_dir.to_string_lossy()).unwrap();
    assert_eq!(
        vfs::read_bytes(&dst_dir.join("hello.txt").to_string_lossy()).unwrap(),
        b"hello vfs"
    );
    vfs::remove_any(&dst_dir.to_string_lossy()).unwrap();
    assert!(!dst_dir.exists());
}

// =============================================================================
// In-process Real SSH/SFTP Server Integration Tests (Ed25519 + Password + VFS)
// =============================================================================

#[derive(Clone)]
struct TestSshServer {
    root: PathBuf,
    expected_pubkey_bytes: Vec<u8>,
}

impl russh::server::Server for TestSshServer {
    type Handler = TestSshSession;

    fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
        TestSshSession {
            root: self.root.clone(),
            expected_pubkey_bytes: self.expected_pubkey_bytes.clone(),
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct TestSshSession {
    root: PathBuf,
    expected_pubkey_bytes: Vec<u8>,
    clients: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl russh::server::Handler for TestSshSession {
    type Error = anyhow::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "pwduser" && password == "s3cr3t!" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        if user == "keyuser"
            && key.public_key.to_bytes().ok().as_deref() == Some(&self.expected_pubkey_bytes)
        {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.clients.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.clients.lock().await.remove(&channel_id).unwrap();
            let sftp = LocalBackedSftp::new(self.root.clone());
            session.channel_success(channel_id)?;
            russh_sftp::server::run(channel.into_stream(), sftp).await;
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

struct OpenHandle {
    path: PathBuf,
    dir_entries: Option<Vec<File>>,
    dir_done: bool,
}

struct LocalBackedSftp {
    root: PathBuf,
    next_id: u64,
    handles: HashMap<String, OpenHandle>,
}

impl LocalBackedSftp {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            next_id: 1,
            handles: HashMap::new(),
        }
    }

    fn resolve(&self, remote: &str) -> PathBuf {
        let trimmed = remote.trim();
        if trimmed.is_empty() || trimmed == "." || trimmed == "/" {
            return self.root.clone();
        }
        let mut out = self.root.clone();
        for comp in trimmed.trim_start_matches('/').split('/') {
            if !comp.is_empty() && comp != "." && comp != ".." {
                out.push(comp);
            }
        }
        out
    }

    fn attrs_for(meta: &fs::Metadata) -> FileAttributes {
        let mut attrs = FileAttributes::default();
        attrs.size = Some(meta.len());
        let mode = if meta.is_dir() { 0o040755 } else { 0o100644 };
        attrs.permissions = Some(mode);
        attrs.mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as u32);
        attrs
    }

    fn ok_status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }
}

impl russh_sftp::server::Handler for LocalBackedSftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(Self::ok_status(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = self.resolve(&path);
        let rel = resolved
            .strip_prefix(&self.root)
            .unwrap_or(Path::new(""));
        let posix = if rel.as_os_str().is_empty() {
            "/".to_string()
        } else {
            format!("/{}", rel.to_string_lossy().replace('\\', "/"))
        };
        Ok(Name {
            id,
            files: vec![File::dummy(posix)],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let p = self.resolve(&path);
        let meta = fs::metadata(&p).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: Self::attrs_for(&meta),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let p = self.resolve(&path);
        let rd = fs::read_dir(&p).map_err(|_| StatusCode::NoSuchFile)?;
        let mut files = Vec::new();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = fs::metadata(entry.path()).map_err(|_| StatusCode::Failure)?;
            files.push(File::new(name, Self::attrs_for(&meta)));
        }
        let h = format!("d{}", self.next_id);
        self.next_id += 1;
        self.handles.insert(
            h.clone(),
            OpenHandle {
                path: p,
                dir_entries: Some(files),
                dir_done: false,
            },
        );
        Ok(Handle { id, handle: h })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some(entry) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        if entry.dir_done {
            return Err(StatusCode::Eof);
        }
        entry.dir_done = true;
        Ok(Name {
            id,
            files: entry.dir_entries.take().unwrap_or_default(),
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let p = self.resolve(&filename);
        if pflags.contains(OpenFlags::CREATE) {
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if pflags.contains(OpenFlags::TRUNCATE) || !p.exists() {
                fs::write(&p, b"").map_err(|_| StatusCode::Failure)?;
            }
        } else if !p.is_file() {
            return Err(StatusCode::NoSuchFile);
        }
        let h = format!("f{}", self.next_id);
        self.next_id += 1;
        self.handles.insert(
            h.clone(),
            OpenHandle {
                path: p,
                dir_entries: None,
                dir_done: false,
            },
        );
        Ok(Handle { id, handle: h })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let Some(entry) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let meta = fs::metadata(&entry.path).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: Self::attrs_for(&meta),
        })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let Some(entry) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let bytes = fs::read(&entry.path).map_err(|_| StatusCode::Failure)?;
        let start = offset as usize;
        if start >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(bytes.len());
        Ok(Data {
            id,
            data: bytes[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let Some(entry) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let mut buf = fs::read(&entry.path).unwrap_or_default();
        let off = offset as usize;
        if off + data.len() > buf.len() {
            buf.resize(off + data.len(), 0);
        }
        buf[off..off + data.len()].copy_from_slice(&data);
        fs::write(&entry.path, buf).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let p = self.resolve(&path);
        fs::create_dir_all(&p).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&filename);
        fs::remove_file(&p).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Self::ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&path);
        fs::remove_dir(&p).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Self::ok_status(id))
    }
}

#[test]
fn test_real_sftp_e2e_key_auth_password_auth_buffer_and_folder_sync() {
    let remote_root = tempdir().unwrap();
    let local_root = tempdir().unwrap();
    let key_dir = tempdir().unwrap();

    // Seed remote directory with a GB18030+CRLF file and a subfolder
    fs::create_dir_all(remote_root.path().join("sub")).unwrap();
    fs::write(
        remote_root.path().join("remote.txt"),
        encode_string("远程行1\r\n远程行2\r\n", EncodingKind::Gb18030),
    )
    .unwrap();
    fs::write(remote_root.path().join("sub/shared.txt"), b"same_content\n").unwrap();

    // Seed local directory for Local <-> SFTP folder compare & sync
    fs::create_dir_all(local_root.path().join("sub")).unwrap();
    fs::write(
        local_root.path().join("remote.txt"),
        encode_string("远程行1\r\n远程行2\r\n", EncodingKind::Gb18030),
    )
    .unwrap();
    fs::write(local_root.path().join("sub/shared.txt"), b"same_content\n").unwrap();
    fs::write(local_root.path().join("local_only.txt"), b"upload_me\n").unwrap();

    // Write test private key to disk for pubkey auth
    let key_file = key_dir.path().join("id_rsa");
    fs::write(&key_file, TEST_RSA_KEY).unwrap();
    let parsed_key = decode_secret_key(TEST_RSA_KEY, None).unwrap();
    let expected_pubkey_bytes = parsed_key.public_key().to_bytes().unwrap();

    // Spawn in-process SSH/SFTP server on 127.0.0.1:0
    let rt = tokio::runtime::Runtime::new().unwrap();
    let port: u16 = rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let config = Arc::new(russh::server::Config {
            auth_rejection_time: Duration::from_millis(50),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            keys: vec![parsed_key],
            ..Default::default()
        });
        let mut server = TestSshServer {
            root: remote_root.path().to_path_buf(),
            expected_pubkey_bytes,
        };
        tokio::spawn(async move {
            let _ = server.run_on_socket(config, &listener).await;
        });
        addr.port()
    });

    // 1. Test pubkey authentication + `test_sftp_connection`
    let key_conn = test_sftp_connection(&SftpConnectOptions {
        host: Some("127.0.0.1".to_string()),
        port: Some(port),
        user: Some("keyuser".to_string()),
        private_key_path: Some(key_file.to_string_lossy().to_string()),
        path: Some("/".to_string()),
        ..Default::default()
    })
    .expect("pubkey auth should succeed");
    assert!(key_conn.ok);
    assert!(key_conn.auth_method.starts_with("publickey:"));

    // 2. Test `sftp_list_dir` reusing pooled connection (no credentials passed again!)
    let listing = sftp_list_dir(&format!("sftp://keyuser@127.0.0.1:{port}/"), None).unwrap();
    let entry_names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(entry_names.contains(&"sub"));
    assert!(entry_names.contains(&"remote.txt"));

    // 3. Test password auth URI + `TextBuffer::from_file` + `save` preserving GB18030 + CRLF
    let remote_file_uri = format!("sftp://pwduser:s3cr3t!@127.0.0.1:{port}/remote.txt");
    let mut buf = TextBuffer::from_file(&remote_file_uri).unwrap();
    assert_eq!(buf.encoding(), EncodingKind::Gb18030);
    assert_eq!(buf.line_ending(), LineEnding::CrLf);
    buf.edit_line(1, "远程行2_已修改".to_string()).unwrap();
    buf.save(None).unwrap();

    assert_eq!(
        fs::read(remote_root.path().join("remote.txt")).unwrap(),
        encode_string("远程行1\r\n远程行2_已修改\r\n", EncodingKind::Gb18030)
    );

    // 4. Test TwoWaySession Local <-> SFTP diff
    let two_way = TwoWaySession::from_files(
        local_root.path().join("remote.txt"),
        format!("sftp://keyuser@127.0.0.1:{port}/remote.txt"),
        DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(two_way.summary().hunks.len(), 1);

    // 5. Test Folder Compare Local <-> SFTP (recursive + BLAKE3) + Copy & Delete over SFTP
    let remote_folder_uri = format!("sftp://keyuser@127.0.0.1:{port}/");
    let opts = FolderCompareOptions {
        mode: FolderCompareMode::ContentHash,
        ignore_case_names: false,
        exclude_globs: vec![],
        recursive: true,
        max_depth: None,
    };
    let cmp_res = compare_folders(local_root.path(), &remote_folder_uri, &opts).unwrap();
    assert_eq!(cmp_res.stats.modified_items, 1); // remote.txt
    assert_eq!(cmp_res.stats.left_only_items, 1); // local_only.txt
    assert_eq!(cmp_res.stats.equal_items, 1); // sub/shared.txt
    assert_eq!(
        cmp_res
            .entries
            .iter()
            .find(|e| e.relative_path == "sub/shared.txt")
            .unwrap()
            .status,
        FolderItemStatus::Equal
    );

    // Copy `local_only.txt` from Local -> SFTP
    apply_folder_item_operation(
        local_root.path(),
        Path::new(&remote_folder_uri),
        "local_only.txt",
        FolderSyncActionKind::CopyLeftToRight,
    )
    .unwrap();
    assert_eq!(
        fs::read(remote_root.path().join("local_only.txt")).unwrap(),
        b"upload_me\n"
    );

    // Delete `local_only.txt` on SFTP
    apply_folder_item_operation(
        local_root.path(),
        Path::new(&remote_folder_uri),
        "local_only.txt",
        FolderSyncActionKind::DeleteRight,
    )
    .unwrap();
    assert!(!remote_root.path().join("local_only.txt").exists());
}
