
import { chromium } from "playwright";
import WebSocket from "ws";
import fs from "node:fs";

const {
  SESSION_ID,
  WORKER_URL,
  RUNNER_SHARED_SECRET,
  CUSTOM_INSTRUCTIONS,
  GEMINI_STORAGE_STATE
} = process.env;

if (!SESSION_ID || !WORKER_URL || !RUNNER_SHARED_SECRET) {
  throw new Error("Missing required environment variables");
}

const instructions = CUSTOM_INSTRUCTIONS ||
  "You are a helpful AI assistant.";

const socketUrl =
  `${WORKER_URL.replace(/^http/, "ws")}` +
  `/session/${encodeURIComponent(SESSION_ID)}/connect?role=runner`;

let browser;
let page;
let socket;
let processing = false;

async function send(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

async function initializeBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

  const contextOptions = {};

  if (GEMINI_STORAGE_STATE) {
    const path = "/tmp/gemini-auth.json";

    fs.writeFileSync(
      path,
      Buffer.from(GEMINI_STORAGE_STATE, "base64")
    );

    contextOptions.storageState = path;
  }

  const context = await browser.newContext(contextOptions);
  page = await context.newPage();

  await page.goto("https://gemini.google.com/app", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  // Do not attempt to bypass login or access protections.
  await page.waitForTimeout(3000);

  const loginRequired =
    await page.getByText(/sign in|log in/i).count();

  if (loginRequired) {
    throw new Error(
      "Gemini authentication is required. " +
      "Provide an authorized browser session."
    );
  }

  console.log("Gemini browser initialized");
}

async function askGemini(userMessage) {
  if (!page) throw new Error("Browser is not initialized");

  const fullPrompt =
    `${instructions}\n\n` +
    `User message:\n${userMessage}`;

  // Gemini's UI changes periodically. These selectors
  // must be verified against the current interface.
  const input = page.locator(
    'div[contenteditable="true"]'
  ).first();

  await input.waitFor({
    state: "visible",
    timeout: 30000
  });

  await input.fill(fullPrompt);

  await input.press("Enter");

  // Wait for Gemini to finish responding.
  await page.waitForTimeout(1500);

  const response = page.locator(
    "model-response"
  ).last();

  await response.waitFor({
    state: "visible",
    timeout: 120000
  });

  await page.waitForTimeout(2000);

  const result = await response.innerText();

  if (!result.trim()) {
    throw new Error("Gemini returned an empty response");
  }

  return result;
}

async function handleMessage(data) {
  if (data.type !== "message") return;

  if (processing) {
    await send({
      type: "error",
      message: "This session is currently processing another message."
    });
    return;
  }

  processing = true;

  try {
    await send({
      type: "status",
      status: "Gemini is generating a response..."
    });

    const answer = await askGemini(data.text);

    await send({
      type: "response",
      text: answer
    });

  } catch (error) {
    console.error(error);

    await send({
      type: "error",
      message: error.message
    });

  } finally {
    processing = false;
  }
}

async function main() {
  await initializeBrowser();

  socket = new WebSocket(socketUrl, {
    headers: {
      Authorization: `Bearer ${RUNNER_SHARED_SECRET}`
    }
  });

  socket.on("open", async () => {
    console.log("Connected to Cloudflare");

    await send({
      type: "status",
      status: "ready"
    });
  });

  socket.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());
      await handleMessage(data);
    } catch (error) {
      console.error("Message processing error:", error);
    }
  });

  socket.on("close", async () => {
    console.log("Cloudflare connection closed");
    await cleanup();
  });

  socket.on("error", error => {
    console.error("WebSocket error:", error);
  });
}

async function cleanup() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }

  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

main().catch(async error => {
  console.error("Runner initialization failed:", error);
  await cleanup();
});
