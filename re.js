require('dotenv').config();
const { Pool } = require('pg');
const imaps = require('imap-simple');

const PORT = process.env.PORT;
const DATABASE_URL = process.env.DATABASE_URL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// PostgreSQL Connection
const pool = new Pool({
  connectionString: DATABASE_URL,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('DB connection error', err);
  else console.log('DB connected at:', res.rows[0].now);
});

// Optional: Create table to save emails
const createTable = async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS emails ( id SERIAL PRIMARY KEY, from_email TEXT, to_email TEXT, subject TEXT, date TIMESTAMP)`;
  await pool.query(query);
};
createTable();

// Gmail IMAP Connection
const config = {
  imap: {
    user: SMTP_USER,
    password: SMTP_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    authTimeout: 3000,
    tlsOptions: { rejectUnauthorized: false } // allow self-signed certs
  },
  onError: err => console.log('IMAP Error:', err)
};

async function fetchEmails() {
  try {
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // Fetch all emails
    const searchCriteria = ['ALL']; // or ['UNSEEN'] for unread
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };

    const messages = await connection.search(searchCriteria, fetchOptions);

    console.log(`${messages.length} emails found.`);

    for (const item of messages) {
      const headers = item.parts[0].body;

      const from = headers.from ? headers.from[0] : null;
      const to = headers.to ? headers.to[0] : null;
      const subject = headers.subject ? headers.subject[0] : '';
      const date = headers.date ? new Date(headers.date[0]) : null;

      console.log({ from, to, subject, date });

      // Save to database
      await pool.query(
        'INSERT INTO emails (from_email, to_email, subject, date) VALUES ($1, $2, $3, $4)',
        [from, to, subject, date]
      );
    }

    connection.end();
    console.log('Done fetching emails.');
  } catch (err) {
    console.error('Error fetching emails:', err);
  }
}

fetchEmails();
