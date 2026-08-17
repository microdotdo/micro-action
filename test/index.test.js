"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { booleanInput, input, parseDeployment, resolveProject, unverifiedClaims } = require("../src/index.js");

test("reads GitHub's exact hyphenated input environment names", () => {
  process.env["INPUT_DRY-RUN"] = "true";
  process.env.INPUT_CLI_VERSION = "0.4.0";
  try {
    assert.equal(input("dry-run"), "true");
    assert.equal(booleanInput("dry-run"), true);
    assert.equal(input("cli-version"), "0.4.0");
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

test("deployment output requires all immutable facts", () => {
  const valid = {
    url: "https://site.micro.do",
    project_id: "project",
    deployment_id: "deployment",
    bundle_sha256: "bundle",
    source_sha256: "source",
  };
  assert.deepEqual(parseDeployment(JSON.stringify(valid)), valid);
  assert.throws(() => parseDeployment(JSON.stringify({ url: valid.url })), /omitted project_id/);
});

test("OIDC payload decoding is informational only and bounded by caller", () => {
  const claims = { environment: "production", repository_id: "123" };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  assert.deepEqual(unverifiedClaims(token), claims);
});
