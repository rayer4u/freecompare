export interface SftpConnectionParams {
  host: string;
  port: string;
  user: string;
  password: string;
  path: string;
}

export interface SshConfigHostDto {
  alias: string;
  host_name: string;
  user: string | null;
  port: number;
  identity_files: string[];
}

export interface ListSshConfigHostsResponse {
  hosts: SshConfigHostDto[];
}

export interface SftpTestResultDto {
  ok: boolean;
  resolved_uri: string;
  host: string;
  port: number;
  user: string;
  remote_path: string;
  auth_method: string;
  message?: string;
}

export function isSftpUri(raw?: string | null): boolean {
  return Boolean(raw && raw.trim().toLowerCase().startsWith("sftp://"));
}

/**
 * Parses `sftp://[user[:password]@]host[:port][/path]` into connection fields.
 */
export function parseSftpUri(raw: string): SftpConnectionParams {
  const trimmed = raw.trim();
  const rest = trimmed.replace(/^sftp:\/\//i, "");
  const slashIdx = rest.indexOf("/");
  const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const pathPart = slashIdx === -1 ? "/" : rest.slice(slashIdx) || "/";

  let user = "";
  let password = "";
  let hostPort = authority;

  const atIdx = authority.lastIndexOf("@");
  if (atIdx !== -1) {
    const userInfo = authority.slice(0, atIdx);
    hostPort = authority.slice(atIdx + 1);
    const colonIdx = userInfo.indexOf(":");
    if (colonIdx !== -1) {
      user = decodeSafe(userInfo.slice(0, colonIdx));
      password = decodeSafe(userInfo.slice(colonIdx + 1));
    } else {
      user = decodeSafe(userInfo);
    }
  }

  let host = hostPort;
  let port = "";

  if (hostPort.startsWith("[")) {
    const closeBracket = hostPort.indexOf("]");
    if (closeBracket !== -1) {
      host = hostPort.slice(1, closeBracket);
      const after = hostPort.slice(closeBracket + 1);
      if (after.startsWith(":") && after.length > 1) {
        port = after.slice(1);
      }
    }
  } else {
    const lastColon = hostPort.lastIndexOf(":");
    if (lastColon !== -1 && lastColon < hostPort.length - 1) {
      host = hostPort.slice(0, lastColon);
      port = hostPort.slice(lastColon + 1);
    }
  }

  return {
    host: host.trim(),
    port: port.trim(),
    user: user.trim(),
    password,
    path: pathPart,
  };
}

/**
 * Builds an `sftp://` URI from connection form parameters.
 * Leaves password empty for passwordless SSH agent/key authentication.
 */
export function buildSftpUri(params: Partial<SftpConnectionParams>): string {
  const rawHost = (params.host ?? "").trim();
  if (!rawHost) return "";

  const host =
    rawHost.includes(":") && !rawHost.startsWith("[")
      ? `[${rawHost}]`
      : rawHost;

  const user = (params.user ?? "").trim();
  const password = params.password ?? "";
  let auth = "";
  if (user) {
    auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(user)}@`;
  }

  const port = (params.port ?? "").trim();
  const portPart = port && port !== "22" ? `:${port}` : "";

  const rawPath = (params.path ?? "").trim();
  const normPath = !rawPath
    ? "/"
    : rawPath.startsWith("/")
    ? rawPath
    : `/${rawPath}`;

  return `sftp://${auth}${host}${portPart}${normPath}`;
}

/**
 * Joins a root directory (local or `sftp://...`) with a relative path safely.
 */
export function joinComparePath(root: string, relPath: string): string {
  const cleanRel = relPath.replace(/^[/\\]+/, "");
  if (!cleanRel) return root;
  const cleanRoot = root.replace(/[/\\]+$/, "");
  if (!cleanRoot) return `/${cleanRel}`;
  return `${cleanRoot}/${cleanRel}`;
}

/**
 * Extracts a human-readable basename for tab titles from local paths or `sftp://` URIs.
 */
export function displayPathBaseName(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (isSftpUri(trimmed)) {
    const parsed = parseSftpUri(trimmed);
    const pathClean = parsed.path.replace(/\/+$/, "");
    if (pathClean && pathClean !== "/") {
      return pathClean.split("/").pop() || parsed.host || trimmed;
    }
    return parsed.host || trimmed;
  }
  const clean = trimmed.replace(/[/\\]+$/, "");
  return clean ? clean.split(/[/\\]/).pop() || clean : trimmed;
}

/**
 * Masks any inline password in an `sftp://user:pass@host/path` URI for safe display.
 */
export function maskSftpPassword(rawPath: string): string {
  if (!isSftpUri(rawPath)) return rawPath;
  const parsed = parseSftpUri(rawPath);
  if (!parsed.password) return rawPath;
  return buildSftpUri({ ...parsed, password: "***" });
}

/**
 * Builds RPC args for `test_sftp_connection`, omitting `port` when not explicitly
 * specified so `~/.ssh/config` custom ports (e.g. Port 2222) are preserved.
 */
export function buildSftpTestRpcArgs(params: {
  uri: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  path?: string;
  privateKeyPath?: string;
  passphrase?: string;
}): Record<string, unknown> {
  const portStr = (params.port ?? "").trim();
  const parsedPort = portStr ? Number.parseInt(portStr, 10) : NaN;
  const explicitPort =
    Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined;

  return {
    uri: params.uri,
    host: params.host?.trim() || undefined,
    port: explicitPort,
    user: params.user?.trim() || undefined,
    password: params.password || undefined,
    path: params.path?.trim() || undefined,
    private_key_path: params.privateKeyPath?.trim() || undefined,
    passphrase: params.passphrase || undefined,
  };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
