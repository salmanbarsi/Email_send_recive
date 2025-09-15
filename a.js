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
const { Console } = require("console");

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
      )
    `;

    await client`
      CREATE TABLE IF NOT EXISTS received_emails (
        id TEXT PRIMARY KEY,
        from_email TEXT,
        to_email TEXT,
        subject TEXT,
        date TIMESTAMP
      )
    `;

    await client`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        from_email TEXT,
        to_email TEXT,
        subject TEXT,
        date TIMESTAMP,
        snippet TEXT
      )
    `;

    await client`
      CREATE TABLE IF NOT EXISTS emails1 (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT,
        history_id TEXT,
        from_email TEXT,
        subject TEXT,
        received_at TIMESTAMP,
        snippet TEXT
      )
    `;

    await client`
      CREATE TABLE IF NOT EXISTS gmail_sync_state (
        id SERIAL PRIMARY KEY,
        history_id BIGINT UNIQUE
      )
    `;

    console.log("✅ Tables ready");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  }
})();

// ------------------ GOOGLE OAUTH2 ------------------
function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (process.env.GOOGLE_REFRESH_TOKEN) {
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return auth;
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
    const attachments = file
      ? [{ filename: file.originalname, path: file.path }]
      : [];

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
  } catch (err) {
    console.error("❌ Error sending email:", err);
    res.status(500).json({ message: "Failed to send email" });
  }
});

// ------------------ GET SENT EMAILS ------------------
app.get("/api/sent-emails", async (req, res) => {
  try {
    const emails = await client`
      SELECT * FROM sent_emails ORDER BY sent_at DESC
    `;
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
      return res
        .status(400)
        .json({ message: "Subject and message are required" });

    const rows = await readXlsxFile(req.file.path);
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
      } else if (row.length >= 4) {
        name = row[0];
        email = row[1];
        subject = row[2] || commonSubject;
        message = row[3] || commonMessage;
      }

      if (!email) continue;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: email,
          subject,
          text: message,
        });
        await client`
          INSERT INTO sent_emails (name, email, subject, message, filename)
          VALUES (${name}, ${email}, ${subject}, ${message}, ${req.file.originalname})
        `;
      } catch (err) {
        console.error(`❌ Failed to send to ${email}:`, err.message || err);
        failedEmails.push(email);
      }
    }

    res.json({ message: "✅ Bulk emails processed", failedEmails });
  } catch (err) {
    console.error("❌ Bulk import error:", err);
    res.status(500).json({ message: "Failed to send bulk emails" });
  }
});

// ------------------ PAGINATION FOR ALL EMAILS ------------------
app.get("/api/received-all-emails", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const rows = await client`
      SELECT * FROM emails ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}
    `;
    const count = await client`SELECT COUNT(*) FROM emails`;
    const total = parseInt(count[0].count);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      emails: rows,
    });
  } catch (err) {
    console.error("❌ Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

//---------------fetchLastMonthEmails-------------
async function fetchLastMonthEmails() {
  const gmail = google.gmail({ version: "v1", auth: getAuth() });
  const query = "newer_than:30d";

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 100,
    q: query,
  });

  const messages = listRes.data.messages || [];
  const emails = [];

  // If messages empty, return empty array
  for (const msg of messages) {
    const email = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = email.data.payload?.headers || [];
    emails.push({
      id: msg.id,
      threadId: msg.threadId,
      historyId: email.data.historyId || null,
      from: headers.find((h) => h.name === "From")?.value || null,
      subject: headers.find((h) => h.name === "Subject")?.value || null,
      date: headers.find((h) => h.name === "Date")?.value || null,
      snippet: email.data.snippet || null,
    });
  }

  return { emails };
}

//---------------fetchNewEmails-------------
async function fetchNewEmails(startHistoryId) {
  const gmail = google.gmail({ version: "v1", auth: getAuth() });

  if (!startHistoryId) return { newMessages: [] };

  const historyRes = await gmail.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
    maxResults: 100,
  });

  const history = historyRes.data.history || [];
  const newMessages = [];

  for (const h of history) {
    if (!h.messagesAdded) continue;
    for (const m of h.messagesAdded) {
      try {
        const email = await gmail.users.messages.get({
          userId: "me",
          id: m.message.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = email.data.payload?.headers || [];
        newMessages.push({
          id: m.message.id,
          threadId: m.message.threadId,
          historyId: email.data.historyId || null,
          from: headers.find((h) => h.name === "From")?.value || null,
          subject: headers.find((h) => h.name === "Subject")?.value || null,
          date: headers.find((h) => h.name === "Date")?.value || null,
          snippet: email.data.snippet || null,
        });
      } catch (err) {
        console.warn("⚠️ Skipping message fetch error:", err.message || err);
      }
    }
  }

  return { newMessages };
}

// fetchdata will fetch last 30 days emails and save them into emails1 table
async function fetchdata() {
  try {
    // get current lastHistoryId in DB (if any)
    const last = await client`SELECT history_id FROM emails1 ORDER BY history_id DESC LIMIT 1`;
    const lastHistoryId = last[0]?.history_id || null;

    const { emails } = await fetchLastMonthEmails();

    for (const emailObj of emails) {
      const parsedDate = emailObj.date ? new Date(emailObj.date) : new Date();
      await client`
        INSERT INTO emails1 (message_id, thread_id, history_id, from_email, subject, received_at, snippet)
        VALUES (${emailObj.id}, ${emailObj.threadId}, ${emailObj.historyId}, ${emailObj.from}, ${emailObj.subject}, ${parsedDate.toISOString()}, ${emailObj.snippet})
        ON CONFLICT (message_id) DO NOTHING
      `;
    }

    // After seeding emails1, fetch new emails (if any) since lastHistoryId
    const { newMessages } = await fetchNewEmails(lastHistoryId);
    // insert new messages into emails1 as well
    for (const nm of newMessages) {
      const parsedDate = nm.date ? new Date(nm.date) : new Date();
      await client`
        INSERT INTO emails1 (message_id, thread_id, history_id, from_email, subject, received_at, snippet)
        VALUES (${nm.id}, ${nm.threadId}, ${nm.historyId}, ${nm.from}, ${nm.subject}, ${parsedDate.toISOString()}, ${nm.snippet})
        ON CONFLICT (message_id) DO NOTHING
      `;
    }

    return { seeded: emails.length, added: newMessages.length };
  } catch (err) {
    console.error("❌ Error in fetchdata:", err);
    throw err;
  }
}

app.get("/read-mails", async (req, res) => {
  try {
    // get last stored history_id (if any)
    const lastSync = await client`
      SELECT history_id FROM gmail_sync_state ORDER BY history_id DESC LIMIT 1
    `;
    const lastHistoryId = lastSync[0]?.history_id || null;

    if (!lastHistoryId) {
      // first run: fetch last 30 days
      const result = await fetchdata();

      // also store the latest historyId from emails1
      const latest = await client`
        SELECT history_id FROM emails1 ORDER BY history_id::bigint DESC LIMIT 1
      `;
      if (latest[0]?.history_id) {
        await client`
          INSERT INTO gmail_sync_state (history_id) VALUES(${latest[0].history_id})
          ON CONFLICT (history_id) DO NOTHING
        `;
      }

      return res.json({
        message: "✅ Seeded last 30 days of emails",
        result,
      });
    } else {
      // fetch only new messages since lastHistoryId
      const { newMessages } = await fetchNewEmails(lastHistoryId);

      for (const emailObj of newMessages) {
        const parsedDate = emailObj.date ? new Date(emailObj.date) : new Date();

        // Only proceed if email is received (From is NOT our email)
        if (emailObj.from && !emailObj.from.includes(process.env.SMTP_USER)) {
          await client`
            INSERT INTO emails (id, from_email, to_email, subject, date, snippet)
            VALUES (
              ${emailObj.id},
              ${emailObj.from},
              ${process.env.SMTP_USER},
              ${emailObj.subject},
              ${parsedDate.toISOString()},
              ${emailObj.snippet}
            )
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }


      // update sync state to the newest historyId returned by Gmail
      if (newMessages.length > 0) {
        const newest = newMessages[newMessages.length - 1].historyId;
        if (newest) {
          await client`
            INSERT INTO gmail_sync_state (history_id) VALUES(${newest})
            ON CONFLICT (history_id) DO NOTHING
          `;
        }
      }

      return res.json({
        message: "✅ Fetched new messages",
        added: newMessages.filter(
          (emailObj) => emailObj.from && !emailObj.from.includes(process.env.SMTP_USER)
        ).length,
        newMessages: newMessages.filter(
          (emailObj) => emailObj.from && !emailObj.from.includes(process.env.SMTP_USER)
        ),
      });
    }
  } catch (err) {
    console.error("❌ Error in /read-mails:", err);
    res.status(500).json({ error: "Failed to fetch and save emails" });
  }
});



// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
