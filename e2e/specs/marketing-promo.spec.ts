import { expect, test } from "@playwright/test";

const REPO_URL = "https://github.com/solomon2773/nora";
const DOCS_URL = "https://noradocs.solomontsao.com";

function collectPublicPageFailures(page) {
  const authFailures: string[] = [];
  const httpFailures: string[] = [];
  const consoleErrors: string[] = [];

  page.on("response", (response) => {
    if (response.status() === 401) authFailures.push(response.url());
    if (response.status() < 400 || response.status() === 401) return;
    const pathname = new URL(response.url()).pathname;
    if (pathname === "/api/config/platform" || pathname === "/api/auth/bootstrap-status") return;
    httpFailures.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message
        .text()
        .startsWith("Failed to load resource: the server responded with a status of 404")
    ) {
      consoleErrors.push(message.text());
    }
  });

  return { authFailures, httpFailures, consoleErrors };
}

test.describe("Promo-ready marketing funnel", () => {
  test("desktop landing shows real product proof and OSS-first activation paths", async ({
    page,
  }) => {
    const failures = collectPublicPageFailures(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveTitle(/Run OpenClaw & Hermes on your infrastructure/);
    await expect(
      page.getByRole("heading", {
        name: /run openclaw and hermes on infrastructure you control/i,
      }),
    ).toBeVisible();

    const proof = page.getByTestId("product-proof-image");
    await expect(proof).toBeVisible();
    await expect
      .poll(() => proof.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(600);

    await expect(
      page.getByRole("link", { name: /try the zero-key demo/i }).first(),
    ).toHaveAttribute("href", "/signup?intent=demo");
    await expect(page.getByRole("link", { name: /star on github/i }).first()).toHaveAttribute(
      "href",
      REPO_URL,
    );
    await expect(page.getByRole("link", { name: /self-host nora/i })).toHaveAttribute(
      "href",
      `${DOCS_URL}/quickstart`,
    );
    await expect(page.getByRole("link", { name: /^contribute$/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /join the community/i })).toBeVisible();

    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://nora.solomontsao.com/");
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      "https://nora.solomontsao.com/",
    );
    await expect(page.locator('link[rel="alternate"][hreflang="es"]')).toHaveAttribute(
      "href",
      "https://nora.solomontsao.com/es",
    );

    await page
      .getByRole("link", { name: /try the zero-key demo/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/signup\?intent=demo$/);
    await expect(page.getByRole("heading", { name: /try nora without an api key/i })).toBeVisible();

    expect(failures.authFailures, "public pages must not probe protected auth endpoints").toEqual(
      [],
    );
    expect(failures.httpFailures, "public assets and routes must load successfully").toEqual([]);
    expect(failures.consoleErrors, "public funnel should not emit console errors").toEqual([]);
  });

  test("page-specific metadata does not inherit the home canonical", async ({ page }) => {
    await page.goto("/pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://nora.solomontsao.com/pricing",
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Open Source, License, and PaaS Mode | Nora",
    );

    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://nora.solomontsao.com/login",
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      "https://nora.solomontsao.com/login",
    );
  });
});

test.describe("Promo-ready mobile navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("menu exposes language, docs, community, and demo actions accessibly", async ({ page }) => {
    const failures = collectPublicPageFailures(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const menuButton = page.getByRole("button", { name: /toggle navigation/i });
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");

    const mobileNav = page.getByRole("navigation", { name: /mobile navigation/i });
    await expect(mobileNav).toBeVisible();
    await expect(mobileNav.getByLabel("Language")).toBeVisible();
    await expect(mobileNav.getByRole("link", { name: /^docs$/i })).toBeVisible();
    await expect(mobileNav.getByRole("link", { name: /^contribute$/i })).toBeVisible();
    await expect(mobileNav.getByRole("link", { name: /^community$/i })).toBeVisible();
    await expect(mobileNav.getByRole("link", { name: /try the zero-key demo/i })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect(mobileNav).toBeHidden();
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");

    expect(failures.authFailures).toEqual([]);
    expect(failures.httpFailures).toEqual([]);
    expect(failures.consoleErrors).toEqual([]);
  });
});
