// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = process.env.NORA_MARKETING_PROOF_DIR || path.resolve(__dirname, "../artifacts/marketing-proof");
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:18080";

const shots = [
  {
    path: "/",
    file: "proof-landing-open-source-funnel.png",
    readyText: /Deploy intelligence anywhere\./i,
  },
  {
    path: "/pricing",
    file: "proof-usage-rights-apache.png",
    readyText: /Fully open source\./i,
  },
  {
    path: "/signup",
    file: "proof-signup-operator-account.png",
    readyText: /Create Operator Account/i,
  },
];

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 1.5 });

for (const shot of shots) {
  const url = new URL(shot.path, baseUrl).toString();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByText(shot.readyText).first().waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(outputDir, shot.file), fullPage: true });
  console.log(`saved ${shot.file}`);
}

await browser.close();
