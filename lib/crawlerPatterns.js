/**
 * Common automation / bot User-Agent tokens (substring or anchored tests).
 *
 * Categories covered (non-exhaustive):
 * - Search, index, ads, and SEO crawlers (Google, Bing, Ahrefs, …)
 * - Social / link preview bots
 * - AI / dataset crawlers (GPTBot, CCBot, …)
 * - Headless Chromium / Edge and classic headless stacks (PhantomJS, HtmlUnit, …)
 * - Driver / test stacks (WebDriver, Selenium, Puppeteer, Playwright)
 * - Scripted HTTP clients (curl, wget, Go-http-client, python-requests, …)
 * - Uptime / synthetic monitoring agents
 *
 * Omitted on purpose (high false-positive risk in normal traffic):
 * - `okhttp/` — often appears in legitimate Android in-app WebViews
 * - bare `Java/` — too many non-bot HTTP stacks
 */

/** @type {Array<[RegExp, string]>} — first match wins */
export const CRAWLER_DEFS = [
  /* Search & major crawlers */
  [/\bAdsBot-Google\b/i, "AdsBot-Google"],
  [/\bMediapartners-Google\b/i, "Mediapartners-Google"],
  [/\bGooglebot\b/i, "Googlebot"],
  [/\bBingbot\b/i, "Bingbot"],
  [/\bDuckDuckBot\b/i, "DuckDuckBot"],
  [/\bYandexBot\b/i, "YandexBot"],
  [/\bBaiduspider\b/i, "BaiduSpider"],
  [/\bApplebot\b/i, "Applebot"],
  [/\bAmazonbot\b/i, "Amazonbot"],

  /* Social & preview */
  [/facebookexternalhit/i, "FacebookExternalHit"],
  [/linkedinbot/i, "LinkedInBot"],
  [/slackbot/i, "Slackbot"],
  [/twitterbot/i, "Twitterbot"],
  [/embedly/i, "Embedly"],
  [/telegrambot/i, "TelegramBot"],

  /* SEO / marketing crawlers */
  [/bytespider/i, "ByteSpider"],
  [/petalbot/i, "PetalBot"],
  [/ahrefsbot/i, "AhrefsBot"],
  [/semrushbot/i, "SemrushBot"],
  [/dotbot/i, "DotBot"],
  [/mj12bot/i, "MJ12bot"],
  [/crawler4ai/i, "Crawler4AI"],

  /* AI / research / dataset crawlers */
  [/GPTBot/i, "GPTBot"],
  [/ChatGPT-User/i, "ChatGPT-User"],
  [/OAI-SearchBot/i, "OAI-SearchBot"],
  [/PerplexityBot/i, "PerplexityBot"],
  [/Claude-Web/i, "Claude-Web"],
  [/ClaudeBot/i, "ClaudeBot"],
  [/anthropic-ai/i, "anthropic-ai"],
  [/Google-Extended/i, "Google-Extended"],
  [/CCBot/i, "CCBot"],
  [/omgili/i, "omgili"],

  /* Headless browsers & legacy automation runtimes */
  [/HeadlessChrome\//i, "HeadlessChrome"],
  [/HeadlessEdg\//i, "HeadlessEdge"],
  [/PhantomJS/i, "PhantomJS"],
  [/SlimerJS/i, "SlimerJS"],
  [/HtmlUnit/i, "HtmlUnit"],
  [/CasperJS/i, "CasperJS"],
  [/\bNightmare\//i, "Nightmare"],

  /* Drivers & modern test stacks */
  [/\bWebDriver\b/i, "WebDriver"],
  [/Puppeteer/i, "Puppeteer"],
  [/Playwright/i, "Playwright"],
  [/selenium/i, "Selenium"],

  /* Scripted HTTP / API clients */
  [/^curl\//i, "curl"],
  [/^Wget\//i, "Wget"],
  [/^wget\//i, "wget"],
  [/^Go-http-client\//i, "Go-http-client"],
  [/libwww-perl/i, "libwww-perl"],
  [/python-requests\//i, "python-requests"],
  [/^Python-urllib\//i, "Python-urllib"],
  [/Scrapy\//i, "Scrapy"],
  [/Apache-HttpClient/i, "Apache-HttpClient"],
  [/PostmanRuntime/i, "PostmanRuntime"],
  [/Insomnia\//i, "Insomnia"],
  [/^HTTPie\//i, "HTTPie"],
  [/aiohttp\//i, "aiohttp"],
  [/node-fetch\//i, "node-fetch"],

  /* Synthetic monitoring */
  [/Site24x7/i, "Site24x7"],
  [/Pingdom/i, "Pingdom"],
  [/StatusCake/i, "StatusCake"],
  [/UptimeRobot/i, "UptimeRobot"],
  [/nagios/i, "Nagios"],
];

export function detectCrawlerLabeled(ua) {
  if (!ua || typeof ua !== "string") return { isCrawler: false, name: "NotCrawler" };
  const trimmed = ua.trim();
  for (const [re, name] of CRAWLER_DEFS) {
    if (re.test(trimmed)) return { isCrawler: true, name };
  }
  return { isCrawler: false, name: "NotCrawler" };
}
