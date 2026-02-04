// utils/ethiotelecomReceipt.js
"use strict";

const puppeteer = require("puppeteer");
const cheerio = require("cheerio");

// Browser instance (reused for performance)
let browserInstance = null;

// SSRF protection
const ALLOWED_HOSTS = new Set(["transactioninfo.ethiotelecom.et"]);
const RECEIPT_URL_TEMPLATE =
  process.env.RECEIPT_URL_TEMPLATE ||
  "https://transactioninfo.ethiotelecom.et/receipt/{tx}";

// Error codes for frontend
const ERROR_CODES = {
  TX_FORMAT: "Invalid transaction code format. Must be 10 alphanumeric characters.",
  INVALID_URL: "Invalid URL format provided.",
  HOST_NOT_ALLOWED: "The provided URL host is not allowed.",
  INVALID_PROTOCOL: "Only HTTP and HTTPS protocols are allowed.",
  BROWSER_LAUNCH_FAILED: "Failed to launch browser. Please try again.",
  PAGE_LOAD_FAILED: "Failed to load the receipt page.",
  PAGE_TIMEOUT: "Page load timed out. The server might be slow.",
  EMPTY_HTML: "Received empty or invalid HTML response.",
  TX_NOT_FOUND: "Transaction not found. Please check the transaction code.",
  PARSE_FAIL: "Failed to parse receipt data. Required fields are missing.",
  NAVIGATION_ERROR: "Navigation error occurred while loading the page.",
  UNKNOWN_ERROR: "An unexpected error occurred.",
};

/**
 * Get or create browser instance
 */
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  try {
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
      ],
      timeout: 30000,
    });

    // Handle browser disconnection
    browserInstance.on("disconnected", () => {
      browserInstance = null;
    });

    return browserInstance;
  } catch (error) {
    const err = new Error(ERROR_CODES.BROWSER_LAUNCH_FAILED);
    err.code = "BROWSER_LAUNCH_FAILED";
    err.originalError = error.message;
    throw err;
  }
}

/**
 * Close browser instance
 */
async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      console.error("Error closing browser:", e.message);
    }
    browserInstance = null;
  }
}

/**
 * Build receipt URL from transaction code
 */
function buildReceiptUrlFromTx(tx) {
  return RECEIPT_URL_TEMPLATE.replace("{tx}", encodeURIComponent(tx));
}

/**
 * Extract transaction code from URL
 */
function extractTxFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    
    // Expected format: /receipt/{tx}
    if (pathParts.length >= 2 && pathParts[0] === "receipt") {
      return pathParts[1];
    }
    
    // Try query parameter
    const txParam = urlObj.searchParams.get("tx") || urlObj.searchParams.get("id");
    if (txParam) return txParam;
    
    // Return last path segment as fallback
    return pathParts[pathParts.length - 1] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Validate URL and check allowed hosts
 */
function assertAllowedHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    const err = new Error(ERROR_CODES.INVALID_URL);
    err.code = "INVALID_URL";
    throw err;
  }

  if (!["http:", "https:"].includes(u.protocol)) {
    const err = new Error(ERROR_CODES.INVALID_PROTOCOL);
    err.code = "INVALID_PROTOCOL";
    throw err;
  }

  if (!ALLOWED_HOSTS.has(u.hostname)) {
    const err = new Error(ERROR_CODES.HOST_NOT_ALLOWED);
    err.code = "HOST_NOT_ALLOWED";
    err.details = `Host "${u.hostname}" is not in the allowed list.`;
    throw err;
  }
}

/**
 * Clean text by removing extra whitespace and special characters
 */
function cleanText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[:：]+$/, "")
    .trim();
}

/**
 * Normalize key for comparison
 */
function normalizeKey(s) {
  return cleanText(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Parse Ethiopian name into parts
 */
function parseEthiopianName(fullName) {
  const cleaned = cleanText(fullName);
  if (!cleaned) return null;
  
  const parts = cleaned.split(" ").filter(Boolean);
  const [first, father, grandfather, ...rest] = parts;
  
  return {
    full: parts.join(" "),
    first: first || null,
    father: father || null,
    grandfather: grandfather || null,
    rest: rest.length ? rest.join(" ") : null,
  };
}

/**
 * Check if value is PDF download junk
 */
function isPdfJunkValue(v) {
  const t = normalizeKey(v);
  return (
    t === "download the pdf" ||
    t === "download pdf" ||
    (t.includes("download") && t.includes("pdf"))
  );
}

/**
 * Check if key-value pair should be filtered out
 */
function isJunkPair(key, value) {
  if (!key || !value) return true;
  if (isPdfJunkValue(value)) return true;
  if (normalizeKey(key) === normalizeKey(value)) return true;
  return false;
}

/**
 * Extract value using regex
 */
function extractByRegex(text, re) {
  const m = String(text || "").match(re);
  return m ? cleanText(m[1]) : null;
}

/**
 * Get cell text without links
 */
function cellTextNoLinks($cell) {
  const clone = $cell.clone();
  clone.find("a,button,svg,script,style").remove();
  const t = cleanText(clone.text());
  return isPdfJunkValue(t) ? "" : t;
}

/**
 * Extract raw key-value pairs from HTML
 */
function extractReceiptRawPairs(html) {
  const $ = cheerio.load(html);
  const raw = {};

  $("table tr").each((_, row) => {
    const cells = $(row).find("th, td");
    if (cells.length < 2) return;

    const arr = [];
    cells.each((__, c) => arr.push(cellTextNoLinks($(c))));

    for (let i = 0; i < arr.length - 1; i += 2) {
      const k = arr[i];
      const v = arr[i + 1];
      if (!k || !v) continue;
      if (!raw[k]) raw[k] = v;
    }
  });

  return raw;
}

/**
 * Clean raw pairs by removing junk
 */
function cleanRawPairs(rawPairs) {
  const out = {};
  for (const [k, v] of Object.entries(rawPairs || {})) {
    if (isJunkPair(k, v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Pick first matching key from raw pairs
 */
function pickExact(raw, keys) {
  for (const k of keys) if (raw[k]) return raw[k];
  return null;
}

/**
 * Extract canonical data from HTML
 */
function extractCanonical(html, tx) {
  const $ = cheerio.load(html);
  const rawPairs = extractReceiptRawPairs(html);
  const raw = cleanRawPairs(rawPairs);

  const bodyText = cleanText($("body").text()).replace(/download the pdf/gi, "");

  const payerNameStr = pickExact(raw, ["የከፋይ ስም/Payer Name", "Payer Name"]);
  const creditedNameStr = pickExact(raw, [
    "የገንዘብ ተቀባይ ስም/Credited Party name",
    "የገንዘብ ተቀባይ ስም/Credited party name",
    "Credited Party name",
  ]);

  const canonical = {
    payerName: payerNameStr ? cleanText(payerNameStr) : null,
    payerNameParts: parseEthiopianName(payerNameStr),

    payerTelebirrNo: pickExact(raw, [
      "የከፋይ ቴሌብር ቁ./Payer telebirr no.",
      "Payer telebirr no.",
    ]),

    creditedPartyName: creditedNameStr ? cleanText(creditedNameStr) : null,
    creditedPartyNameParts: parseEthiopianName(creditedNameStr),

    creditedPartyAccountNo: pickExact(raw, [
      "የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no",
      "Credited party account no",
    ]),

    transactionStatus: pickExact(raw, [
      "የክፍያው ሁኔታ/transaction status",
      "Transaction status",
    ]),

    invoiceNo:
      extractByRegex(bodyText, /\bInvoice No\.\s*([A-Z0-9]{6,})\b/i) || tx,

    paymentDate:
      extractByRegex(
        bodyText,
        /\bPayment date\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\b/i
      ) || null,

    settledAmount:
      extractByRegex(
        bodyText,
        /\bSettled Amount\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*Birr\b/i
      ) || null,

    rawData: raw,
  };

  return canonical;
}

/**
 * Fetch receipt using Puppeteer
 */
async function fetchReceiptWithPuppeteer(url, timeoutMs = 30000) {
  const browser = await getBrowser();
  let page = null;

  try {
    page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set extra headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    // Enable request interception for better error handling
    await page.setRequestInterception(true);
    
    let requestError = null;
    
    page.on("request", (request) => {
      request.continue();
    });

    page.on("requestfailed", (request) => {
      requestError = request.failure()?.errorText || "Request failed";
    });

    // Navigate to URL
    const response = await page.goto(url, {
      waitUntil: ["networkidle2", "domcontentloaded"],
      timeout: timeoutMs,
    });

    if (!response) {
      const err = new Error(ERROR_CODES.PAGE_LOAD_FAILED);
      err.code = "PAGE_LOAD_FAILED";
      if (requestError) err.details = requestError;
      throw err;
    }

    const status = response.status();
    if (status >= 400) {
      const err = new Error(`HTTP Error: ${status}`);
      err.code = "HTTP_ERROR";
      err.status = status;
      throw err;
    }

    // Wait for content to load
    await page.waitForSelector("body", { timeout: 5000 });

    // Get page content
    const html = await page.content();

    // Take screenshot for debugging (optional)
    // const screenshot = await page.screenshot({ encoding: 'base64' });

    return {
      html,
      status,
      url: page.url(),
    };
  } catch (error) {
    if (error.name === "TimeoutError") {
      const err = new Error(ERROR_CODES.PAGE_TIMEOUT);
      err.code = "PAGE_TIMEOUT";
      err.originalError = error.message;
      throw err;
    }
    
    if (error.code) throw error;

    const err = new Error(ERROR_CODES.NAVIGATION_ERROR);
    err.code = "NAVIGATION_ERROR";
    err.originalError = error.message;
    throw err;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.error("Error closing page:", e.message);
      }
    }
  }
}

/**
 * Get receipt canonical data from transaction code
 */
async function getReceiptCanonical(tx) {
  // Validate transaction code format
  if (!/^[A-Za-z0-9]{10}$/.test(tx)) {
    const err = new Error(ERROR_CODES.TX_FORMAT);
    err.code = "TX_FORMAT";
    throw err;
  }

  const receiptUrl = buildReceiptUrlFromTx(tx);
  assertAllowedHost(receiptUrl);

  const timeoutMs = Number(process.env.RECEIPT_FETCH_TIMEOUT_MS || 30000);

  const { html, url: finalUrl } = await fetchReceiptWithPuppeteer(
    receiptUrl,
    timeoutMs
  );

  if (!html || html.length < 200) {
    const err = new Error(ERROR_CODES.EMPTY_HTML);
    err.code = "EMPTY_HTML";
    throw err;
  }

  const $ = cheerio.load(html);
  const bodyText = cleanText($("body").text());

  // Check for error messages
  if (/no\s+data|not\s+found|invalid\s+invoice|does\s+not\s+exist/i.test(bodyText)) {
    const err = new Error(ERROR_CODES.TX_NOT_FOUND);
    err.code = "TX_NOT_FOUND";
    throw err;
  }

  const canonical = extractCanonical(html, tx);

  // Require critical fields
  if (
    !canonical.invoiceNo ||
    !canonical.settledAmount ||
    !canonical.creditedPartyAccountNo
  ) {
    const err = new Error(ERROR_CODES.PARSE_FAIL);
    err.code = "PARSE_FAIL";
    err.details = {
      hasInvoiceNo: !!canonical.invoiceNo,
      hasSettledAmount: !!canonical.settledAmount,
      hasCreditedPartyAccountNo: !!canonical.creditedPartyAccountNo,
    };
    throw err;
  }

  canonical.sourceUrl = finalUrl;
  return canonical;
}

/**
 * Get receipt from full URL
 */
async function getReceiptFromUrl(url) {
  // Validate URL
  assertAllowedHost(url);

  // Extract transaction code
  const tx = extractTxFromUrl(url);
  if (!tx) {
    const err = new Error("Could not extract transaction code from URL");
    err.code = "TX_EXTRACT_FAILED";
    throw err;
  }

  // Validate transaction code
  if (!/^[A-Za-z0-9]{10}$/.test(tx)) {
    const err = new Error(ERROR_CODES.TX_FORMAT);
    err.code = "TX_FORMAT";
    err.details = `Extracted code: "${tx}"`;
    throw err;
  }

  return getReceiptCanonical(tx);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing browser...");
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Closing browser...");
  await closeBrowser();
  process.exit(0);
});

module.exports = {
  getReceiptCanonical,
  getReceiptFromUrl,
  closeBrowser,
  ERROR_CODES,
};