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
    await client` CREATE TABLE IF NOT EXISTS sent_emails ( id SERIAL PRIMARY KEY, name TEXT, email TEXT, subject TEXT, message TEXT, filename TEXT, sent_at TIMESTAMP DEFAULT NOW())`;
    await client` CREATE TABLE IF NOT EXISTS received_emails ( id SERIAL PRIMARY KEY, from_email TEXT, to_email TEXT, subject TEXT, date TIMESTAMP)`;
    console.log("✅ Tables ready");
  } 
  catch (err) {
    console.error("❌ Error creating tables:", err);
  }
})();

// ------------------ GOOGLE OAUTH2 (RECEIVING) ------------------
const TOKEN_PATH = path.join(__dirname, "token.json");
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

if (fs.existsSync(TOKEN_PATH)) {
  const tokenData = fs.readFileSync(TOKEN_PATH, "utf8");
  if (tokenData) {
    oAuth2Client.setCredentials(JSON.parse(tokenData));
    console.log("✅ Loaded existing OAuth token");
  }
}

// ------------------ SMTP TRANSPORTER (SENDING) ------------------
function createTransporterSMTP() {
  return nodemailer.createTransport({
    service: "gmail", auth: { user: process.env.SMTP_USER,  pass: process.env.SMTP_PASS,},
  });
}

// ------------------ SEND SINGLE EMAIL ------------------
app.post("/api/send-email", upload.single("attachment"), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    const file = req.file;

    const transporter = createTransporterSMTP();
    const attachments = file ? [{ filename: file.originalname, path: file.path }] : [];

    await transporter.sendMail({
      from: process.env.SMTP_USER, to: email, subject, text: message, attachments,
    });

    await client`INSERT INTO sent_emails (name, email, subject, message, filename) VALUES (${name}, ${email}, ${subject}, ${message}, ${file ? file.originalname : null})`;

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
  } 
  catch (err) {
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
    const dataRows = rows[0][0].toString().toLowerCase().includes("email") ? rows.slice(1) : rows;

    const transporter = createTransporterSMTP();

    for (const row of dataRows) {
      let name = null,
        email = null,
        subject = commonSubject,
        message = commonMessage;

      if (row.length === 1){
        email = row[0];
      } 
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
        await client` INSERT INTO sent_emails (name, email, subject, message, filename) VALUES (${name}, ${email}, ${subject}, ${message}, ${req.file.originalname})`;
      } 
      catch (err) {
        console.error(`❌ Failed to send to ${email}:`, err.message);
      }
    }

    res.json({ message: "✅ Bulk emails sent successfully!" });
  } 
  catch (err) {
    console.error("❌ Bulk import error:", err);
    res.status(500).json({ message: "Failed to send bulk emails" });
  }
});

// ------------------ READ RECEIVED EMAILS ------------------
app.get("/read-mails", async (req, res) => {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return res.status(401).send("No token found. Authenticate via /auth-url first.");
    const tokenData = fs.readFileSync(TOKEN_PATH, "utf8");
    oAuth2Client.setCredentials(JSON.parse(tokenData));

    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    const listRes = await gmail.users.messages.list({ userId: "me", maxResults: 10 });
    if (!listRes.data.messages) return res.json({ messages: [] });

    const messages = [];
    for (const msg of listRes.data.messages) {
      const msgRes = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = msgRes.data.payload.headers;
      const subject = headers.find((h) => h.name === "Subject")?.value || null;
      const from = headers.find((h) => h.name === "From")?.value || null;
      const dateStr = headers.find((h) => h.name === "Date")?.value || null;
      const date = dateStr ? new Date(dateStr) : null;

      messages.push({ id: msg.id, subject, from, date });

      await client`
        INSERT INTO received_emails (from_email, to_email, subject, date) VALUES (${from}, ${process.env.SMTP_USER}, ${subject}, ${date})
      `;
    }

    res.redirect("/api/received-emails")
  } catch (err) {
    console.error("❌ Error reading mails:", err);
    res.status(500).send("Failed to read mails");
  }
});

// ------------------ OAUTH FLOW ------------------
app.get("/auth-url", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    prompt: "consent",
  });


  res.json({ url: authUrl });
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code found in query.");

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send("✅ Auth successful! Token saved. You can now send emails and read mails.");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error exchanging code for token");
  }
});

app.get("/api/received-emails", async (req, res) => {
  try {
    const emails = await client`SELECT * FROM received_emails ORDER BY date DESC`;
    res.json(emails);
  } 
  catch (err) {
    console.error("❌ Error fetching sent emails:", err);
    res.status(500).json({ message: "Failed to fetch emails" });
  }
});

oAuth2Client.on("tokens", (tokens) => {
  if (tokens.refresh_token || tokens.access_token) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({
      ...oAuth2Client.credentials,
      ...tokens,
    }));
    console.log("🔄 Token updated in token.json");
  }
});


// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
