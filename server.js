// server.js
"use strict";

const express = require("express");
const path = require("path");
const {
  getReceiptCanonical,
  getReceiptFromUrl,
  closeBrowser,
  ERROR_CODES,
} = require("./utils/ethiotelecomReceipt");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/**
 * Get HTTP status code for error
 */
function getStatusCodeForError(code) {
  const map = {
    TX_FORMAT: 400,
    INVALID_URL: 400,
    HOST_NOT_ALLOWED: 403,
    INVALID_PROTOCOL: 400,
    TX_NOT_FOUND: 404,
    MISSING_INPUT: 400,
    TX_EXTRACT_FAILED: 400,
    HTTP_ERROR: 502,
    PAGE_TIMEOUT: 504,
    BROWSER_LAUNCH_FAILED: 503,
    PAGE_LOAD_FAILED: 502,
    NAVIGATION_ERROR: 502,
    EMPTY_HTML: 502,
    PARSE_FAIL: 422,
  };
  return map[code] || 500;
}

/**
 * API: Check receipt by URL or transaction code
 */
app.post("/api/check-receipt", async (req, res) => {
  const startTime = Date.now();
  const { url, transactionCode } = req.body;

  console.log("Request body:", { url, transactionCode });

  try {
    if (!url && !transactionCode) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_INPUT",
          message: "Please provide a URL or transaction code.",
        },
      });
    }

    let result;

    if (transactionCode) {
      console.log(`Processing transaction code: ${transactionCode}`);
      result = await getReceiptCanonical(transactionCode.trim());
    } else {
      console.log(`Processing URL: ${url}`);
      result = await getReceiptFromUrl(url.trim());
    }

    const processingTime = Date.now() - startTime;
    console.log(`Success! Processing time: ${processingTime}ms`);

    res.json({
      success: true,
      data: result,
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`Error: ${error.code || "UNKNOWN"} - ${error.message}`);
    if (error.stack) console.error("Stack:", error.stack);

    const errorResponse = {
      success: false,
      error: {
        code: error.code || "UNKNOWN_ERROR",
        message: ERROR_CODES[error.code] || error.message || "An unexpected error occurred",
        details: error.details || null,
        originalError: error.originalError || null,
      },
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
      },
    };

    const statusCode = getStatusCodeForError(error.code);
    res.status(statusCode).json(errorResponse);
  }
});

/**
 * API: Check receipt by transaction code (GET)
 */
app.get("/api/receipt/:txCode", async (req, res) => {
  const startTime = Date.now();
  const { txCode } = req.params;

  try {
    console.log(`Processing transaction code: ${txCode}`);
    const result = await getReceiptCanonical(txCode.trim());

    res.json({
      success: true,
      data: result,
      meta: {
        processingTime: `${Date.now() - startTime}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`Error: ${error.code || "UNKNOWN"} - ${error.message}`);

    res.status(getStatusCodeForError(error.code)).json({
      success: false,
      error: {
        code: error.code || "UNKNOWN_ERROR",
        message: ERROR_CODES[error.code] || error.message,
        details: error.details || null,
        originalError: error.originalError || null,
      },
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * API: Health check
 */
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

/**
 * API: Get all error codes
 */
app.get("/api/error-codes", (req, res) => {
  res.json({
    success: true,
    data: ERROR_CODES,
  });
});

/**
 * Serve frontend
 */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    },
  });
});

/**
 * Global error handler
 */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "An internal server error occurred.",
    },
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Ethio Telecom Receipt Verification Server             ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                  ║
║  Environment: ${(process.env.NODE_ENV || "development").padEnd(42)}║
║                                                           ║
║  API Endpoints:                                           ║
║    POST /api/check-receipt - Check by URL or code         ║
║    GET  /api/receipt/:txCode - Get receipt by code        ║
║    GET  /api/health - Health check                        ║
║    GET  /api/error-codes - List all error codes           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  server.close(async () => {
    console.log("HTTP server closed.");
    await closeBrowser();
    console.log("Browser closed.");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));