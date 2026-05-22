import { normalizeWebsiteUrl, classifyPage, normalizeText } from "@/lib/demo-agent/extraction";
import type { ScrapedLink, ScrapedPage, ScrapedStructuredBlock } from "@/lib/demo-agent/contracts";
import { logInfo, logWarn } from "@/lib/logger";

const blockedResourceTypes = new Set(["image", "media", "font"]);
const blockedHosts = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "facebook.net"];
const preferredSegments = [
  "services",
  "treatments",
  "pricing",
  "book",
  "booking",
  "appointments",
  "menu",
  "facial",
  "facials",
  "injectables",
  "botox",
  "filler",
  "laser",
  "skin",
  "wellness",
  "membership",
  "specials",
  "contact",
  "hours",
  "faq",
  "about",
  "insurance",
  "patient",
  "appointment",
  "new-patient",
  "forms",
];

const highValueSitemapPattern = /service|treatment|pricing|book|booking|appointment|menu|facial|injectable|botox|filler|laser|skin|wellness|membership|special|contact|hours|faq|about/i;

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

function rankUrl(url: string, hint = "") {
  const lower = `${url} ${hint}`.toLowerCase();
  const matchedIndex = preferredSegments.findIndex((segment) => lower.includes(segment));
  return matchedIndex === -1 ? preferredSegments.length : matchedIndex;
}

type RobotsRules = {
  disallow: string[];
  allow: string[];
};

function parseRobotsTxt(text: string, userAgent: string): RobotsRules {
  const targetAgents = [userAgent.toLowerCase().split(/[\/\s]/)[0], "*"].filter(Boolean);
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!current || current.allow.length || current.disallow.length) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && key === "allow") {
      current.allow.push(value);
    } else if (current && key === "disallow" && value) {
      current.disallow.push(value);
    }
  }

  const matching = groups.filter((group) => group.agents.some((agent) => targetAgents.some((target) => agent === target || agent === "*")));
  return {
    allow: matching.flatMap((group) => group.allow),
    disallow: matching.flatMap((group) => group.disallow),
  };
}

async function loadRobotsRules(rootUrl: string, userAgent: string): Promise<RobotsRules | null> {
  if ((process.env.SCRAPER_RESPECT_ROBOTS_TXT ?? "true") !== "true") return null;
  try {
    const root = new URL(rootUrl);
    const response = await fetch(`${root.origin}/robots.txt`, { headers: { "user-agent": userAgent } });
    if (!response.ok) return { allow: [], disallow: [] };
    return parseRobotsTxt(await response.text(), userAgent);
  } catch (error) {
    logWarn("lead_scraper.robots_failed", { rootUrl, error: error instanceof Error ? error.message : String(error) });
    return { allow: [], disallow: [] };
  }
}

function robotsPathMatches(rule: string, path: string) {
  if (!rule) return false;
  const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${pattern}`).test(path);
}

function isAllowedByRobots(url: URL, rules: RobotsRules | null) {
  if (!rules) return true;
  const path = `${url.pathname}${url.search}`;
  const matchingAllow = rules.allow.filter((rule) => robotsPathMatches(rule, path)).sort((a, b) => b.length - a.length)[0];
  const matchingDisallow = rules.disallow.filter((rule) => robotsPathMatches(rule, path)).sort((a, b) => b.length - a.length)[0];
  if (!matchingDisallow) return true;
  return Boolean(matchingAllow && matchingAllow.length >= matchingDisallow.length);
}

function sameDomainLinks(sourceUrl: URL, links: ScrapedLink[]) {
  return links
    .map((link) => {
      try {
        return {
          ...link,
          href: new URL(link.href, sourceUrl).toString().replace(/#.*$/, "").replace(/\/$/, ""),
        };
      } catch {
        return null;
      }
    })
    .filter((link): link is ScrapedLink => Boolean(link?.href))
    .filter((link) => {
      const nextUrl = new URL(link.href);
      return nextUrl.hostname === sourceUrl.hostname && ["http:", "https:"].includes(nextUrl.protocol);
    })
    .filter((link, index, all) => all.findIndex((entry) => entry.href === link.href) === index);
}

async function discoverSitemapUrls(rootUrl: string, options: CrawlOptions) {
  const root = new URL(rootUrl);
  const sitemapUrl = `${root.origin}/sitemap.xml`;
  try {
    const response = await fetch(sitemapUrl, { headers: { "user-agent": options.userAgent } });
    if (!response.ok) return [];
    const xml = await response.text();
    const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
      .map((match) => match[1].trim())
      .filter((value) => {
        try {
          const url = new URL(value);
          return url.hostname === root.hostname && highValueSitemapPattern.test(url.toString());
        } catch {
          return false;
        }
      })
      .map((url) => url.replace(/#.*$/, "").replace(/\/$/, ""));
    return [...new Set(urls)].sort((left, right) => rankUrl(left) - rankUrl(right)).slice(0, Math.max(0, options.maxPages - 1));
  } catch (error) {
    logWarn("lead_scraper.sitemap_failed", { rootUrl, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function summarizeJsonLd(jsonLd: unknown[]) {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    nodes.push(record);
    if (Array.isArray(record["@graph"])) record["@graph"].forEach(visit);
    if (record.offers) visit(record.offers);
    if (record.itemListElement) visit(record.itemListElement);
  };
  jsonLd.forEach(visit);
  const types = [...new Set(nodes.flatMap((node) => {
    const type = node["@type"];
    return Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
  }))];
  const names = [...new Set(nodes.map((node) => (typeof node.name === "string" ? node.name.trim() : "")).filter(Boolean))].slice(0, 20);
  return { types, names, node_count: nodes.length };
}

function extractPriceText(text: string) {
  return normalizeText([...text.matchAll(/\$[0-9][0-9,]*(?:\.\d{2})?(?:\s*(?:-|to)\s*\$?[0-9][0-9,]*(?:\.\d{2})?)?(?:\s*(?:\/|per)\s*\w+)?/gi)].map((match) => match[0]).join(" ")) || null;
}

function extractDurationText(text: string) {
  return normalizeText([...text.matchAll(/\b(?:\d{1,2}\s*h(?:ours?)?(?:\s*\d{1,2}\s*min(?:utes?)?)?|\d{1,3}\s*(?:-|to)?\s*\d{0,3}\s*(?:minutes?|mins?|min))\b/gi)].map((match) => match[0]).join(" ")) || null;
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[lower] ?? match;
  });
}

function stripHtml(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function readAttribute(tag: string, attribute: string) {
  const match = tag.match(new RegExp(`${attribute}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i"));
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, "").trim() || null;
}

function extractFirst(html: string, pattern: RegExp) {
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : null;
}

function extractJsonLdFromHtml(html: string) {
  return [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => {
      try {
        return JSON.parse(decodeHtmlEntities(match[1].trim()));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractLinksFromHtml(html: string): ScrapedLink[] {
  return [...html.matchAll(/<a\b[^>]*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => {
    const tag = match[0];
    return {
      href: match[1].replace(/^["']|["']$/g, "").trim(),
      text: normalizeText(stripHtml(match[2])).slice(0, 140),
      ariaLabel: readAttribute(tag, "aria-label"),
      title: readAttribute(tag, "title"),
    };
  });
}

function extractStructuredBlocksFromHtml(html: string, sourceUrl: string): ScrapedStructuredBlock[] {
  const blocks = new Map<string, ScrapedStructuredBlock>();
  const addBlock = (kind: ScrapedStructuredBlock["kind"], heading: string | null, textValue: string, domHint: string, confidence = 0.7, items?: Array<Record<string, unknown>>) => {
    const text = normalizeText(stripHtml(textValue)).slice(0, 1800);
    const key = `${kind}:${heading ?? ""}:${text.slice(0, 180)}`;
    if (text.length >= 8 && !blocks.has(key)) {
      blocks.set(key, {
        kind,
        type: kind,
        heading,
        text,
        price_text: extractPriceText(text),
        duration_text: extractDurationText(text),
        source_url: sourceUrl,
        dom_hint: domHint,
        confidence,
        items,
        source: domHint,
      });
    }
  };

  for (const match of html.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>([\s\S]{0,2400})/gi)) {
    const heading = normalizeText(stripHtml(match[2]));
    const text = `${heading}\n${match[3].split(/<h[1-4]\b/i)[0] ?? ""}`;
    if (heading) addBlock("heading_section", heading, text, `h${match[1]}`, 0.58);
  }

  for (const match of html.matchAll(/<(section|article|li|div)\b[^>]*(?:service|treatment|card|price|faq|contact|location|hours)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripHtml(match[2]);
    const heading = extractFirst(match[2], /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
    const kind = /faq|\?/i.test(text) ? "faq_pair" : /hours|monday|tuesday/i.test(text) ? "hours_block" : /contact|location|address|phone/i.test(text) ? "contact_block" : /book|deposit|required/i.test(text) ? "booking_service_card" : /team|staff|provider|esthetician|doctor|nurse/i.test(text) ? "staff_card" : /special|package|membership|gift/i.test(text) ? "offer_card" : "service_card";
    addBlock(kind, heading ? normalizeText(stripHtml(heading)) : null, match[2], match[1].toLowerCase(), kind === "service_card" ? 0.82 : 0.72);
  }

  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const text = stripHtml(match[1]);
    if (/\$|price|cost|unit|series|package/i.test(text)) addBlock("pricing_table_row", null, match[1], "table", 0.9);
  }

  return [...blocks.values()].slice(0, 80);
}

function htmlToScrapedPage(input: {
  url: string;
  html: string;
  status: number | null;
  options: CrawlOptions;
}): ScrapedPage {
  const { url, html, status, options } = input;
  const title = extractFirst(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = extractFirst(html, /<meta\b(?=[^>]*name\s*=\s*["']description["'])[^>]*content\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.replace(/^["']|["']$/g, "") ?? null;
  const canonical = extractFirst(html, /<link\b(?=[^>]*rel\s*=\s*["']canonical["'])[^>]*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.replace(/^["']|["']$/g, "") ?? null;
  const jsonLd = extractJsonLdFromHtml(html);
  const cleanedText = stripHtml(html)
    .split("\n")
    .map(normalizeText)
    .filter(Boolean)
    .join("\n")
    .slice(0, options.maxTextChars);

  return {
    url,
    canonicalUrl: canonical ? new URL(canonical, url).toString().replace(/\/$/, "") : null,
    title,
    metaDescription,
    cleanedText,
    html: html.slice(0, options.maxHtmlChars),
    jsonLd,
    links: [],
    linkHints: extractLinksFromHtml(html),
    structuredBlocks: extractStructuredBlocksFromHtml(html, url),
    jsonLdSummary: summarizeJsonLd(jsonLd),
    httpStatus: status,
    pageType: classifyPage(url, title),
  };
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

async function crawlLeadWebsiteWithFetch(rootUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const robotsRules = await loadRobotsRules(rootUrl, options.userAgent);
  const sitemapUrls = await discoverSitemapUrls(rootUrl, options);
  const queue: Array<{ url: string; depth: number; hint?: string }> = [
    { url: rootUrl, depth: 0 },
    ...sitemapUrls.map((url) => ({ url, depth: 1, hint: "sitemap" })),
  ];
  const visited = new Set<string>();
  const pages: ScrapedPage[] = [];
  let pagesFailed = 0;

  logWarn("lead_scraper.browser_unavailable_fetch_fallback", { rootUrl });

  while (queue.length > 0 && pages.length < options.maxPages) {
    queue.sort((left, right) => rankUrl(left.url, left.hint) - rankUrl(right.url, right.hint));
    const next = queue.shift();
    if (!next || visited.has(next.url)) continue;
    visited.add(next.url);

    try {
      const parsedUrl = new URL(next.url);
      if (!isAllowedByRobots(parsedUrl, robotsRules)) {
        logWarn("lead_scraper.page_skipped", { url: next.url, reason: "robots_disallow" });
        continue;
      }

      const response = await fetch(next.url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": options.userAgent,
        },
        signal: AbortSignal.timeout(options.pageTimeoutMs),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.toLowerCase().includes("html")) {
        pagesFailed += 1;
        logWarn("lead_scraper.page_failed", { url: next.url, status: response.status, contentType });
        continue;
      }

      const pageRecord = htmlToScrapedPage({
        url: next.url,
        html: await response.text(),
        status: response.status,
        options,
      });
      const linkHints = sameDomainLinks(new URL(next.url), pageRecord.linkHints ?? []);
      pageRecord.linkHints = linkHints;
      pageRecord.links = linkHints;

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
          renderer: "fetch",
        });
      }

      if (next.depth < options.maxDepth) {
        for (const link of pageRecord.links) {
          if (!visited.has(link.href) && queue.length + pages.length < options.maxPages * 3) {
            queue.push({ url: link.href, depth: next.depth + 1, hint: [link.text, link.ariaLabel, link.title].filter(Boolean).join(" ") });
          }
        }
      }
    } catch (error) {
      pagesFailed += 1;
      logWarn("lead_scraper.page_failed", {
        url: next.url,
        error: error instanceof Error ? error.message : String(error),
        renderer: "fetch",
      });
    }
  }

  if (!pages.length) {
    throw new Error(
      `No readable website pages were scraped from ${rootUrl}. Check that the URL is reachable, public, and not blocking automated browsers.`,
    );
  }

  return {
    pages,
    pagesDiscovered: visited.size,
    pagesFailed,
  };
}

async function crawlLeadWebsiteWithPlaywright(rootUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const { chromium } = await import("playwright");
  const robotsRules = await loadRobotsRules(rootUrl, options.userAgent);
  const sitemapUrls = await discoverSitemapUrls(rootUrl, options);

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

  const queue: Array<{ url: string; depth: number; hint?: string }> = [
    { url: rootUrl, depth: 0 },
    ...sitemapUrls.map((url) => ({ url, depth: 1, hint: "sitemap" })),
  ];
  const visited = new Set<string>();
  const pages: ScrapedPage[] = [];
  let pagesFailed = 0;

  try {
    const workerCount = Math.max(1, options.concurrency);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && pages.length < options.maxPages) {
          queue.sort((left, right) => rankUrl(left.url, left.hint) - rankUrl(right.url, right.hint));
          const next = queue.shift();

          if (!next || visited.has(next.url)) {
            continue;
          }

          visited.add(next.url);
          const page = await context.newPage();
          page.setDefaultTimeout(options.pageTimeoutMs);

          try {
            const parsedUrl = new URL(next.url);

            if (!isAllowedByRobots(parsedUrl, robotsRules)) {
              logWarn("lead_scraper.page_skipped", { url: next.url, reason: "robots_disallow" });
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
              const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
              const compactText = (element: Element | null) => clean(element?.textContent).slice(0, 1200);
              const headingText = (root: Element) => clean(root.querySelector("h1,h2,h3,h4,[role='heading']")?.textContent);
              const links = [...document.querySelectorAll("a[href]")].map((anchor) => ({
                href: anchor.getAttribute("href") ?? "",
                text: clean(anchor.textContent).slice(0, 140),
                ariaLabel: clean(anchor.getAttribute("aria-label")) || null,
                title: clean(anchor.getAttribute("title")) || null,
              }));
              const priceText = (value: string) => [...value.matchAll(/\$[0-9][0-9,]*(?:\.\d{2})?(?:\s*(?:-|to)\s*\$?[0-9][0-9,]*(?:\.\d{2})?)?(?:\s*(?:\/|per)\s*\w+)?/gi)].map((match) => match[0]).join(" ") || null;
              const durationText = (value: string) => [...value.matchAll(/\b(?:\d{1,2}\s*h(?:ours?)?(?:\s*\d{1,2}\s*min(?:utes?)?)?|\d{1,3}\s*(?:-|to)?\s*\d{0,3}\s*(?:minutes?|mins?|min))\b/gi)].map((match) => match[0]).join(" ") || null;
              const structuredBlocks = new Map<string, { kind: string; type: string; heading: string | null; text: string; price_text?: string | null; duration_text?: string | null; source_url?: string | null; dom_hint?: string | null; confidence?: number; items?: Array<Record<string, unknown>>; source?: string | null }>();
              const addBlock = (kind: string, heading: string | null, textValue: string, items?: Array<Record<string, unknown>>, source?: string | null, confidence = 0.7) => {
                const text = clean(textValue).slice(0, 1800);
                const key = `${kind}:${heading ?? ""}:${text.slice(0, 180)}`;
                if (text.length >= 8 && !structuredBlocks.has(key)) structuredBlocks.set(key, { kind, type: kind, heading: heading ? clean(heading) : null, text, price_text: priceText(text), duration_text: durationText(text), source_url: location.href, dom_hint: source ?? null, confidence, items, source: source ?? null });
              };

              for (const heading of document.querySelectorAll("h1,h2,h3,h4")) {
                const section = heading.closest("section,article,main,div") ?? heading.parentElement;
                const headingValue = clean(heading.textContent);
                const textValue = compactText(section);
                if (headingValue && textValue) addBlock("heading_section", headingValue, textValue, undefined, heading.tagName.toLowerCase(), 0.58);
              }

              for (const element of document.querySelectorAll("[class*='service' i], [class*='treatment' i], [class*='card' i], article, li")) {
                const heading = headingText(element);
                const textValue = compactText(element);
                if (heading && /service|treatment|facial|inject|botox|filler|laser|skin|price|\$/i.test(`${heading} ${textValue}`)) {
                  const kind = /book|deposit|required/i.test(textValue) ? "booking_service_card" : /special|package|membership|gift/i.test(textValue) ? "offer_card" : "service_card";
                  addBlock(kind, heading, textValue, undefined, "dom_card", 0.84);
                }
              }

              for (const row of document.querySelectorAll("table tr")) {
                const cells = [...row.querySelectorAll("th,td")].map((cell) => clean(cell.textContent)).filter(Boolean);
                if (cells.length >= 2 && /\$|price|cost|unit|series|package/i.test(cells.join(" "))) {
                  addBlock("pricing_table_row", cells[0] ?? null, cells.join(" | "), cells.map((cell, index) => ({ index, text: cell })), "table", 0.92);
                }
              }

              for (const element of document.querySelectorAll("details, [class*='accordion' i], [class*='faq' i]")) {
                const heading = clean(element.querySelector("summary,h1,h2,h3,h4,button")?.textContent) || headingText(element);
                const textValue = compactText(element);
                if (textValue.includes("?")) addBlock("faq_pair", heading || null, textValue, undefined, "faq_dom", 0.82);
                else addBlock("heading_section", heading || null, textValue, undefined, "accordion_dom", 0.6);
              }

              for (const element of document.querySelectorAll("[role='tab'], [role='tabpanel'], [class*='tab' i]")) {
                const heading = headingText(element) || clean(element.getAttribute("aria-label"));
                const textValue = compactText(element);
                if (textValue) addBlock("heading_section", heading || null, textValue, undefined, "tab_dom", 0.6);
              }

              for (const element of document.querySelectorAll("address, [class*='contact' i], [class*='location' i], [class*='hours' i]")) {
                const textValue = compactText(element);
                if (/@|\(?\d{3}\)?|hours|monday|tuesday|wednesday|thursday|friday/i.test(textValue)) {
                  addBlock(/hours|monday|tuesday|wednesday/i.test(textValue) ? "hours_block" : "contact_block", headingText(element) || null, textValue, undefined, "contact_dom", 0.88);
                }
              }

              for (const anchor of document.querySelectorAll("nav a[href], header a[href], footer a[href]")) {
                const textValue = clean(anchor.textContent);
                if (textValue) addBlock("navigation_link", textValue, textValue, undefined, "navigation", 0.95);
              }

              return {
                title: document.title || null,
                text,
                html: document.body?.innerHTML ?? "",
                canonical,
                metaDescription,
                jsonLd,
                links,
                structuredBlocks: [...structuredBlocks.values()],
              };
            });

            const cleanedText = extracted.text
              .split("\n")
              .map(normalizeText)
              .filter(Boolean)
              .join("\n")
              .slice(0, options.maxTextChars);

            const canonicalUrl = extracted.canonical ? new URL(extracted.canonical, next.url).toString().replace(/\/$/, "") : null;

            const linkHints = sameDomainLinks(new URL(next.url), extracted.links);
            const pageRecord: ScrapedPage = {
              url: next.url,
              canonicalUrl,
              title: extracted.title,
              metaDescription: extracted.metaDescription,
              cleanedText,
              html: extracted.html.slice(0, options.maxHtmlChars),
              jsonLd: extracted.jsonLd.filter(Boolean),
              links: linkHints,
              linkHints,
              structuredBlocks: (extracted.structuredBlocks as ScrapedStructuredBlock[]).slice(0, 80),
              jsonLdSummary: summarizeJsonLd(extracted.jsonLd.filter(Boolean)),
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
                if (!visited.has(link.href) && queue.length + pages.length < options.maxPages * 3) {
                  queue.push({ url: link.href, depth: next.depth + 1, hint: [link.text, link.ariaLabel, link.title].filter(Boolean).join(" ") });
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

export async function crawlLeadWebsite(rootInput: string): Promise<CrawlResult> {
  const rootUrl = normalizeWebsiteUrl(rootInput);
  const options = getCrawlOptions();

  try {
    return await crawlLeadWebsiteWithPlaywright(rootUrl, options);
  } catch (error) {
    const mappedError = mapPlaywrightLaunchError(error);
    if (
      mappedError.message.includes("Playwright Chromium is not installed") ||
      mappedError.message.includes("Playwright Chromium cannot start") ||
      mappedError.message.includes("Playwright Chromium is missing Linux shared libraries")
    ) {
      logWarn("lead_scraper.playwright_unavailable", {
        rootUrl,
        error: mappedError.message,
      });
      return crawlLeadWebsiteWithFetch(rootUrl, options);
    }
    throw mappedError;
  }
}
