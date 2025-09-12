const { google } = require("googleapis");
const fs = require("fs");
require("dotenv").config();

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "urn:ietf:wg:oauth:2.0:oob" // Desktop redirect
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  prompt: "consent",
});

console.log("Visit this URL, authorize, and paste the code here:");
console.log(authUrl);

const readline = require("readline").createInterface({
  input: process.stdin,
  output: process.stdout,
});

readline.question("Enter code: ", async (code) => {
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(".token.json", JSON.stringify(tokens, null, 2));
  console.log("✅ Saved new refresh token:", tokens.refresh_token);
  readline.close();
});
