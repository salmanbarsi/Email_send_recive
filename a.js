// mailserver.js
const express = require("express");
const multer = require("multer");
const nodemailer = require("nodemailer");
const cors = require("cors");
const readXlsxFile = require("read-excel-file/node");
const dotenv = require("dotenv");
const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const client = neon(process.env.DATABASE_URL);

app.use(express.json());
app.use(cors());

// ------------------ UPLOAD FOLDER ------------------
const upload = multer({ dest: "uploads/" });
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

// ------------------ DATABASE ------------------
(async () => {
  try {
    await client`
      CREATE TABLE IF NOT EXISTS sent_emails (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        subject TEXT,
        message TEXT,
        filename TEXT,
        sent_at TIMESTAMP DEFAULT NOW()
      )`;

    await client`
      CREATE TABLE IF NOT EXISTS received_emails (
      id TEXT PRIMARY KEY, 
      from_email TEXT,
      to_email TEXT,
      subject TEXT,
      date TIMESTAMP
    )`;

    console.log("✅ Tables ready");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  }
})();

// ------------------ GOOGLE OAUTH2 ------------------
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  console.log("✅ Using refresh token from .env");
}

// ------------------ SMTP TRANSPORTER ------------------
function createTransporterSMTP() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ------------------ SEND SINGLE EMAIL ------------------
app.post("/api/send-emails", upload.single("attachment"), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    const file = req.file;

    const transporter = createTransporterSMTP();
    const attachments = file ? [{ filename: file.originalname, path: file.path }] : [];

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject,
      text: message,
      attachments,
    });

    await client`
      INSERT INTO sent_emails (name, email, subject, message, filename)
      VALUES (${name}, ${email}, ${subject}, ${message}, ${file ? file.originalname : null})
    `;

    res.status(200).json({ message: "✅ Email sent successfully!" });
  } 
  catch (err) {
    console.error("❌ Error sending email:", err);
    res.status(500).json({ message: "Failed to send email" });
  }
});

// ------------------ GET SENT EMAILS ------------------
app.get("/api/sent-emails", async (req, res) => {
  try {
    const emails = await client`SELECT * FROM sent_emails ORDER BY sent_at DESC`;
    res.json(emails);
  } catch (err) {
    console.error("❌ Error fetching sent emails:", err);
    res.status(500).json({ message: "Failed to fetch emails" });
  }
});

// ------------------ BULK EMAIL IMPORT ------------------
app.post("/api/import-emails", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const { subject: commonSubject, message: commonMessage } = req.body;
    if (!commonSubject || !commonMessage)
      return res.status(400).json({ message: "Subject and message are required" });

    const rows = await readXlsxFile(req.file.path);

    // Detect header
    const headerRow = rows[0].map((c) => c.toString().toLowerCase());
    const dataRows = headerRow.includes("email") ? rows.slice(1) : rows;

    const transporter = createTransporterSMTP();
    const failedEmails = [];

    for (const row of dataRows) {
      let name = null,
        email = null,
        subject = commonSubject,
        message = commonMessage;

      if (row.length === 1) email = row[0];
      else if (row.length === 2) {
        name = row[0];
        email = row[1];
      } 
      else if (row.length >= 4) {
        name = row[0];
        email = row[1];
        subject = row[2] || commonSubject;
        message = row[3] || commonMessage;
      }

      if (!email) continue;

      try {
        await transporter.sendMail({ from: process.env.SMTP_USER, to: email, subject, text: message });
        await client`
          INSERT INTO sent_emails (name, email, subject, message, filename)
          VALUES (${name}, ${email}, ${subject}, ${message}, ${req.file.originalname})
        `;
      } 
      catch (err) {
        console.error(`❌ Failed to send to ${email}:`, err.message);
        failedEmails.push(email);
      }
    }

    res.json({
      message: "✅ Bulk emails processed",
      failedEmails,
    });
  } catch (err) {
    console.error("❌ Bulk import error:", err);
    res.status(500).json({ message: "Failed to send bulk emails" });
  }
});

// ------------------ READ RECEIVED EMAILS ------------------
app.get("/read-mails", async (req, res) => {
  try {
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    const listRes = await gmail.users.messages.list({ userId: "me", maxResults: 10, labelIds: ["INBOX"], });
    if (!listRes.data.messages) return res.json([]);

    const newMessages = [];

    for (const msg of listRes.data.messages) {
      const exists = await client`SELECT 1 FROM received_emails WHERE id = ${msg.id}`;
      if (exists.length) continue; // skip if already stored

      const msgRes = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = msgRes.data.payload.headers;
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      const dateStr = headers.find((h) => h.name === "Date")?.value || "";
      const date = dateStr ? new Date(dateStr) : new Date();

      await client`
        INSERT INTO received_emails (id, from_email, to_email, subject, date)
        VALUES (${msg.id}, ${from}, ${process.env.SMTP_USER}, ${subject}, ${date})
      `;

      newMessages.push({ id: msg.id, from_email: from, to_email: process.env.SMTP_USER, subject, date });
    }

    // Only return the new messages
    console.log(newMessages)
    res.json(newMessages);
  } 
  catch (err) {
    console.error("❌ Error reading mails:", err);
    res.status(500).send("Failed to read mails");
  }
});

// ------------------ GET RECEIVED EMAILS ------------------
app.get("/api/received-emails", async (req, res) => {
  try {
    const emails1 = await client`SELECT * FROM received_emails ORDER BY date DESC`;
    res.json(emails1);
  } catch (err) {
    console.error("❌ Error fetching received emails:", err);
    res.status(500).json({ message: "Failed to fetch emails" });
  }
});


// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
