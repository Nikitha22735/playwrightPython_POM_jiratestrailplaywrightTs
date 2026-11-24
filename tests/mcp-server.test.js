import assert from "node:assert/strict";
import test from "node:test";
import {
  adfToText,
  buildPlaywrightSpec,
  normalizeTestCases,
  validateIssueKey,
} from "../jira_mcp_server.js";

const sampleCase = {
  scenario: "User signs in",
  preconditions: "A registered user exists.",
  steps: ["Open the sign-in page", "Submit valid credentials"],
  test_data: "user@example.com",
  expected_result: "The user is signed in.",
  priority: "High",
};

test("validates and normalizes Jira issue keys", () => {
  assert.equal(validateIssueKey("demo-12"), "DEMO-12");
  assert.throws(() => validateIssueKey("not-an-issue"), /Jira issue key/);
});

test("converts Jira ADF paragraphs into readable text", () => {
  const adf = {
    type: "doc",
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: "Sign in successfully." }],
    }],
  };
  assert.equal(adfToText(adf).trim(), "Sign in successfully.");
});

test("normalizes manual cases and rejects empty steps", () => {
  const normalized = normalizeTestCases([sampleCase]);
  assert.deepEqual(normalized[0].steps, [
    "Open the sign-in page",
    "Submit valid credentials",
  ]);
  assert.throws(
    () => normalizeTestCases([{ ...sampleCase, steps: ["  "] }]),
    /no valid steps/,
  );
});

test("creates a Playwright scaffold that remains disabled until implemented", () => {
  const source = buildPlaywrightSpec("DEMO-12", [sampleCase]);
  assert.match(source, /TC-001: User signs in/);
  assert.match(source, /test\.fixme\(/);
  assert.match(source, /Submit valid credentials/);
  assert.match(source, /TODO: Add assertions/);
});
