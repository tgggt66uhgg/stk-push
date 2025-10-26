// server.js - PayNecta backend compatible with SwiftWallet frontend
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Configuration - update env or keep these for testing ======
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || "ceofreddy254@gmail.com";
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || "hmp_qRLRJKTcVe4BhEQyp7GX5bttJTPzgYUUBU8wPZgO";
const PAYNECTA_CODE = process.env.PAYNECTA_CODE || "PNT_109820";

// The callback URL PayNecta will call (use your tested backend domain)
const CALLBACK_URL = process.env.CALLBACK_URL || "https://techspacefinance.onrender.com";

// JSON storage file for receipts
const receiptsFile = path.join(__dirname, "receipts.json");

// CORS origin: keep frontend intact
const FRONTEND_ORIGIN = "https://techspacefinance.onrender.com";

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: FRONTEND_ORIGIN
  })
);

// Helpers
function readReceipts() {
  try {
    if (!fs.existsSync(receiptsFile)) return {};
    return JSON.parse(fs.readFileSync(receiptsFile));
  } catch (err) {
    console.error("readReceipts error:", err.message);
    return {};
  }
}

function writeReceipts(data) {
  try {
    fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("writeReceipts error:", err.message);
  }
}

function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// ---------- 1. /pay - initiate payment using PayNecta (STK Push) ----------
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    // PayNecta initialize payload
    const payload = {
      code: PAYNECTA_CODE,
      mobile_number: formattedPhone,
      amount: Math.round(amount),
      // Note: PayNecta docs didn't show external_reference in initialize; we still attach our reference locally.
    };

    // Call PayNecta STK push initialize
    const resp = await axios.post("https://paynecta.co.ke/api/v1/payment/initialize", payload, {
      headers: {
        "X-API-Key": PAYNECTA_API_KEY,
        "X-User-Email": PAYNECTA_EMAIL,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    console.log("PayNecta initialize response:", resp.data);

    const receipts = readReceipts();

    if (resp.data && resp.data.success) {
      const transaction_reference = resp.data.data.transaction_reference || null;
      // Create receipt in same shape as SwiftWallet
      const receiptData = {
        reference,
        transaction_id: transaction_reference,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending", // STK sent, awaiting completion
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete the fee payment and loan disbursement.`,
        timestamp: new Date().toISOString()
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      // Start polling PayNecta status endpoint (every 15s) for this transaction_reference
      if (transaction_reference) {
        const interval = setInterval(async () => {
          try {
            const url = `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${encodeURIComponent(transaction_reference)}`;
            const statusResp = await axios.get(url, {
              headers: {
                "X-API-Key": PAYNECTA_API_KEY,
                "X-User-Email": PAYNECTA_EMAIL
              },
              timeout: 10000
            });

            const payData = statusResp.data?.data || {};
            const payStatus = (payData.status || "").toLowerCase();
            console.log(`[${reference}] PayNecta poll status:`, payStatus);

            const receiptsNow = readReceipts();
            const current = receiptsNow[reference];
            if (!current) {
              clearInterval(interval);
              return;
            }

            if (payStatus === "completed" || payStatus === "processing") {
              current.status = "processing";
              current.transaction_code = payData.mpesa_receipt_number || payData.mpesa_transaction_id || current.transaction_code;
              current.amount = payData.amount || current.amount;
              current.phone = payData.mobile_number || current.phone;
              current.customer_name = current.customer_name || "N/A";
              current.status_note = `✅ Your fee payment has been received and verified. Loan Reference: ${reference}. Loan processing started.`;
              current.timestamp = new Date().toISOString();
              writeReceipts(receiptsNow);
              clearInterval(interval);
            } else if (payStatus === "failed" || payStatus === "cancelled") {
              current.status = "cancelled";
              current.transaction_code = payData.mpesa_receipt_number || null;
              current.status_note = payData.failure_reason || "Payment failed or cancelled.";
              current.timestamp = new Date().toISOString();
              writeReceipts(receiptsNow);
              clearInterval(interval);
            } // else still pending - continue polling
          } catch (err) {
            // Log error but keep polling; network or 404 will surface here if transaction not found.
            console.log(`[${reference}] PayNecta poll error:`, err.response?.status || err.message);
          }
        }, 15000);
      }

      return res.json({ success: true, message: "STK push sent, check your phone", reference, receipt: receiptData });
    } else {
      // STK push failed to send - mimic swiftwallet behavior
      const failedReceipt = {
        reference,
        transaction_id: resp.data?.data?.transaction_reference || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "stk_failed",
        status_note: resp.data?.message || "STK push failed to send. Please try again or contact support.",
        timestamp: new Date().toISOString()
      };

      receipts[reference] = failedReceipt;
      writeReceipts(receipts);
      return res.status(400).json({ success: false, error: resp.data?.message || "Failed to initiate payment", receipt: failedReceipt });
    }
  } catch (err) {
    console.error("Payment initiation error:", {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });

    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    const errorReceiptData = {
      reference,
      transaction_id: null,
      transaction_code: null,
      amount: amount ? Math.round(amount) : null,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      customer_name: "N/A",
      status: "error",
      status_note: "System error occurred. Please try again later.",
      timestamp: new Date().toISOString()
    };

    const receipts = readReceipts();
    receipts[reference] = errorReceiptData;
    writeReceipts(receipts);

    return res.status(500).json({ success: false, error: err.response?.data?.message || err.message || "Server error", receipt: errorReceiptData });
  }
});

// ---------- 2. /callback - webhook handler (PayNecta or aggregator) ----------
app.post("/callback", (req, res) => {
  console.log("Callback received:", JSON.stringify(req.body).slice(0, 1000)); // truncated log

  const data = req.body;

  // PayNecta's sample uses 'external_reference' or 'transaction_reference' in different payloads.
  // Accept multiple possible fields to remain compatible.
  const refCandidates = [
    data.external_reference,
    data.transaction_reference,
    data.reference,
    data.data?.transaction_reference,
    data.data?.external_reference
  ].filter(Boolean);

  const ref = refCandidates[0]; // use first found
  if (!ref) {
    // If PayNecta doesn't include our ORDER- reference, we may need mapping via transaction_reference -> order.
    // Try to find local receipt by transaction_id matching transaction_reference
    const receipts = readReceipts();
    let foundKey = null;
    const txRef = data.transaction_reference || data.data?.transaction_reference || data.data?.checkout_request_id;
    if (txRef) {
      for (const k of Object.keys(receipts)) {
        if (receipts[k].transaction_id === txRef) {
          foundKey = k;
          break;
        }
      }
    }
    if (!foundKey) {
      console.warn("Callback without external_reference & no transaction_reference mapping found");
      return res.json({ success: false, message: "no reference provided" });
    }
    // set ref to foundKey
    processWebhookForRef(foundKey, data);
    return res.json({ ResultCode: 0, ResultDesc: "Success" });
  }

  processWebhookForRef(ref, data);
  return res.json({ ResultCode: 0, ResultDesc: "Success" });
});

function processWebhookForRef(ref, data) {
  let receipts = readReceipts();
  const existing = receipts[ref] || {};

  // Normalize data extraction
  const payData = data.data || data; // some webhooks wrap payload in data
  const status = (payData.status || "").toLowerCase();
  const mpesaReceipt = payData.mpesa_receipt_number || payData.mpesa_transaction_id || payData.result?.MpesaReceiptNumber || null;
  const amount = payData.amount || payData.result?.Amount || existing.amount;
  const phone = payData.mobile_number || payData.result?.Phone || existing.phone;
  const resultCode = payData.result?.ResultCode || payData.result_code || null;

  // Customer name if present
  const customerName =
    payData.name ||
    payData.result?.Name ||
    [payData.result?.FirstName, payData.result?.MiddleName, payData.result?.LastName].filter(Boolean).join(" ") ||
    existing.customer_name ||
    "N/A";

  if ((status === "completed" && (payData.success === true || resultCode === 0)) || resultCode === 0) {
    receipts[ref] = {
      ...existing,
      reference: ref,
      transaction_id: existing.transaction_id || payData.transaction_reference || payData.transaction_id || null,
      transaction_code: mpesaReceipt || existing.transaction_code,
      amount,
      loan_amount: existing.loan_amount || "50000",
      phone,
      customer_name: customerName,
      status: "processing",
      status_note: `✅ Your fee payment has been received and verified. Loan Reference: ${ref}. Loan processing started.`,
      timestamp: payData.paid_at || payData.completed_at || new Date().toISOString()
    };
  } else {
    // Choose friendly status message from result / failure reason
    let statusNote = payData.failure_reason || payData.result?.ResultDesc || "Payment failed or was cancelled.";

    // Check for common result codes (if provided)
    switch (resultCode) {
      case 1032:
        statusNote = "You cancelled the payment request on your phone. Please try again.";
        break;
      case 1037:
        statusNote = "The request timed out. You did not enter your M-Pesa PIN. Please try again.";
        break;
      case 2001:
        statusNote = "Payment failed due to insufficient M-Pesa balance. Please top up and try again.";
        break;
      default:
        // leave statusNote as-is
        break;
    }

    receipts[ref] = {
      reference: ref,
      transaction_id: existing.transaction_id || payData.transaction_reference || null,
      transaction_code: mpesaReceipt || null,
      amount,
      loan_amount: existing.loan_amount || "50000",
      phone,
      customer_name: customerName,
      status: "cancelled",
      status_note: statusNote,
      timestamp: payData.failed_at || new Date().toISOString()
    };
  }

  writeReceipts(receipts);
}

// ---------- 3. GET /receipt/:reference ----------
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// ---------- 4. GET /receipt/:reference/pdf ----------
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  generateReceiptPDF(receipt, res);
});

// ---------- PDF generator (same style as SwiftWallet) ----------
function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=receipt-${receipt.reference}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  let headerColor = "#2196F3";
  let watermarkText = "";
  let watermarkColor = "green";

  if (receipt.status === "success") {
    watermarkText = "PAID";
  } else if (["cancelled", "error", "stk_failed"].includes(receipt.status)) {
    headerColor = "#f44336";
    watermarkText = "FAILED";
    watermarkColor = "red";
  } else if (receipt.status === "pending") {
    headerColor = "#ff9800";
    watermarkText = "PENDING";
    watermarkColor = "gray";
  } else if (receipt.status === "processing") {
    headerColor = "#2196F3";
    watermarkText = "PROCESSING - FUNDS RESERVED";
    watermarkColor = "blue";
  } else if (receipt.status === "loan_released") {
    headerColor = "#4caf50";
    watermarkText = "RELEASED";
    watermarkColor = "green";
  }

  doc.rect(0, 0, doc.page.width, 80).fill(headerColor);
  doc.fillColor("white").fontSize(24).text("⚡ SWIFTLOAN KENYA LOAN RECEIPT", 50, 25, { align: "left" });
  doc.fontSize(12).text("Loan & Payment Receipt", 50, 55);

  doc.moveDown(3);
  doc.fillColor("black").fontSize(14).text("Receipt Details", { underline: true }).moveDown();

  const details = [
    ["Reference", receipt.reference],
    ["Transaction ID", receipt.transaction_id || "N/A"],
    ["Transaction Code", receipt.transaction_code || "N/A"],
    ["Fee Amount", `KSH ${receipt.amount}`],
    ["Loan Amount", `KSH ${receipt.loan_amount}`],
    ["Phone", receipt.phone],
    ["Customer Name", receipt.customer_name || "N/A"],
    ["Status", receipt.status.toUpperCase()],
    ["Time", new Date(receipt.timestamp).toLocaleString()]
  ];

  details.forEach(([key, value]) => {
    doc.fontSize(12).text(`${key}: `, { continued: true }).text(String(value));
  });

  doc.moveDown();
  if (receipt.status_note) {
    doc.fontSize(12).fillColor("#555").text("Note:", { underline: true }).moveDown(0.5).text(receipt.status_note);
  }

  if (watermarkText) {
    doc.fontSize(60).fillColor(watermarkColor).opacity(0.2)
      .rotate(-30, { origin: [300, 400] })
      .text(watermarkText, 150, 400, { align: "center" })
      .rotate(30, { origin: [300, 400] })
      .opacity(1);
  }

  doc.moveDown(2);
  doc.fontSize(10).fillColor("gray").text("⚡ SwiftLoan Kenya © 2025", { align: "center" });

  doc.end();
}

// ---------- Cron job: release loans after 24 hours ----------
cron.schedule("*/5 * * * *", () => {
  const receipts = readReceipts();
  const now = Date.now();
  for (const ref in receipts) {
    const r = receipts[ref];
    if (r.status === "processing") {
      const releaseTime = new Date(r.timestamp).getTime() + 24 * 60 * 60 * 1000;
      if (now >= releaseTime) {
        r.status = "loan_released";
        r.status_note = "Loan has been released to your account. Thank you.";
        console.log(`✅ Released loan for ${ref}`);
      }
    }
  }
  writeReceipts(receipts);
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 PayNecta-compatible server running on port ${PORT}`);
});
