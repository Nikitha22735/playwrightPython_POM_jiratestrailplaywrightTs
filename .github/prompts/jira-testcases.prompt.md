---
name: Jira test cases
description: Create manual cases and a Playwright TypeScript scaffold from a Jira issue using this workspace's MCP server.
argument-hint: Jira issue key, for example DEMO-123
agent: agent
---

Use the Jira MCP server configured in this workspace.

1. Read the Jira issue using `get_jira_story` for the issue key: ${input:issue_key:Enter a Jira issue key}.
2. Using only the issue summary and description, draft 5 to 10 useful manual test cases. Do not invent application behavior or selectors. Include positive, negative, and boundary scenarios only where the Jira requirements support them. Clearly note missing information.
3. Use the `save_test_cases_to_excel` tool to save the cases for this issue.
4. Use the `write_playwright_typescript_tests` tool to write a Playwright TypeScript scaffold from the same cases.
5. Do not upload anything to TestRail unless the user specifically asks.

Report the generated file paths and explain that the Playwright tests need application-specific locators, actions, and assertions before they can run.
