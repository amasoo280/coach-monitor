const fetch = require("node-fetch");
const cheerio = require("cheerio");

// ─── Config (set via environment variables) ───────────────────────────────────
const PRODUCT_URL =
  process.env.PRODUCT_URL ||
  "https://www.coachoutlet.com/products/teri-shoulder-bag-in-signature-canvas-with-charms/CEA20-IMPO.html";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || "5", 10);
const TARGET_SIZES = (process.env.TARGET_SIZES || "").split(",").map((s) => s.trim()).filter(Boolean);
const TARGET_COLORS = (process.env.TARGET_COLORS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// ─────────────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;

// Track last known state so we only ping on *change* (OOS → in stock)
let lastStockState = null;
let checkCount = 0;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function fetchProductPage() {
  const res = await fetch(PRODUCT_URL, { headers: HEADERS, timeout: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

function parseStockInfo(html) {
  const $ = cheerio.load(html);

  // Coach Outlet product pages embed product data as JSON-LD or window.__INITIAL_STATE__
  // Try JSON-LD first (most reliable)
  let jsonLdData = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data["@type"] === "Product" || (Array.isArray(data) && data.some((d) => d["@type"] === "Product"))) {
        jsonLdData = Array.isArray(data) ? data.find((d) => d["@type"] === "Product") : data;
      }
    } catch (e) {}
  });

  // Try to extract from window.__STORE_STATE__ / next data
  let nextData = null;
  try {
    const nextScript = $('script#__NEXT_DATA__').html();
    if (nextScript) nextData = JSON.parse(nextScript);
  } catch (e) {}

  // Build result
  const result = {
    inStock: false,
    availableVariants: [],
    productName: null,
    price: null,
    imageUrl: null,
    source: "unknown",
  };

  // --- Parse from JSON-LD ---
  if (jsonLdData) {
    result.source = "json-ld";
    result.productName = jsonLdData.name || null;
    result.price = jsonLdData.offers?.price || jsonLdData.offers?.[0]?.price || null;
    result.imageUrl = Array.isArray(jsonLdData.image) ? jsonLdData.image[0] : jsonLdData.image || null;

    const offers = Array.isArray(jsonLdData.offers) ? jsonLdData.offers : jsonLdData.offers ? [jsonLdData.offers] : [];
    for (const offer of offers) {
      const avail = (offer.availability || "").toLowerCase();
      if (avail.includes("instock") || avail.includes("in_stock") || avail.includes("limitedavailability")) {
        result.inStock = true;
        const variant = {
          color: offer.color || null,
          size: offer.size || null,
          price: offer.price || null,
          availability: offer.availability,
          sku: offer.sku || null,
        };
        result.availableVariants.push(variant);
      }
    }
  }

  // --- Parse from Next.js data if JSON-LD didn't give us what we need ---
  if (!result.productName && nextData) {
    try {
      result.source = "next-data";
      const pageProps = nextData?.props?.pageProps;
      const product = pageProps?.product || pageProps?.initialData?.product;
      if (product) {
        result.productName = product.name || product.displayName || null;
        result.price = product.price?.sale || product.price?.regular || null;
        result.imageUrl = product.images?.[0]?.url || null;

        const variants = product.variants || product.skus || [];
        for (const v of variants) {
          const avail = (v.availability || v.stockStatus || "").toLowerCase();
          if (
            avail.includes("instock") ||
            avail.includes("in_stock") ||
            avail === "available" ||
            v.inStock === true ||
            v.availableForSale === true
          ) {
            result.inStock = true;
            result.availableVariants.push({
              color: v.color?.name || v.colorName || null,
              size: v.size?.value || v.sizeName || null,
              price: v.price?.sale || null,
              sku: v.sku || v.id || null,
            });
          }
        }
      }
    } catch (e) {}
  }

  // --- HTML fallback: look for "add to bag" button ---
  if (!result.inStock && result.source === "unknown") {
    result.source = "html-fallback";
    const bodyText = $("body").text().toLowerCase();
    const addToBagVisible =
      $('button:contains("Add to Bag")').length > 0 ||
      $('button:contains("Add to Cart")').length > 0 ||
      bodyText.includes("add to bag");
    const outOfStock =
      bodyText.includes("out of stock") ||
      bodyText.includes("sold out") ||
      bodyText.includes("currently unavailable");

    result.inStock = addToBagVisible && !outOfStock;
    result.productName = $("h1").first().text().trim() || null;
  }

  // Filter by target sizes/colors if configured
  if (result.inStock && (TARGET_SIZES.length > 0 || TARGET_COLORS.length > 0)) {
    const matchingVariants = result.availableVariants.filter((v) => {
      const sizeMatch =
        TARGET_SIZES.length === 0 ||
        TARGET_SIZES.some((ts) => (v.size || "").toLowerCase().includes(ts.toLowerCase()));
      const colorMatch =
        TARGET_COLORS.length === 0 ||
        TARGET_COLORS.some((tc) => (v.color || "").toLowerCase().includes(tc));
      return sizeMatch && colorMatch;
    });

    if (result.availableVariants.length > 0) {
      // If we have variant data, only count as in-stock if target variant is available
      result.inStock = matchingVariants.length > 0;
      result.availableVariants = matchingVariants;
    }
    // If no variant data (html-fallback), trust the page-level inStock
  }

  return result;
}

async function sendDiscordAlert(stockInfo) {
  if (!DISCORD_WEBHOOK_URL) {
    log("⚠️  No DISCORD_WEBHOOK_URL set — skipping notification.");
    return;
  }

  const variantLines = stockInfo.availableVariants.slice(0, 10).map((v) => {
    const parts = [];
    if (v.color) parts.push(v.color);
    if (v.size) parts.push(`Size: ${v.size}`);
    if (v.price) parts.push(`$${v.price}`);
    return "• " + (parts.join(" | ") || "Variant available");
  });

  const embed = {
    title: `🛍️ RESTOCK ALERT — ${stockInfo.productName || "Coach Outlet Item"}`,
    url: PRODUCT_URL,
    color: 0x2ecc71,
    description:
      variantLines.length > 0
        ? `**Available variants:**\n${variantLines.join("\n")}`
        : "Item appears to be back in stock! Check the page.",
    fields: [
      {
        name: "Product URL",
        value: `[View Product](${PRODUCT_URL})`,
        inline: false,
      },
      ...(stockInfo.price
        ? [{ name: "Price", value: `$${stockInfo.price}`, inline: true }]
        : []),
      {
        name: "Checked at",
        value: new Date().toLocaleString("en-US", { timeZone: "America/Detroit" }),
        inline: true,
      },
    ],
    thumbnail: stockInfo.imageUrl ? { url: stockInfo.imageUrl } : undefined,
    footer: { text: "Coach Outlet Restock Monitor" },
  };

  const payload = {
    username: "Restock Bot",
    avatar_url: "https://www.coachoutlet.com/favicon.ico",
    embeds: [embed],
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} — ${txt}`);
  }

  log("✅ Discord alert sent!");
}

async function sendDiscordHeartbeat() {
  if (!DISCORD_WEBHOOK_URL) return;
  const payload = {
    username: "Restock Bot",
    content: `🔄 Monitor is running — checking every ${CHECK_INTERVAL_MINUTES} min\n**Product:** ${PRODUCT_URL}`,
  };
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function check() {
  checkCount++;
  log(`Check #${checkCount} — fetching product page...`);

  try {
    const html = await fetchProductPage();
    const stockInfo = parseStockInfo(html);

    log(
      `Result: inStock=${stockInfo.inStock}, variants=${stockInfo.availableVariants.length}, source=${stockInfo.source}, product="${stockInfo.productName}"`
    );

    if (stockInfo.availableVariants.length > 0) {
      log(`Available: ${stockInfo.availableVariants.map((v) => [v.color, v.size].filter(Boolean).join("/")).join(", ")}`);
    }

    // Only alert on transition from out-of-stock → in-stock
    if (stockInfo.inStock && lastStockState === false) {
      log("🚨 RESTOCK DETECTED — sending Discord alert!");
      await sendDiscordAlert(stockInfo);
    } else if (stockInfo.inStock && lastStockState === null) {
      log("📦 Item appears in stock on first check.");
      await sendDiscordAlert(stockInfo);
    } else if (!stockInfo.inStock) {
      log("❌ Out of stock — monitoring...");
    } else {
      log("✓ Still in stock (no change, no new alert)");
    }

    lastStockState = stockInfo.inStock;
  } catch (err) {
    log(`❌ Error during check: ${err.message}`);
  }
}

async function main() {
  log("=== Coach Outlet Restock Monitor starting ===");
  log(`URL: ${PRODUCT_URL}`);
  log(`Interval: ${CHECK_INTERVAL_MINUTES} minutes`);
  log(`Target sizes: ${TARGET_SIZES.length > 0 ? TARGET_SIZES.join(", ") : "any"}`);
  log(`Target colors: ${TARGET_COLORS.length > 0 ? TARGET_COLORS.join(", ") : "any"}`);
  log(`Discord webhook: ${DISCORD_WEBHOOK_URL ? "configured" : "NOT SET"}`);
  log("=============================================");

  await sendDiscordHeartbeat();
  await check();
  setInterval(check, CHECK_INTERVAL_MS);
}

main();
