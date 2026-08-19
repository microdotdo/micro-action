"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { booleanInput, input, parseDeployment, projectBuildEnvironment, resolveProject, unverifiedClaims, verifyDeployment } = require("../src/index.js");

test("reads GitHub's exact hyphenated input environment names", () => {
  process.env["INPUT_DRY-RUN"] = "true";
  process.env.INPUT_CLI_VERSION = "0.10.2";
  try {
    assert.equal(input("dry-run"), "true");
    assert.equal(booleanInput("dry-run"), true);
    assert.equal(input("cli-version"), "0.10.2");
  } finally {
    delete process.env["INPUT_DRY-RUN"];
    delete process.env.INPUT_CLI_VERSION;
  }
});

test("project path cannot escape the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "micro-action-test-"));
  fs.mkdirSync(path.join(workspace, "site"));
  assert.equal(resolveProject(workspace, "site"), path.join(workspace, "site"));
  assert.throws(() => resolveProject(workspace, ".."), /inside GITHUB_WORKSPACE/);
});

test("project compilation receives no GitHub or Micro deployment authority", () => {
  assert.deepEqual(projectBuildEnvironment(), {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
    ACTIONS_ID_TOKEN_REQUEST_URL: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    MICRO_GITHUB_OIDC_TOKEN: "",
  });
});

test("deployment output requires all immutable facts", () => {
  const valid = {
    url: "https://site.micro.do",
    project_id: "11111111-1111-4111-8111-111111111111",
    deployment_id: "22222222-2222-4222-8222-222222222222",
    bundle_sha256: "a".repeat(64),
    source_sha256: "b".repeat(64),
  };
  assert.deepEqual(parseDeployment(JSON.stringify(valid)), valid);
  assert.throws(() => parseDeployment(JSON.stringify({ url: valid.url })), /omitted project_id/);
});

test("live verification accepts a reachable private or missing root without credentials", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response("", { status: 401 });
  try {
    assert.deepEqual(await verifyDeployment("https://site.micro.do", 1), {
      status: "reachable",
      httpStatus: 401,
      attempts: 1,
    });
  } finally {
    global.fetch = original;
  }
});

test("live verification fails closed on a persistent platform error", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response("", { status: 503 });
  try {
    await assert.rejects(
      verifyDeployment("https://site.micro.do", 1),
      /live verification failed: live route returned HTTP 503/,
    );
  } finally {
    global.fetch = original;
  }
});

test("OIDC payload decoding is informational only and bounded by caller", () => {
  const claims = { environment: "production", repository_id: "123" };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  assert.deepEqual(unverifiedClaims(token), claims);
});
