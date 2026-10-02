"use strict";

/**
 * Link preview tests.
 *
 * Two halves:
 *  - SSRF guards, which are the security-critical part. The server fetches
 *    URLs chosen by users, so anything that could reach the host's own
 *    network must be refused.
 *  - Metadata extraction, using a real local HTTP server on 127.0.0.1 that
 *    serves og: tags. That is safe precisely because localhost is blocked for
 *    real requests; here we exercise the parser directly.
 */

const assert = require("assert");
const http = require("http");
const {
  getLinkPreview,
  findFirstUrl,
  isBlockedAddress,
  extractPreview,
} = require("../BACKEND/linkPreview");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rejects(fn, label) {
  return fn().then(
    () => {
      throw new Error(`${label} should have been refused`);
    },
    () => true
  );
}

// ---- private / reserved addresses must never be reachable ----------------
const BLOCKED = [
  "127.0.0.1", "127.10.20.30", "10.0.0.5", "192.168.1.1", "172.16.9.9",
  "172.31.255.255", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
  "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3",
];
for (const address of BLOCKED) {
  assert.strictEqual(isBlockedAddress(address), true, `${address} must be blocked`);
}

// ---- public addresses are allowed ---------------------------------------
const ALLOWED = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700::1111"];
for (const address of ALLOWED) {
  assert.strictEqual(isBlockedAddress(address), false, `${address} must be allowed`);
}

(async () => {
  // ---- scheme and credential rules ------------------------------------
  assert.strictEqual(await getLinkPreview("file:///etc/passwd"), null, "file: URLs are refused");
  assert.strictEqual(await getLinkPreview("gopher://example.com"), null, "gopher: URLs are refused");
  assert.strictEqual(await getLinkPreview("javascript:alert(1)"), null, "javascript: URLs are refused");
  assert.strictEqual(await getLinkPreview("not-a-url"), null, "Non-URLs are refused");
  assert.strictEqual(await getLinkPreview(""), null, "Empty input is refused");

  // ---- the host's own network is unreachable --------------------------
  assert.strictEqual(await getLinkPreview("http://127.0.0.1:9/"), null, "Loopback is refused");
  assert.strictEqual(
    await getLinkPreview("http://169.254.169.254/latest/meta-data/"),
    null,
    "The cloud metadata endpoint is refused"
  );
  assert.strictEqual(
    await getLinkPreview("http://10.0.0.5/admin"),
    null,
    "Private network addresses are refused"
  );

  // ---- credentials in the URL are refused ------------------------------
  assert.strictEqual(
    await getLinkPreview("http://user:pass@example.com/"),
    null,
    "URLs carrying credentials are refused"
  );

  // ---- unreachable pages return null rather than throwing ---------------
  assert.strictEqual(
    await getLinkPreview("http://127.0.0.1:1/definitely-not-there"),
    null,
    "An unreachable page yields no preview rather than throwing"
  );

  // ---- metadata extraction ---------------------------------------------
  const page = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="A great article">
    <meta property="og:description" content="Everything you need to know.">
    <meta property="og:site_name" content="Example News">
    <meta property="og:image" content="/cover.png">
  </head><body>hello</body></html>`;
  const preview = extractPreview(page, 'https://example.com/post');
  assert.strictEqual(preview.title, 'A great article', 'og:title is used');
  assert.strictEqual(preview.description, 'Everything you need to know.', 'og:description is used');
  assert.strictEqual(preview.siteName, 'Example News', 'og:site_name is used');
  assert.strictEqual(preview.image, 'https://example.com/cover.png', 'Relative og:image is resolved');
  assert.strictEqual(preview.url, 'https://example.com/post', 'The final URL is reported');

  // Falls back to <title> when there are no og: tags.
  const plain = extractPreview('<html><head><title>Just a title</title></head></html>', 'https://example.com/');
  assert.strictEqual(plain.title, 'Just a title', 'The <title> tag is the fallback');

  // Twitter card tags are understood too.
  const twitter = extractPreview(
    '<meta name="twitter:title" content="Tweet title"><meta name="twitter:image" content="https://cdn.example.com/i.png">',
    'https://example.com/t'
  );
  assert.strictEqual(twitter.title, 'Tweet title', 'twitter:title is used');
  assert.strictEqual(twitter.image, 'https://cdn.example.com/i.png', 'twitter:image is used');

  // HTML entities in metadata must be decoded.
  const entities = extractPreview('<meta property="og:title" content="Tom &amp; Jerry">', 'https://example.com/');
  assert.strictEqual(entities.title, 'Tom & Jerry', 'Entities are decoded');

  // ---- findFirstUrl ---------------------------------------------------
  assert.strictEqual(
    findFirstUrl('look at https://example.com/a?b=1 now'),
    'https://example.com/a?b=1',
    'The first link in a message is found'
  );
  assert.strictEqual(findFirstUrl('no links here'), null, 'A message without links returns null');
  assert.strictEqual(findFirstUrl(''), null, 'Empty text returns null');

  console.log('Link preview tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});