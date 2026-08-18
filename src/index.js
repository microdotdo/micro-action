"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const API_ORIGIN = "https://micro.do";
const OIDC_AUDIENCE = "https://micro.do/actions";
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const CLI_CHECKSUMS = {
  "0.7.3": "af46fff76beac3cffc9b8f7c8e642e6da787fdd005bed38ad551cc8724baab92",
  "0.8.0": "5aa9d98b2d3aa7e5e09b8cd38074ac0eddb002940ebbc0de9dc5d1a34c1c450c",
  "0.8.1": "105f7737d40272832e5d5a3437e4f1dee13b7435e40cec54a5c5d4caa7ece60f",
};

function input(name, fallback = "") {
  const githubName = `INPUT_${name.toUpperCase()}`;
  const portableName = githubName.replaceAll("-", "_");
  return process.env[githubName] || process.env[portableName] || fallback;
}

function booleanInput(name) {
  const value = input(name, "false").toLowerCase();
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

function projectBuildEnvironment() {
  return {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
    ACTIONS_ID_TOKEN_REQUEST_URL: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    MICRO_GITHUB_OIDC_TOKEN: "",
  };
}

function command(name, value) {
  process.stdout.write(`::${name}::${String(value).replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
}

function setOutput(name, value) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  const delimiter = `micro_${crypto.randomBytes(12).toString("hex")}`;
  fs.appendFileSync(target, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function resolveProject(workspace, requested) {
  const root = fs.realpathSync(workspace);
  const candidate = fs.realpathSync(path.resolve(root, requested));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("path must stay inside GITHUB_WORKSPACE");
  }
  if (!fs.statSync(candidate).isDirectory()) throw new Error("path is not a directory");
  return candidate;
}

async function boundedDownload(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "micro-action/1.3" } });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("download exceeds 20 MiB");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("download has an invalid size");
  return bytes;
}

async function installCli(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("cli-version must be an exact semantic version");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("micro-action v1 supports Linux x64 GitHub runners");
  }
  const expected = CLI_CHECKSUMS[version];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`micro CLI ${version} is not pinned by this Action release`);
  }
  const url = `https://github.com/microdotdo/micro-cli/releases/download/v${version}/micro-linux-x86_64`;
  const bytes = await boundedDownload(url);
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new Error("micro CLI checksum verification failed");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "micro-action-"));
  const executable = path.join(directory, "micro");
  fs.writeFileSync(executable, bytes, { mode: 0o755 });
  const versionResult = runCli(executable, ["--version"], process.cwd(), {});
  if (versionResult.stdout.trim() !== `micro ${version}`) throw new Error("downloaded micro CLI version does not match");
  return executable;
}

function runCli(executable, arguments_, cwd, environment) {
  const result = spawnSync(executable, arguments_, {
    cwd,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let message = (result.stderr || result.stdout || "micro CLI failed").trim();
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed.message) message = parsed.message;
    } catch (_) {}
    throw new Error(message);
  }
  return result;
}

async function githubOidcToken() {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !requestToken || !endpoint.startsWith("https://")) {
    throw new Error("GitHub OIDC is unavailable; grant the job id-token: write permission");
  }
  const separator = endpoint.includes("?") ? "&" : "?";
  const response = await fetch(`${endpoint}${separator}audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
    headers: { authorization: `Bearer ${requestToken}` },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub OIDC request failed with HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.value !== "string" || body.value.length < 100 || body.value.length > 32768) {
    throw new Error("GitHub returned an invalid OIDC token");
  }
  command("add-mask", body.value);
  return body.value;
}

function unverifiedClaims(token) {
  const sections = token.split(".");
  if (sections.length !== 3) throw new Error("GitHub returned a malformed OIDC token");
  return JSON.parse(Buffer.from(sections[1], "base64url").toString("utf8"));
}

function parseDeployment(stdout) {
  const value = JSON.parse(stdout.trim());
  for (const field of ["url", "project_id", "deployment_id", "bundle_sha256", "source_sha256"]) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error(`micro CLI omitted ${field}`);
  }
  const target = new URL(value.url);
  if (target.protocol !== "https:" || !target.hostname.endsWith(".micro.do") ||
      target.pathname !== "/" || target.search || target.hash) {
    throw new Error("micro CLI returned an invalid project URL");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(value.project_id) || !uuid.test(value.deployment_id)) {
    throw new Error("micro CLI returned an invalid deployment identity");
  }
  if (!/^[a-f0-9]{64}$/.test(value.bundle_sha256) || !/^[a-f0-9]{64}$/.test(value.source_sha256)) {
    throw new Error("micro CLI returned an invalid deployment digest");
  }
  return value;
}

async function verifyDeployment(url, attempts = 5) {
  let lastError = "live route did not respond";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "micro-action/1.3 live-verification" },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status >= 200 && response.status < 500) {
        return { status: "reachable", httpStatus: response.status, attempts: attempt };
      }
      lastError = `live route returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`deployment activated, but live verification failed: ${lastError}`);
}

function summary(deployment, verification, dryRun) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const lines = dryRun
    ? ["## Micro build", "", "- Build: validated", "- Upload: not requested", "- Activation: not requested", "- Live route: not requested"]
    : [
        "## Micro deployment", "",
        `- Build: validated by the checksum-pinned Micro CLI`,
        `- Upload: accepted as bundle \`${deployment.bundle_sha256}\``,
        `- Activation: deployment \`${deployment.deployment_id}\``,
        `- Live route: HTTP ${verification.httpStatus} after ${verification.attempts} attempt${verification.attempts === 1 ? "" : "s"}`,
        `- URL: ${deployment.url}`,
        `- Source: \`${deployment.source_sha256}\``,
      ];
  fs.appendFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) throw new Error("GITHUB_WORKSPACE is unavailable");
  const project = resolveProject(workspace, input("path", "."));
  const cli = await installCli(input("cli-version", "0.8.1"));
  runCli(cli, ["build", "--json"], project, projectBuildEnvironment());
  if (booleanInput("dry-run")) {
    summary({}, {}, true);
    return;
  }
  const oidc = await githubOidcToken();
  const expectedEnvironment = input("environment", "production");
  const claims = unverifiedClaims(oidc);
  if (expectedEnvironment && claims.environment !== expectedEnvironment) {
    throw new Error(`GitHub OIDC environment is ${claims.environment || "absent"}; expected ${expectedEnvironment}`);
  }
  const deployed = runCli(cli, ["deploy", "--github", "--prebuilt", "--json"], project, {
    MICRO_API: API_ORIGIN,
    MICRO_GITHUB_OIDC_TOKEN: oidc,
    MICRO_ACCEPT_PRICE_CHANGES: booleanInput("accept-price-changes") ? "true" : "false",
    MICRO_ACCEPT_LIVE_PRODUCTS: booleanInput("accept-live-products") ? "true" : "false",
  });
  const result = parseDeployment(deployed.stdout);
  const verification = await verifyDeployment(result.url);
  setOutput("url", result.url);
  setOutput("project-id", result.project_id);
  setOutput("deployment-id", result.deployment_id);
  setOutput("bundle-sha256", result.bundle_sha256);
  setOutput("source-sha256", result.source_sha256);
  setOutput("verification-status", `reachable:http-${verification.httpStatus}`);
  summary(result, verification, false);
  command("notice", `Deployed and verified ${result.url} (HTTP ${verification.httpStatus})`);
}

if (require.main === module) {
  main().catch((error) => {
    command("error", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  booleanInput,
  input,
  parseDeployment,
  projectBuildEnvironment,
  resolveProject,
  unverifiedClaims,
  verifyDeployment,
};
