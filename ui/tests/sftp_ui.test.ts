import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callRustRpc } from "../src/bridge.ts";
import {
  buildSftpTestRpcArgs,
  buildSftpUri,
  displayPathBaseName,
  isSftpUri,
  joinComparePath,
  type ListSshConfigHostsResponse,
  maskSftpPassword,
  parseSftpUri,
  type SftpTestResultDto,
} from "../src/utils/sftp.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.resolve(__dirname, "../src");

test("SFTP URI detection, parsing, and building", () => {
  assert.strictEqual(isSftpUri("sftp://prod/var/www"), true);
  assert.strictEqual(isSftpUri("  SFTP://user@host/tmp "), true);
  assert.strictEqual(isSftpUri("/home/user/project"), false);
  assert.strictEqual(isSftpUri("C:\\Users\\demo"), false);

  assert.deepStrictEqual(parseSftpUri("sftp://prod-api/var/www/app"), {
    host: "prod-api",
    port: "",
    user: "",
    password: "",
    path: "/var/www/app",
  });

  assert.deepStrictEqual(parseSftpUri("sftp://deploy@10.0.0.5:2222/etc/nginx"), {
    host: "10.0.0.5",
    port: "2222",
    user: "deploy",
    password: "",
    path: "/etc/nginx",
  });

  assert.deepStrictEqual(parseSftpUri("sftp://user:p%40ss@host/tmp/a.txt"), {
    host: "host",
    port: "",
    user: "user",
    password: "p@ss",
    path: "/tmp/a.txt",
  });

  // Quick URI without explicit :port must leave port undefined so ~/.ssh/config Port (e.g. 2222) is preserved
  const parsedAlias = parseSftpUri("sftp://prod-api/var/www");
  const argsWithoutPort = buildSftpTestRpcArgs({
    uri: "sftp://prod-api/var/www",
    host: parsedAlias.host,
    port: parsedAlias.port,
    user: parsedAlias.user,
    path: parsedAlias.path,
  });
  assert.strictEqual(argsWithoutPort.port, undefined);

  const argsWithPort = buildSftpTestRpcArgs({
    uri: "sftp://prod-api:2222/var/www",
    host: "prod-api",
    port: "2222",
    path: "/var/www",
  });
  assert.strictEqual(argsWithPort.port, 2222);

  assert.deepStrictEqual(parseSftpUri("sftp://admin@[::1]:2200/srv"), {
    host: "::1",
    port: "2200",
    user: "admin",
    password: "",
    path: "/srv",
  });

  // Passwordless build omits password and default port 22
  assert.strictEqual(
    buildSftpUri({ host: "prod-api", port: "22", user: "deploy", password: "", path: "/var/www" }),
    "sftp://deploy@prod-api/var/www"
  );
  assert.strictEqual(
    buildSftpUri({ host: "prod-api", port: "2222", user: "", password: "", path: "etc" }),
    "sftp://prod-api:2222/etc"
  );
  assert.strictEqual(
    buildSftpUri({ host: "::1", port: "2222", user: "root", password: "p@ss", path: "/" }),
    "sftp://root:p%40ss@[::1]:2222/"
  );
});

test("SFTP and local path joining, basename extraction, and password masking", () => {
  assert.strictEqual(
    joinComparePath("sftp://prod/var/www/", "src/main.rs"),
    "sftp://prod/var/www/src/main.rs"
  );
  assert.strictEqual(
    joinComparePath("sftp://prod/", "etc/hosts"),
    "sftp://prod/etc/hosts"
  );
  assert.strictEqual(joinComparePath("/", "etc/hosts"), "/etc/hosts");
  assert.strictEqual(
    joinComparePath("/home/ray/proj/", "/src/lib.rs"),
    "/home/ray/proj/src/lib.rs"
  );

  assert.strictEqual(displayPathBaseName("sftp://prod/var/www/app.ts"), "app.ts");
  assert.strictEqual(displayPathBaseName("sftp://prod/"), "prod");
  assert.strictEqual(displayPathBaseName("/tmp/demo/file.txt"), "file.txt");

  assert.strictEqual(
    maskSftpPassword("sftp://deploy:secret@prod:2222/etc/hosts"),
    "sftp://deploy:***@prod:2222/etc/hosts"
  );
  assert.strictEqual(
    maskSftpPassword("sftp://deploy@prod/etc/hosts"),
    "sftp://deploy@prod/etc/hosts"
  );
});

test("SFTP UI contracts: FileBrowserModal & views support SFTP profiles and path joining", () => {
  const modalSrc = fs.readFileSync(
    path.join(uiSrcDir, "components/FileBrowserModal.tsx"),
    "utf8"
  );
  assert.ok(modalSrc.includes("list_ssh_config_hosts"));
  assert.ok(modalSrc.includes("test_sftp_connection"));
  assert.ok(modalSrc.includes("list_local_dir"));

  const folderSrc = fs.readFileSync(
    path.join(uiSrcDir, "views/FolderDiffView.tsx"),
    "utf8"
  );
  assert.ok(folderSrc.includes("joinComparePath"));
  assert.ok(folderSrc.includes("sftp_fast_hint"));
});

test("SFTP RPC contract: list_ssh_config_hosts, test_sftp_connection, and list_local_dir", async () => {
  const origFetch = globalThis.fetch;
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      cmd: string;
      args: Record<string, unknown>;
    };
    calls.push(body);
    if (body.cmd === "list_ssh_config_hosts") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            hosts: [
              {
                alias: "prod-api",
                host_name: "10.0.0.5",
                user: "deploy",
                port: 22,
                identity_files: ["~/.ssh/id_ed25519"],
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (body.cmd === "test_sftp_connection") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            ok: true,
            resolved_uri: "sftp://deploy@10.0.0.5/var/www",
            host: "10.0.0.5",
            port: 22,
            user: "deploy",
            remote_path: "/var/www",
            auth_method: "ssh_agent",
          },
        }),
        { status: 200 }
      );
    }
    if (body.cmd === "list_local_dir") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            current_dir: "sftp://deploy@10.0.0.5/var/www",
            parent_dir: "sftp://deploy@10.0.0.5/var",
            entries: [
              {
                name: "index.html",
                path: "sftp://deploy@10.0.0.5/var/www/index.html",
                is_dir: false,
                size: 1024,
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown" }), { status: 400 });
  }) as typeof fetch;

  try {
    const hostsRes = await callRustRpc<ListSshConfigHostsResponse>("list_ssh_config_hosts");
    assert.strictEqual(hostsRes?.hosts.length, 1);
    assert.strictEqual(hostsRes?.hosts[0].alias, "prod-api");
    assert.strictEqual(hostsRes?.hosts[0].host_name, "10.0.0.5");

    const testRes = await callRustRpc<SftpTestResultDto>("test_sftp_connection", {
      uri: "sftp://prod-api/var/www",
    });
    assert.strictEqual(testRes?.ok, true);
    assert.strictEqual(testRes?.auth_method, "ssh_agent");
    assert.strictEqual(testRes?.resolved_uri, "sftp://deploy@10.0.0.5/var/www");

    const dirRes = await callRustRpc<{ current_dir: string; entries: Array<{ path: string }> }>(
      "list_local_dir",
      { dir_path: "sftp://deploy@10.0.0.5/var/www" }
    );
    assert.strictEqual(dirRes?.current_dir, "sftp://deploy@10.0.0.5/var/www");
    assert.strictEqual(dirRes?.entries[0].path, "sftp://deploy@10.0.0.5/var/www/index.html");
  } finally {
    globalThis.fetch = origFetch;
  }
});
