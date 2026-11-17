//! Saved SFTP site profiles and AES-256-GCM encrypted local credential vault.
//!
//! Security guarantees:
//! - `sftp_sites.json` only stores non-secret metadata (`has_password` / `has_passphrase` booleans).
//! - Passwords & passphrases are encrypted at rest in `sftp_vault.json` using `ring::aead::AES_256_GCM`
//!   with a fresh 96-bit random nonce per secret and AAD bound to `(site_id, field)`.
//! - Decrypted secrets are zeroized on drop (`zeroize::Zeroizing`) and are never returned to the UI
//!   or embedded into `sftp://` URIs.
//! - On Unix, the config directory uses `0700` and the master key / vault / site files use `0600`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::RwLock;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::sftp::{SftpConnectOptions, SftpLocation};

const VAULT_VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const KEY_DERIVE_CONTEXT: &str = "freecompare.sftp.vault.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SftpSitePublic {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default = "default_remote_path")]
    pub remote_path: String,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub remember_password: bool,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub has_passphrase: bool,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
}

fn default_remote_path() -> String {
    "/".to_string()
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct SaveSftpSiteInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub remote_path: Option<String>,
    pub private_key_path: Option<String>,
    pub remember_password: bool,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub clear_password: bool,
    pub clear_passphrase: bool,
}

#[derive(Default)]
pub struct SftpSiteResolvedSecrets {
    pub password: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for SftpSiteResolvedSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpSiteResolvedSecrets")
            .field("has_password", &self.password.is_some())
            .field("has_passphrase", &self.passphrase.is_some())
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SealedSecret {
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SiteVaultEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<SealedSecret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    passphrase: Option<SealedSecret>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SftpVaultFile {
    version: u32,
    #[serde(default)]
    entries: HashMap<String, SiteVaultEntry>,
}

impl Default for SftpVaultFile {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            entries: HashMap::new(),
        }
    }
}

pub struct SftpSiteStore {
    sites_path: PathBuf,
    vault_path: PathBuf,
    master_key_path: PathBuf,
    sites: RwLock<Vec<SftpSitePublic>>,
    vault_lock: RwLock<()>,
}

impl Default for SftpSiteStore {
    fn default() -> Self {
        Self::new_default()
    }
}

impl SftpSiteStore {
    pub fn new_default() -> Self {
        let dir = default_config_dir().unwrap_or_else(|| PathBuf::from(".freecompare"));
        Self::with_dir(dir)
    }

    pub fn with_dir(dir: PathBuf) -> Self {
        let sites_path = dir.join("sftp_sites.json");
        let vault_path = dir.join("sftp_vault.json");
        let master_key_path = dir.join(".sftp_master.key");

        let initial_sites = fs::read_to_string(&sites_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<SftpSitePublic>>(&s).ok())
            .unwrap_or_default();

        Self {
            sites_path,
            vault_path,
            master_key_path,
            sites: RwLock::new(initial_sites),
            vault_lock: RwLock::new(()),
        }
    }

    pub fn list_sites(&self) -> Vec<SftpSitePublic> {
        self.sites.read().clone()
    }

    pub fn get_site(&self, id: &str) -> Option<SftpSitePublic> {
        self.sites.read().iter().find(|s| s.id == id).cloned()
    }

    /// Finds a saved site matching `(host, port, user)` when no explicit `site_id` is provided.
    pub fn find_matching_site(
        &self,
        host: &str,
        port: Option<u16>,
        user: Option<&str>,
    ) -> Option<SftpSitePublic> {
        let h = host.trim();
        let u = user.map(str::trim).filter(|s| !s.is_empty());
        self.sites
            .read()
            .iter()
            .find(|s| {
                s.host.eq_ignore_ascii_case(h)
                    && (port.is_none() || s.port == port || (port == Some(22) && s.port.is_none()))
                    && (u.is_none() || s.user.as_deref() == u)
            })
            .cloned()
    }

    pub fn save_site(&self, input: SaveSftpSiteInput) -> Result<SftpSitePublic, String> {
        let host = input.host.trim().to_string();
        if host.is_empty() {
            return Err("SFTP 主机地址不能为空".to_string());
        }

        let user = input
            .user
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let port = input.port.filter(|&p| p > 0);
        let remote_path = normalize_remote_path(input.remote_path.as_deref());
        let private_key_path = input
            .private_key_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let name = {
            let trimmed = input.name.trim();
            if !trimmed.is_empty() {
                trimmed.to_string()
            } else if let Some(ref u) = user {
                format!("{u}@{host}")
            } else {
                host.clone()
            }
        };

        let now = now_ms();
        let requested_id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let existing = requested_id
            .as_deref()
            .and_then(|id| self.get_site(id));

        let site_id = requested_id.unwrap_or_else(generate_site_id);
        let created_at_ms = existing.as_ref().map(|s| s.created_at_ms).unwrap_or(now);

        let (has_password, has_passphrase) = {
            let _guard = self.vault_lock.write();
            let mut vault = self.load_vault_unlocked()?;
            let mut entry = vault.entries.get(&site_id).cloned().unwrap_or_default();

            if !input.remember_password {
                entry.password = None;
                entry.passphrase = None;
            } else {
                if input.clear_password {
                    entry.password = None;
                } else if let Some(ref pwd) = input.password {
                    if !pwd.is_empty() {
                        let key = self.load_or_create_derived_key()?;
                        entry.password = Some(seal_secret(&key, &site_id, "password", pwd.as_bytes())?);
                    }
                }

                if input.clear_passphrase {
                    entry.passphrase = None;
                } else if let Some(ref pass) = input.passphrase {
                    if !pass.is_empty() {
                        let key = self.load_or_create_derived_key()?;
                        entry.passphrase =
                            Some(seal_secret(&key, &site_id, "passphrase", pass.as_bytes())?);
                    }
                }
            }

            let has_pwd = entry.password.is_some();
            let has_pp = entry.passphrase.is_some();

            if !has_pwd && !has_pp {
                vault.entries.remove(&site_id);
            } else {
                vault.entries.insert(site_id.clone(), entry);
            }
            self.save_vault_unlocked(&vault)?;
            (has_pwd, has_pp)
        };

        let site = SftpSitePublic {
            id: site_id.clone(),
            name,
            host,
            port,
            user,
            remote_path,
            private_key_path,
            remember_password: input.remember_password,
            has_password,
            has_passphrase,
            created_at_ms,
            updated_at_ms: now,
        };

        {
            let mut list = self.sites.write();
            if let Some(pos) = list.iter().position(|s| s.id == site_id) {
                list[pos] = site.clone();
            } else {
                list.insert(0, site.clone());
            }
            self.save_sites_unlocked(&list)?;
        }

        Ok(site)
    }

    pub fn delete_site(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut list = self.sites.write();
            let prev_len = list.len();
            list.retain(|s| s.id != id);
            let changed = list.len() != prev_len;
            if changed {
                self.save_sites_unlocked(&list)?;
            }
            changed
        };

        let _guard = self.vault_lock.write();
        let mut vault = self.load_vault_unlocked()?;
        if vault.entries.remove(id).is_some() {
            self.save_vault_unlocked(&vault)?;
        }

        Ok(removed)
    }

    pub fn resolve_secrets(&self, id: &str) -> Result<SftpSiteResolvedSecrets, String> {
        let _guard = self.vault_lock.read();
        let vault = self.load_vault_unlocked()?;
        let Some(entry) = vault.entries.get(id) else {
            return Ok(SftpSiteResolvedSecrets::default());
        };
        if entry.password.is_none() && entry.passphrase.is_none() {
            return Ok(SftpSiteResolvedSecrets::default());
        }

        let key = self.load_existing_derived_key()?;
        let password = match entry.password.as_ref() {
            Some(sealed) => Some(open_secret(&key, id, "password", sealed)?),
            None => None,
        };
        let passphrase = match entry.passphrase.as_ref() {
            Some(sealed) => Some(open_secret(&key, id, "passphrase", sealed)?),
            None => None,
        };

        Ok(SftpSiteResolvedSecrets {
            password,
            passphrase,
        })
    }

    /// Builds `SftpConnectOptions` for a saved site, merging any non-empty one-time overrides
    /// without ever leaking saved secrets back to the caller UI.
    pub fn build_connect_options(
        &self,
        id: &str,
        override_opts: Option<&SftpConnectOptions>,
    ) -> Result<SftpConnectOptions, String> {
        let site = self
            .get_site(id)
            .ok_or_else(|| format!("未找到指定的 SFTP 站点: {id}"))?;
        let secrets = self.resolve_secrets(id)?;

        let override_uri = override_opts.and_then(|o| o.uri.as_deref()).map(str::trim).filter(|s| !s.is_empty());
        let parsed_override = override_uri.and_then(|u| SftpLocation::parse(u).ok());

        let host = override_opts
            .and_then(|o| o.host.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| parsed_override.as_ref().map(|p| p.host.clone()))
            .unwrap_or_else(|| site.host.clone());

        let port = override_opts
            .and_then(|o| o.port)
            .or_else(|| parsed_override.as_ref().and_then(|p| p.port))
            .or(site.port);

        let user = override_opts
            .and_then(|o| o.user.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| parsed_override.as_ref().and_then(|p| p.user.clone()))
            .or_else(|| site.user.clone());

        let path = override_opts
            .and_then(|o| o.path.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| parsed_override.as_ref().map(|p| p.remote_path.clone()))
            .unwrap_or_else(|| site.remote_path.clone());

        let password = override_opts
            .and_then(|o| o.password.as_deref())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| secrets.password.as_ref().map(|z| z.to_string()));

        let private_key_path = override_opts
            .and_then(|o| o.private_key_path.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| site.private_key_path.clone());

        let passphrase = override_opts
            .and_then(|o| o.passphrase.as_deref())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| secrets.passphrase.as_ref().map(|z| z.to_string()));

        let uri = override_uri.map(str::to_string).or_else(|| {
            let loc = SftpLocation {
                host: host.clone(),
                port,
                user: user.clone(),
                password: None,
                remote_path: normalize_remote_path(Some(&path)),
            };
            Some(loc.to_uri())
        });

        Ok(SftpConnectOptions {
            uri,
            host: Some(host),
            port,
            user,
            password,
            path: Some(path),
            private_key_path,
            passphrase,
        })
    }

    fn save_sites_unlocked(&self, list: &[SftpSitePublic]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(list)
            .map_err(|e| format!("序列化 SFTP 站点列表失败: {e}"))?;
        write_private_file(&self.sites_path, json.as_bytes())
    }

    fn load_vault_unlocked(&self) -> Result<SftpVaultFile, String> {
        if !self.vault_path.exists() {
            return Ok(SftpVaultFile::default());
        }
        let raw = fs::read_to_string(&self.vault_path)
            .map_err(|e| format!("读取 SFTP 密钥库失败: {e}"))?;
        serde_json::from_str::<SftpVaultFile>(&raw)
            .map_err(|e| format!("解析 SFTP 密钥库失败: {e}"))
    }

    fn save_vault_unlocked(&self, vault: &SftpVaultFile) -> Result<(), String> {
        let json = serde_json::to_string_pretty(vault)
            .map_err(|e| format!("序列化 SFTP 密钥库失败: {e}"))?;
        write_private_file(&self.vault_path, json.as_bytes())
    }

    fn load_or_create_derived_key(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
        if self.master_key_path.exists() {
            return self.load_existing_derived_key();
        }
        let rng = SystemRandom::new();
        let mut raw_key = Zeroizing::new([0u8; KEY_LEN]);
        rng.fill(&mut *raw_key)
            .map_err(|_| "生成 SFTP 主密钥失败".to_string())?;
        let b64 = Zeroizing::new(BASE64.encode(&*raw_key));
        write_private_file(&self.master_key_path, b64.as_bytes())?;
        Ok(Zeroizing::new(blake3::derive_key(
            KEY_DERIVE_CONTEXT,
            &*raw_key,
        )))
    }

    fn load_existing_derived_key(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
        let b64 = Zeroizing::new(
            fs::read_to_string(&self.master_key_path)
                .map_err(|e| format!("读取 SFTP 主密钥失败: {e}"))?,
        );
        let mut raw_bytes = BASE64
            .decode(b64.trim())
            .map_err(|e| format!("解码 SFTP 主密钥失败: {e}"))?;
        if raw_bytes.len() != KEY_LEN {
            raw_bytes.zeroize();
            return Err("SFTP 主密钥长度无效".to_string());
        }
        let mut raw_key = Zeroizing::new([0u8; KEY_LEN]);
        raw_key.copy_from_slice(&raw_bytes);
        raw_bytes.zeroize();
        Ok(Zeroizing::new(blake3::derive_key(
            KEY_DERIVE_CONTEXT,
            &*raw_key,
        )))
    }
}

fn seal_secret(
    key_bytes: &[u8; KEY_LEN],
    site_id: &str,
    field: &str,
    plaintext: &[u8],
) -> Result<SealedSecret, String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key_bytes)
        .map_err(|_| "初始化加密密钥失败".to_string())?;
    let key = LessSafeKey::new(unbound);
    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| "生成加密随机数失败".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let aad_str = format!("site:{site_id}:field:{field}");
    let mut buf = Zeroizing::new(plaintext.to_vec());
    key.seal_in_place_append_tag(nonce, Aad::from(aad_str.as_bytes()), &mut *buf)
        .map_err(|_| "加密 SFTP 凭据失败".to_string())?;
    Ok(SealedSecret {
        nonce_b64: BASE64.encode(nonce_bytes),
        ciphertext_b64: BASE64.encode(&*buf),
    })
}

fn open_secret(
    key_bytes: &[u8; KEY_LEN],
    site_id: &str,
    field: &str,
    sealed: &SealedSecret,
) -> Result<Zeroizing<String>, String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key_bytes)
        .map_err(|_| "初始化解密密钥失败".to_string())?;
    let key = LessSafeKey::new(unbound);
    let nonce_vec = BASE64
        .decode(sealed.nonce_b64.trim())
        .map_err(|_| "SFTP 凭据 Nonce 格式无效".to_string())?;
    let nonce_arr: [u8; NONCE_LEN] = nonce_vec
        .try_into()
        .map_err(|_| "SFTP 凭据 Nonce 长度无效".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_arr);
    let mut buf = Zeroizing::new(
        BASE64
            .decode(sealed.ciphertext_b64.trim())
            .map_err(|_| "SFTP 凭据密文格式无效".to_string())?,
    );
    let aad_str = format!("site:{site_id}:field:{field}");
    let plaintext = key
        .open_in_place(nonce, Aad::from(aad_str.as_bytes()), &mut buf)
        .map_err(|_| "解密 SFTP 凭据失败（密钥不匹配或密文已损坏）".to_string())?;
    let decoded = std::str::from_utf8(plaintext)
        .map_err(|_| "SFTP 凭据不是有效的 UTF-8 文本".to_string())?
        .to_string();
    Ok(Zeroizing::new(decoded))
}

fn normalize_remote_path(raw: Option<&str>) -> String {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_site_id() -> String {
    let rng = SystemRandom::new();
    let mut rand_bytes = [0u8; 8];
    let _ = rng.fill(&mut rand_bytes);
    let hex: String = rand_bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("site-{hex}")
}

fn default_config_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|home| PathBuf::from(home).join(".config").join("freecompare"))
}

fn write_private_file(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    fs::write(path, data).map_err(|e| format!("写入文件失败 ({}): {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置文件权限失败 ({}): {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_site_encrypts_password_and_never_writes_plaintext_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = SftpSiteStore::with_dir(dir.path().to_path_buf());

        let saved = store
            .save_site(SaveSftpSiteInput {
                name: "Prod DB".to_string(),
                host: "10.10.1.5".to_string(),
                port: Some(2222),
                user: Some("deploy".to_string()),
                remote_path: Some("var/www".to_string()),
                private_key_path: None,
                remember_password: true,
                password: Some("SuperSecretP@ss!".to_string()),
                passphrase: Some("KeyPass#123".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert!(saved.has_password);
        assert!(saved.has_passphrase);
        assert_eq!(saved.remote_path, "/var/www");

        // Verify neither sites.json nor vault.json nor master key contains plaintext
        let sites_raw = fs::read_to_string(dir.path().join("sftp_sites.json")).unwrap();
        let vault_raw = fs::read_to_string(dir.path().join("sftp_vault.json")).unwrap();
        assert!(!sites_raw.contains("SuperSecretP@ss!"));
        assert!(!sites_raw.contains("KeyPass#123"));
        assert!(!vault_raw.contains("SuperSecretP@ss!"));
        assert!(!vault_raw.contains("KeyPass#123"));

        // Verify Unix 0600 permissions
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key_mode = fs::metadata(dir.path().join(".sftp_master.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let vault_mode = fs::metadata(dir.path().join("sftp_vault.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(key_mode, 0o600);
            assert_eq!(vault_mode, 0o600);
        }

        // Reload store from disk and decrypt
        let reloaded = SftpSiteStore::with_dir(dir.path().to_path_buf());
        let list = reloaded.list_sites();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);

        let secrets = reloaded.resolve_secrets(&saved.id).unwrap();
        assert_eq!(secrets.password.as_deref().map(|s| s.as_str()), Some("SuperSecretP@ss!"));
        assert_eq!(secrets.passphrase.as_deref().map(|s| s.as_str()), Some("KeyPass#123"));

        // Update site metadata without re-sending password -> preserves existing encrypted secret
        let updated = reloaded
            .save_site(SaveSftpSiteInput {
                id: Some(saved.id.clone()),
                name: "Prod DB Renamed".to_string(),
                host: "10.10.1.5".to_string(),
                port: Some(2222),
                user: Some("deploy".to_string()),
                remote_path: Some("/srv/app".to_string()),
                private_key_path: None,
                remember_password: true,
                password: None,
                passphrase: None,
                ..Default::default()
            })
            .unwrap();
        assert!(updated.has_password);
        let secrets_after = reloaded.resolve_secrets(&saved.id).unwrap();
        assert_eq!(
            secrets_after.password.as_deref().map(|s| s.as_str()),
            Some("SuperSecretP@ss!")
        );

        // Disable remember_password -> purges secret from vault
        let cleared = reloaded
            .save_site(SaveSftpSiteInput {
                id: Some(saved.id.clone()),
                name: "Prod DB Renamed".to_string(),
                host: "10.10.1.5".to_string(),
                port: Some(2222),
                user: Some("deploy".to_string()),
                remote_path: Some("/srv/app".to_string()),
                private_key_path: None,
                remember_password: false,
                password: None,
                passphrase: None,
                ..Default::default()
            })
            .unwrap();
        assert!(!cleared.has_password);
        assert!(!cleared.has_passphrase);
        let secrets_cleared = reloaded.resolve_secrets(&saved.id).unwrap();
        assert!(secrets_cleared.password.is_none());
        assert!(secrets_cleared.passphrase.is_none());
    }

    #[test]
    fn aad_prevents_ciphertext_swapping_between_sites_or_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = SftpSiteStore::with_dir(dir.path().to_path_buf());

        let site_a = store
            .save_site(SaveSftpSiteInput {
                name: "A".to_string(),
                host: "host-a".to_string(),
                remember_password: true,
                password: Some("SecretA".to_string()),
                ..Default::default()
            })
            .unwrap();
        let site_b = store
            .save_site(SaveSftpSiteInput {
                name: "B".to_string(),
                host: "host-b".to_string(),
                remember_password: true,
                password: Some("SecretB".to_string()),
                ..Default::default()
            })
            .unwrap();

        // Tamper vault.json by swapping site_a's sealed password into site_b
        let vault_path = dir.path().join("sftp_vault.json");
        let mut vault: SftpVaultFile =
            serde_json::from_str(&fs::read_to_string(&vault_path).unwrap()).unwrap();
        let sealed_a = vault.entries.get(&site_a.id).unwrap().password.clone().unwrap();
        vault.entries.get_mut(&site_b.id).unwrap().password = Some(sealed_a);
        fs::write(&vault_path, serde_json::to_string(&vault).unwrap()).unwrap();

        // Decryption for site_b must fail because AAD binds ciphertext to site_id!
        assert!(store.resolve_secrets(&site_b.id).is_err());
    }

    #[test]
    fn delete_site_removes_metadata_and_vault_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = SftpSiteStore::with_dir(dir.path().to_path_buf());

        let saved = store
            .save_site(SaveSftpSiteInput {
                name: "Temp".to_string(),
                host: "127.0.0.1".to_string(),
                remember_password: true,
                password: Some("pw".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert!(store.delete_site(&saved.id).unwrap());
        assert!(store.list_sites().is_empty());
        let vault_raw = fs::read_to_string(dir.path().join("sftp_vault.json")).unwrap();
        assert!(!vault_raw.contains(&saved.id));
    }
}
