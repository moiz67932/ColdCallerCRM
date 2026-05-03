import { normalizeWebsiteUrl, classifyPage, normalizeText } from "@/lib/demo-agent/extraction";
import type { ScrapedPage } from "@/lib/demo-agent/contracts";
import { logInfo, logWarn } from "@/lib/logger";

const blockedResourceTypes = new Set(["image", "media", "font"]);
const blockedHosts = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "facebook.net"];
const preferredSegments = ["services", "pricing", "faq", "about", "contact", "insurance", "patient", "appointment", "new-patient", "forms"];

type CrawlOptions = {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  pageTimeoutMs: number;
  userAgent: string;
  maxTextChars: number;
  maxHtmlChars: number;
};

type CrawlResult = {
  pages: ScrapedPage[];
  pagesDiscovered: number;
  pagesFailed: number;
};

function getCrawlOptions(): CrawlOptions {
  const readPositiveInteger = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  };

  const readNonNegativeInteger = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
  };

  return {
    maxPages: readPositiveInteger("SCRAPER_MAX_PAGES", 30),
    maxDepth: readNonNegativeInteger("SCRAPER_MAX_DEPTH", 2),
    concurrency: readPositiveInteger("SCRAPER_CONCURRENCY", 2),
    pageTimeoutMs: readPositiveInteger("SCRAPER_PAGE_TIMEOUT_MS", 20_000),
    userAgent: process.env.SCRAPER_USER_AGENT ?? "Mozilla/5.0 DemoClinicBot/1.0",
    maxTextChars: readPositiveInteger("SCRAPER_MAX_TEXT_CHARS", 60_000),
    maxHtmlChars: readPositiveInteger("SCRAPER_MAX_HTML_CHARS", 80_000),
  };
}

function rankUrl(url: string) {
  const lower = url.toLowerCase();
  const matchedIndex = preferredSegments.findIndex((segment) => lower.includes(segment));
  return matchedIndex === -1 ? preferredSegments.length : matchedIndex;
}

function shouldAllowByRobots(_url: URL) {
  if ((process.env.SCRAPER_RESPECT_ROBOTS_TXT ?? "true") !== "true") {
    return true;
  }

  return true;
}

function sameDomainLinks(sourceUrl: URL, links: string[]) {
  return links
    .map((href) => {
      try {
        return new URL(href, sourceUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((href): href is string => Boolean(href))
    .filter((href) => {
      const nextUrl = new URL(href);
      return nextUrl.hostname === sourceUrl.hostname && ["http:", "https:"].includes(nextUrl.protocol);
    })
    .map((href) => href.replace(/#.*$/, "").replace(/\/$/, ""))
    .filter(Boolean);
}

function mapPlaywrightLaunchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Executable doesn't exist") || message.includes("Looks like Playwright was just installed or updated")) {
    return new Error(
      "Playwright Chromium is not installed for the Node runtime running this app. " +
        "Run `npx playwright install chromium` in the same terminal/environment you use for `npm run dev`, then click Create Agent again.",
    );
  }

  if (message.includes("libnspr4.so")) {
    return new Error(
      "Playwright Chromium cannot start because Linux dependency `libnspr4.so` is missing. " +
        "Install browser dependencies with `npx playwright install --with-deps chromium` " +
        "or install the package `libnspr4` with your system package manager, then retry.",
    );
  }

  if (message.includes("error while loading shared libraries")) {
    return new Error(
      "Playwright Chromium is missing Linux shared libraries. Run `npx playwright install --with-deps chromium` and retry.",
    );
  }

  return error instanceof Error ? error : new Error(message);
}

export async function crawlLeadWebsite(rootInput: string): Promise<CrawlResult> {
  const rootUrl = normalizeWebsiteUrl(rootInput);
  const options = getCrawlOptions();
  const { chromium } = await import("playwright");

  logInfo("lead_scraper.crawl_start", {
    rootUrl,
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    concurrency: options.concurrency,
    pageTimeoutMs: options.pageTimeoutMs,
  });

  const browser = await chromium.launch({ headless: true }).catch((error) => {
    throw mapPlaywrightLaunchError(error);
  });
  const context = await browser.newContext({
    userAgent: options.userAgent,
    viewport: { width: 1440, height: 960 },
  });

  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();

    if (blockedResourceTypes.has(request.resourceType()) || blockedHosts.some((host) => url.includes(host))) {
      return route.abort();
    }

    return route.continue();
  });

  const queue: Array<{ url: string; depth: number }> = [{ url: rootUrl, depth: 0 }];
  const visited = new Set<string>();
  const pages: ScrapedPage[] = [];
  let pagesFailed = 0;

  try {
    const workerCount = Math.max(1, options.concurrency);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && pages.length < options.maxPages) {
          queue.sort((left, right) => rankUrl(left.url) - rankUrl(right.url));
          const next = queue.shift();

          if (!next || visited.has(next.url)) {
            continue;
          }

          visited.add(next.url);
          const page = await context.newPage();
          page.setDefaultTimeout(options.pageTimeoutMs);

          try {
            const parsedUrl = new URL(next.url);

            if (!shouldAllowByRobots(parsedUrl)) {
              continue;
            }

            logInfo("lead_scraper.page_start", { url: next.url, depth: next.depth });

            const response = await page.goto(next.url, { waitUntil: "domcontentloaded", timeout: options.pageTimeoutMs });
            await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);

            const extracted = await page.evaluate(() => {
              const text = document.body?.innerText ?? "";
              const canonical = document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? null;
              const metaDescription = document.querySelector("meta[name='description']")?.getAttribute("content") ?? null;
              const jsonLd = [...document.querySelectorAll("script[type='application/ld+json']")].map((node) => {
                try {
                  return JSON.parse(node.textContent ?? "null");
                } catch {
                  return null;
                }
              });
              const links = [...document.querySelectorAll("a[href]")].map((anchor) => anchor.getAttribute("href") ?? "");

              return {
                title: document.title || null,
                text,
                html: document.body?.innerHTML ?? "",
                canonical,
                metaDescription,
                jsonLd,
                links,
              };
            });

            const cleanedText = extracted.text
              .split("\n")
              .map(normalizeText)
              .filter(Boolean)
              .join("\n")
              .slice(0, options.maxTextChars);

            const canonicalUrl = extracted.canonical ? new URL(extracted.canonical, next.url).toString().replace(/\/$/, "") : null;

            const pageRecord: ScrapedPage = {
              url: next.url,
              canonicalUrl,
              title: extracted.title,
              metaDescription: extracted.metaDescription,
              cleanedText,
              html: extracted.html.slice(0, options.maxHtmlChars),
              jsonLd: extracted.jsonLd.filter(Boolean),
              links: sameDomainLinks(new URL(next.url), extracted.links),
              httpStatus: response?.status() ?? null,
              pageType: classifyPage(next.url, extracted.title),
            };

            const duplicatePage = pages.some(
              (entry) => entry.url === pageRecord.url || (Boolean(entry.canonicalUrl) && entry.canonicalUrl === pageRecord.canonicalUrl),
            );

            if (pageRecord.cleanedText && !duplicatePage) {
              pages.push(pageRecord);
              logInfo("lead_scraper.page_scraped", {
                url: pageRecord.url,
                status: pageRecord.httpStatus,
                pageType: pageRecord.pageType,
                textChars: pageRecord.cleanedText.length,
                links: pageRecord.links.length,
              });
            } else {
              logWarn("lead_scraper.page_skipped", {
                url: pageRecord.url,
                status: pageRecord.httpStatus,
                reason: duplicatePage ? "duplicate" : "empty_text",
              });
            }

            if (next.depth < options.maxDepth) {
              for (const link of pageRecord.links) {
                if (!visited.has(link) && queue.length + pages.length < options.maxPages * 3) {
                  queue.push({ url: link, depth: next.depth + 1 });
                }
              }
            }
          } catch (error) {
            pagesFailed += 1;
            logWarn("lead_scraper.page_failed", {
              url: next.url,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            await page.close().catch(() => undefined);
          }
        }
      }),
    );
  } finally {
    await context.close();
    await browser.close();
  }

  if (!pages.length) {
    throw new Error(
      `No readable website pages were scraped from ${rootUrl}. Check that the URL is reachable, public, and not blocking automated browsers.`,
    );
  }

  logInfo("lead_scraper.crawl_complete", {
    rootUrl,
    pagesDiscovered: visited.size,
    pagesScraped: pages.length,
    pagesFailed,
  });

  return {
    pages,
    pagesDiscovered: visited.size,
    pagesFailed,
  };
}
