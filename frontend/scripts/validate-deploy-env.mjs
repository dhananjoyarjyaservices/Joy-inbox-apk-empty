const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_API_BASE_URL",
];

const missing = required.filter((name) => {
  const value = process.env[name]?.trim();
  return !value || /^YOUR_/i.test(value);
});

if (missing.length) {
  console.error("Cloudflare deployment blocked: missing or placeholder runtime configuration:");
  for (const name of missing) console.error(`- ${name}`);
  console.error("Set these as GitHub Actions repository variables before deploying the preview.");
  process.exit(1);
}

const apiBaseUrl = process.env.VITE_API_BASE_URL.trim();
let parsed;
try {
  parsed = new URL(apiBaseUrl);
} catch {
  console.error("VITE_API_BASE_URL must be a valid absolute HTTPS URL.");
  process.exit(1);
}

if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
  console.error("VITE_API_BASE_URL must use HTTPS and must not contain credentials, a query string, or a fragment.");
  process.exit(1);
}

console.log("Required Firebase and AWS API deployment configuration is present.");
