import { chromium } from "../../node_modules/playwright/index.mjs";

const baseUrl = process.env.ACTIONS_JSON_ACCEPTANCE_URL ?? "http://127.0.0.1:18501";
const screenshot = process.env.ACTIONS_JSON_ACCEPTANCE_SCREENSHOT
  ?? "/tmp/streamlit-snowflake-acceptance.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByText("actions.json · Streamlit on Snowflake").waitFor();
  const button = page.getByRole("button", { name: "Read through Snowflake" });

  await button.click();
  await page.getByText(/action_call_output/).first().waitFor();
  await page.getByText(/"provider_invocations":\s*1/).waitFor();
  await page.getByText(/"rows_observed":\s*1/).waitFor();
  await page.getByText(/"url":\s*"snowflake:\/\/actions-json\/transport-probe"/).waitFor();

  await button.click();
  await page.getByText(/"from_receipt":\s*true/).first().waitFor();
  await page.getByText(/"provider_invocations":\s*1/).waitFor();

  await page.screenshot({ path: screenshot, fullPage: true });
  console.log("streamlit container browser acceptance: PASS");
} finally {
  await browser.close();
}
