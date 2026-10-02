"use strict";

/**
 * Link unfurling.
 *
 * When someone posts a link we fetch the page server-side and read its
 * Open Graph / Twitter card metadata so the message can show a preview.
 * The browser cannot do this itself: sites do not send CORS headers.
 *
 * SECURITY: this fetches URLs chosen by users, so it is an SSRF surface.
 * Every defence below matters — do not loosen one without a replacement:
 *   - http/https only (no file:, gopher:, data:, ...)
 *   - no credentials in the URL
 *   - DNS is resolved and every address checked against private/loopback/
 *     link-local/reserved ranges, and re-checked on every redirect hop
 *   - hard timeout, response size cap, redirect cap
 *   - results cached, so a hot link cannot be used to hammer a target
 */

const dns = require("dns").promises;
const https = require("https");
const http = require("http");
const net = require("net");

const USER_AGENT = "Mozilla/5.0 (compatible; NeighborlyBot/1.0; +https://neighborly.gg)";
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // plenty for og: tags
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/** url -> { at, preview } */
const cache = new Map();

function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;       // this host, loopback, private
    if (a === 169 && b === 254) return true;                  // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;         // private
    if (a === 192 && b === 168) return true;                 // private
    if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
    if (a >= 224) return true;                                // multicast / reserved
    return false;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase().split("%")[0];
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
    // IPv4-mapped (::ffff:127.0.0.1) has to be judged as IPv4.
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true; // not an address form we understand -> refuse
}

async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That does not look like a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https links can be previewed.");
  }
  if (url.username || url.password) {
    throw new Error("Links with a username or password are not supported.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error("That address is not allowed.");
    return url;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("That host could not be reached.");
  }
  if (!records.length) throw new Error("That host could not be reached.");
  // Every resolved address must be public, otherwise a public name could
  // resolve to a private one.
  if (records.some((record) => isBlockedAddress(record.address))) {
    throw new Error("That address is not allowed.");
  }
  return url;
}

/** Reads at most MAX_BYTES from a response. */
function readBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        response.destroy();
        reject(new Error("That page was too large to preview."));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Extracts a <meta property|name="..." content="..."> value. */
function metaContent(html, keys) {
  for (const key of keys) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`,
      "i"
    );
    const tag = html.match(pattern)?.[0];
    if (!tag) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (content && content[1].trim()) return decodeEntities(content[1].trim());
  }
  return "";
}

/** Resolves a possibly-relative image/URL against the page it came from. */
function absolute(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

function extractPreview(html, finalUrl) {
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ||
    decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim());

  const description = metaContent(html, [
    "og:description",
    "twitter:description",
    "description",
  ]);

  const siteName = metaContent(html, ["og:site_name", "application-name"]);
  const imageRaw = metaContent(html, ["og:image", "twitter:image", "og:image:url"]);

  return {
    url: finalUrl,
    title: title.slice(0, 200),
    description: description.slice(0, 400),
    siteName: siteName.slice(0, 80),
    image: absolute(imageRaw, finalUrl),
  };
}

function fetchOnce(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      {
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en",
        },
        maxRedirects: 0, // handle each hop ourselves so it can be re-checked
      },
      (response) => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects."));
            return;
          }
          let next;
          try {
            next = new URL(response.headers.location, url);
          } catch {
            reject(new Error("That page redirected somewhere invalid."));
            return;
          }
          // Re-validate the target: this is the SSRF check that matters.
          assertSafeUrl(next.toString())
            .then(() => fetchOnce(next, redirectsLeft - 1))
            .then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`That page returned ${status}.`));
          return;
        }

        const contentType = String(response.headers["content-type"] || "");
        if (!/text\/html|application\/xhtml/i.test(contentType)) {
          response.resume();
          reject(new Error("That link is not a web page."));
          return;
        }

        readBody(response)
          .then((body) => resolve({ body, finalUrl: url.toString() }))
          .catch(reject);
      }
    );

    request.on("timeout", () => {
      request.destroy();
      reject(new Error("That page took too long to respond."));
    });
    request.on("error", reject);
  });
}

/**
 * Returns an embed for a link, or null if it cannot be previewed.
 * Never throws: an unfurlable link is not worth surfacing as an error.
 */
async function getLinkPreview(rawUrl) {
  const key = String(rawUrl || "").trim();
  if (!key) return null;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.preview;

  let preview = null;
  try {
    const url = await assertSafeUrl(key);
    const { body, finalUrl } = await fetchOnce(url, MAX_REDIRECTS);
    const extracted = extractPreview(body, finalUrl);
    // Only cache something worth showing.
    if (extracted.title || extracted.description || extracted.image) {
      preview = extracted;
      cache.set(key, { at: Date.now(), preview });
      if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    }
  } catch {
    preview = null;
  }
  return preview;
}

/** Pulls the first http(s) link out of a message body. */
function findFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}

module.exports = {
  getLinkPreview,
  findFirstUrl,
  isBlockedAddress,
  assertSafeUrl,
  extractPreview,
};