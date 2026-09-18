// Probe: cek apakah Shopee mau ngasih harga produk ke Cloudflare Worker.
// Deploy sebagai Worker baru, lalu buka:
//   https://<worker-url>/?u=<link produk shopee>
// Tujuannya cuma diagnosa: berhasil dapat harga, atau diblok anti-bot.

export default {
  async fetch(request) {
    const u = new URL(request.url).searchParams.get("u");
    if (!u) return text("Shopee price probe.\nPakai: /?u=<link produk shopee>");
    try {
      return text(await probe(u));
    } catch (e) {
      return text("ERROR: " + (e && e.message ? e.message : e));
    }
  },
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Shopee menyimpan harga dalam satuan mikro (dibagi 100.000 -> Rupiah).
const PRICE_DIVISOR = 100000;

// Batas waktu tiap request keluar biar Worker nggak nggantung.
const FETCH_TIMEOUT_MS = 10000;

function text(s) {
  return new Response(s, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// fetch dengan timeout, supaya request yang macet tetap gagal dengan rapi.
async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// Validasi & normalisasi input jadi URL http(s) yang wajar.
function normalizeUrl(raw) {
  const s = String(raw).trim();
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!/shopee\./i.test(parsed.hostname)) return null; // batasi ke domain Shopee
  return parsed.toString();
}

// Ambil shopid & itemid dari berbagai bentuk URL Shopee.
function extractIds(s) {
  let m = s.match(/-i\.(\d+)\.(\d+)/); // .../nama-produk-i.<shopid>.<itemid>
  if (m) return { shopid: m[1], itemid: m[2] };
  m = s.match(/\/product\/(\d+)\/(\d+)/); // .../product/<shopid>/<itemid>
  if (m) return { shopid: m[1], itemid: m[2] };
  return null;
}

async function probe(rawLink) {
  const link = normalizeUrl(rawLink);
  if (!link) return `LINK : ${rawLink}\n\nURL tidak valid atau bukan domain Shopee.`;

  // Ikuti redirect dulu (buat short link s.shopee.co.id / share link).
  let finalUrl = link;
  try {
    const r0 = await fetchWithTimeout(link, { headers: { "User-Agent": UA }, redirect: "follow" });
    finalUrl = r0.url || link;
    await r0.text().catch(() => "");
  } catch {
    /* lanjut pakai link asli */
  }

  const ids = extractIds(finalUrl) || extractIds(link);
  if (!ids) return `LINK : ${link}\nFINAL: ${finalUrl}\n\nGAGAL ambil shopid/itemid dari URL.`;

  const { shopid, itemid } = ids;
  const api = `https://shopee.co.id/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetchWithTimeout(api, {
    headers: {
      "User-Agent": UA,
      "Referer": finalUrl,
      "Accept": "application/json",
      "x-api-source": "pc",
      "x-shopee-language": "id",
    },
  });
  const body = await r.text();

  let parsed = "(gagal parse)";
  try {
    const j = JSON.parse(body);
    const d = j.data;
    if (d) {
      parsed = formatItem(d);
    } else {
      parsed = `error=${j.error}  msg=${j.error_msg || ""}`;
    }
  } catch {
    parsed = "(body bukan JSON — kemungkinan diblok/anti-bot)";
  }

  return (
    `LINK : ${link}\nFINAL: ${finalUrl}\n` +
    `shopid=${shopid} itemid=${itemid}\nAPI  : ${api}\n` +
    `HTTP ${r.status}  ct=${r.headers.get("content-type")}  len=${body.length}\n\n` +
    `${parsed}\n\n--- BODY (0..700) ---\n${body.slice(0, 700)}`
  );
}

// Rangkai info produk, termasuk varian (models) kalau ada.
function formatItem(d) {
  const lines = [
    `name      = ${d.name}`,
    `price     = ${fmtRp(micro(d.price))}`,
    `price_min = ${fmtRp(micro(d.price_min))}`,
    `price_max = ${fmtRp(micro(d.price_max))}`,
    `stock     = ${d.stock}`,
  ];

  if (Array.isArray(d.models) && d.models.length) {
    lines.push(`\n--- VARIAN (${d.models.length}) ---`);
    for (const mdl of d.models) {
      lines.push(`- ${mdl.name}: ${fmtRp(micro(mdl.price))}  (stok ${mdl.stock})`);
    }
  }

  return lines.join("\n");
}

// Ubah harga satuan mikro Shopee -> Rupiah; null/undefined tetap null.
function micro(v) {
  return v == null ? null : v / PRICE_DIVISOR;
}

function fmtRp(n) {
  if (n == null || !isFinite(n)) return "?";
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}
