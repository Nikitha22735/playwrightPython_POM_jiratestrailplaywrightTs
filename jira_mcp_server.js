import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(root, ".env") });

const server = new McpServer({
  name: "jira-testcase-tools",
  version: "1.0.0",
});

const testCaseSchema = z.object({
  scenario: z.string().min(1),
  preconditions: z.string().optional().default(""),
  steps: z.union([z.array(z.string()), z.string()]),
  test_data: z.string().optional().default(""),
  expected_result: z.string().min(1),
  priority: z.string().optional().default("Medium"),
  test_type: z.string().optional().default("Functional"),
});

const issueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/i);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env and restart the MCP server.`);
  }
  return value;
}

function validateIssueKey(issueKey) {
  const normalized = issueKey.trim().toUpperCase();
  if (!issueKeySchema.safeParse(normalized).success) {
    throw new Error("Enter a Jira issue key such as DEMO-123.");
  }
  return normalized;
}

function adfToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(adfToText).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return String(value);
  if (value.type === "text") return value.text ?? "";
  if (value.type === "hardBreak") return "\n";
  if (value.type === "mention") return value.attrs?.text ?? "@mention";

  const text = (value.content ?? []).map(adfToText).join("");
  return ["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(value.type)
    ? `${text}\n`
    : text;
}

function normalizeTestCases(testCases) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error("No test cases were supplied.");
  }
  return testCases.map((rawCase, index) => {
    const parsed = testCaseSchema.safeParse(rawCase);
    if (!parsed.success) {
      throw new Error(`Invalid test case ${index + 1}: ${parsed.error.issues[0].message}`);
    }
    const testCase = parsed.data;
    const scenario = testCase.scenario.trim();
    const expectedResult = testCase.expected_result.trim();
    const rawSteps = typeof testCase.steps === "string"
      ? [testCase.steps]
      : testCase.steps;
    const steps = rawSteps.map((step) => step.trim()).filter(Boolean);

    if (!scenario) throw new Error(`Test case ${index + 1} has an empty scenario.`);
    if (!expectedResult) throw new Error(`Test case ${index + 1} has no expected result.`);
    if (steps.length === 0) throw new Error(`Test case ${index + 1} has no valid steps.`);

    return {
      ...testCase,
      scenario,
      preconditions: testCase.preconditions.trim(),
      steps,
      test_data: testCase.test_data.trim(),
      expected_result: expectedResult,
      priority: testCase.priority.trim(),
      test_type: testCase.test_type.trim(),
    };
  });
}

function basicAuth(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

async function jiraRequest(issueKey) {
  const baseUrl = requiredEnv("JIRA_URL").replace(/\/+$/, "");
  const email = requiredEnv("JIRA_EMAIL");
  const token = requiredEnv("JIRA_API_TOKEN");
  const response = await fetch(
    `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,issuetype,status,labels`,
    {
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(email, token),
      },
      signal: AbortSignal.timeout(30000),
    },
  );

  if (response.status === 401) throw new Error("Jira 401: check your email and API token.");
  if (response.status === 403) throw new Error("Jira 403: check Browse Projects and issue permissions.");
  if (response.status === 404) throw new Error("Jira issue was not found or is not visible to this account.");
  if (!response.ok) throw new Error(`Jira request failed with HTTP ${response.status}.`);
  return response.json();
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

server.registerTool(
  "get_jira_story",
  {
    description: "Read a Jira Cloud issue by key. This tool does not update Jira.",
    inputSchema: { issue_key: z.string().min(1) },
  },
  async ({ issue_key }) => {
    try {
      const key = validateIssueKey(issue_key);
      const issue = await jiraRequest(key);
      const fields = issue.fields ?? {};
      const baseUrl = requiredEnv("JIRA_URL").replace(/\/+$/, "");
      const result = {
        key: issue.key ?? key,
        summary: fields.summary ?? "",
        description: adfToText(fields.description).trim(),
        issue_type: fields.issuetype?.name ?? "",
        status: fields.status?.name ?? "",
        labels: fields.labels ?? [],
        url: `${baseUrl}/browse/${issue.key ?? key}`,
        note: "Acceptance criteria may be stored in a custom Jira field; this tool reads summary, description, type, status and labels.",
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "save_test_cases_to_excel",
  {
    description: "Save manual test cases to an Excel workbook.",
    inputSchema: {
      issue_key: z.string().min(1),
      test_cases: z.array(testCaseSchema).min(1),
    },
  },
  async ({ issue_key, test_cases }) => {
    try {
      const key = validateIssueKey(issue_key);
      const cases = normalizeTestCases(test_cases);
      const outputDir = path.join(root, "output");
      await fs.mkdir(outputDir, { recursive: true });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Manual Test Cases");
      sheet.columns = [
        { header: "Test Case ID", key: "id", width: 20 },
        { header: "Jira Issue", key: "issue", width: 16 },
        { header: "Scenario", key: "scenario", width: 38 },
        { header: "Preconditions", key: "preconditions", width: 32 },
        { header: "Test Steps", key: "steps", width: 48 },
        { header: "Test Data", key: "testData", width: 28 },
        { header: "Expected Result", key: "expectedResult", width: 42 },
        { header: "Priority", key: "priority", width: 14 },
        { header: "Type", key: "type", width: 18 },
      ];
      cases.forEach((testCase, index) => {
        sheet.addRow({
          id: `${key}-TC-${String(index + 1).padStart(3, "0")}`,
          issue: key,
          scenario: testCase.scenario,
          preconditions: testCase.preconditions,
          steps: testCase.steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join("\n"),
          testData: testCase.test_data,
          expectedResult: testCase.expected_result,
          priority: testCase.priority,
          type: testCase.test_type,
        });
      });

      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F4E78" },
      };
      sheet.getRow(1).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) row.alignment = { vertical: "top", wrapText: true };
      });
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.autoFilter = { from: "A1", to: `I${cases.length + 1}` };

      const filePath = path.join(outputDir, `${key}_manual_test_cases.xlsx`);
      await workbook.xlsx.writeFile(filePath);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "saved",
            issue_key: key,
            test_case_count: cases.length,
            file_path: filePath,
          }, null, 2),
        }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "upload_test_cases_to_testrail",
  {
    description: "Create test cases in a TestRail section. Requires TestRail credentials and only runs when explicitly called.",
    inputSchema: {
      issue_key: z.string().min(1),
      section_id: z.number().int().positive(),
      test_cases: z.array(testCaseSchema).min(1),
    },
  },
  async ({ issue_key, section_id, test_cases }) => {
    try {
      const key = validateIssueKey(issue_key);
      const cases = normalizeTestCases(test_cases);
      const baseUrl = requiredEnv("TESTRAIL_URL").replace(/\/+$/, "");
      const email = requiredEnv("TESTRAIL_EMAIL");
      const apiKey = requiredEnv("TESTRAIL_API_KEY");
      const priorityIds = { low: 1, medium: 2, high: 3, critical: 4 };
      const payloads = cases.map((testCase, index) => {
        const priorityId = priorityIds[testCase.priority.toLowerCase()];
        if (!priorityId) {
          throw new Error(`Test case ${index + 1} has unsupported priority "${testCase.priority}". Use Low, Medium, High or Critical.`);
        }
        return {
          title: testCase.scenario,
          refs: key,
          custom_preconds: testCase.preconditions,
          custom_steps_separated: testCase.steps.map((step) => ({ content: step, expected: "" })),
          custom_expected: testCase.expected_result,
          priority_id: priorityId,
        };
      });

      const endpoint = `${baseUrl}/index.php?/api/v2/add_case/${section_id}`;
      const createdCases = [];
      for (let index = 0; index < payloads.length; index += 1) {
        let response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: basicAuth(email, apiKey),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payloads[index]),
            signal: AbortSignal.timeout(30000),
          });
        } catch (error) {
          const ids = createdCases.map((item) => item.id).join(", ") || "none";
          throw new Error(`TestRail upload stopped at case ${index + 1}; previously created case IDs: ${ids}.`, { cause: error });
        }
        if (!response.ok) {
          const ids = createdCases.map((item) => item.id).join(", ") || "none";
          throw new Error(`TestRail upload stopped at case ${index + 1} (HTTP ${response.status}); previously created case IDs: ${ids}. Check the section, credentials, permissions and TestRail fields.`);
        }
        const result = await response.json();
        if (result?.id == null || String(result.id).trim() === "") {
          const ids = createdCases.map((item) => item.id).join(", ") || "none";
          throw new Error(`TestRail accepted case ${index + 1} but returned no case ID; previously created case IDs: ${ids}.`);
        }
        createdCases.push({ id: result.id, title: payloads[index].title });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "created",
            issue_key: key,
            section_id,
            test_case_count: createdCases.length,
            cases: createdCases,
          }, null, 2),
        }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

function quoteTypeScript(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function buildPlaywrightSpec(issueKey, testCases) {
  const lines = [
    "import { test } from '@playwright/test';",
    "",
    `test.describe(${quoteTypeScript(issueKey)}, () => {`,
  ];

  testCases.forEach((testCase, index) => {
    const title = `TC-${String(index + 1).padStart(3, "0")}: ${testCase.scenario}`;
    lines.push(
      `  test(${quoteTypeScript(title)}, async ({ page }) => {`,
      "    test.fixme(",
      "      'Generated from manual cases; add application-specific locators, actions and assertions before enabling.'",
      "    );",
    );
    if (testCase.preconditions) {
      lines.push(
        `    await test.step(${quoteTypeScript(`Preconditions: ${testCase.preconditions}`)}, async () => {`,
        "      // TODO: Implement application-specific setup.",
        "    });",
      );
    }
    if (testCase.test_data) {
      lines.push(
        `    await test.step(${quoteTypeScript(`Test data: ${testCase.test_data}`)}, async () => {`,
        "      // TODO: Provide the test data to the application.",
        "    });",
      );
    }
    testCase.steps.forEach((step, stepIndex) => {
      lines.push(
        `    await test.step(${quoteTypeScript(`Step ${stepIndex + 1}: ${step}`)}, async () => {`,
        "      // TODO: Implement this step using application-specific locators.",
        "    });",
      );
    });
    lines.push(
      `    await test.step(${quoteTypeScript(`Expected result: ${testCase.expected_result}`)}, async () => {`,
      "      // TODO: Add assertions for the expected result.",
      "    });",
      "    void page;",
      "  });",
    );
  });

  lines.push("});");
  return `${lines.join("\n")}\n`;
}

server.registerTool(
  "write_playwright_typescript_tests",
  {
    description: "Write a Playwright TypeScript scaffold from manual test cases. The tests are marked fixme until app-specific logic is added.",
    inputSchema: {
      issue_key: z.string().min(1),
      test_cases: z.array(testCaseSchema).min(1),
    },
  },
  async ({ issue_key, test_cases }) => {
    try {
      const key = validateIssueKey(issue_key);
      const cases = normalizeTestCases(test_cases);
      const outputDir = path.join(root, "output", "playwright");
      await fs.mkdir(outputDir, { recursive: true });
      const filePath = path.join(outputDir, `${key.toLowerCase()}_spec.ts`);
      await fs.writeFile(filePath, buildPlaywrightSpec(key, cases), "utf8");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "written",
            issue_key: key,
            test_case_count: cases.length,
            file_path: filePath,
            note: "Tests are marked fixme and require application-specific locators, actions and assertions before they can run.",
          }, null, 2),
        }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

export { adfToText, buildPlaywrightSpec, normalizeTestCases, validateIssueKey };

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
