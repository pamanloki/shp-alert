// Shopee price bot untuk Cloudflare Worker.
//
// Dua fungsi:
//  1) Probe/diagnosa:  GET  https://<worker-url>/?u=<link produk shopee>
//  2) Bot Telegram:    POST dari webhook Telegram (kirim link Shopee ke bot -> dibalas harga)
//
// Secrets yang perlu diset (wrangler secret put / dashboard):
//  - BOT_TOKEN            : token dari @BotFather
//  - TELEGRAM_SECRET      : token rahasia webhook (opsional tapi disarankan)
//  - ALLOWED_IDS          : daftar ID user/chat yang boleh pakai, dipisah koma
//                           (opsional; kosong = terbuka untuk semua)

export default {
  async fetch(request, env) {
    // Webhook Telegram datang sebagai POST.
    if (request.method === "POST") {
      return handleTelegram(request, env);
    }

    const u = new URL(request.url).searchParams.get("u");
    if (!u) {
      return text("Shopee price bot.\nProbe: /?u=<link produk shopee>\nTelegram: kirim link Shopee ke bot.");
    }
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

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

async function handleTelegram(request, env) {
  // Verifikasi bahwa request memang dari Telegram (kalau TELEGRAM_SECRET diset).
  if (env.TELEGRAM_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== env.TELEGRAM_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update.message || update.edited_message;
  const chatId = msg && msg.chat && msg.chat.id;
  const fromId = msg && msg.from && msg.from.id;
  const textIn = (msg && msg.text) || "";

  // Selalu balas 200 ke Telegram supaya update tidak dikirim ulang terus-menerus.
  if (!chatId) return new Response("ok");

  // Batasi ke pengguna tertentu kalau ALLOWED_IDS diset (mis. "12345,67890").
  // Kalau kosong/tak diset, bot terbuka untuk semua.
  if (!isAllowed(env, fromId, chatId)) {
    await sendMessage(env, chatId, "Maaf, bot ini privat.");
    return new Response("ok");
  }

  try {
    const reply = await buildReply(textIn);
    await sendMessage(env, chatId, reply);
  } catch (e) {
    await sendMessage(env, chatId, "Maaf, terjadi error: " + (e && e.message ? e.message : e));
  }
  return new Response("ok");
}

// Cek apakah pengirim diizinkan. ALLOWED_IDS = daftar ID dipisah koma.
function isAllowed(env, fromId, chatId) {
  const raw = (env.ALLOWED_IDS || "").trim();
  if (!raw) return true; // tidak diset -> terbuka untuk semua
  const allow = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes(String(fromId)) || allow.includes(String(chatId));
}

// Susun balasan bot dari teks pesan masuk.
async function buildReply(textIn) {
  const t = textIn.trim();
  if (t === "/start" || t === "/help") {
    return "Halo! Kirim link produk Shopee, nanti aku balas harga terkininya.";
  }

  const link = extractShopeeLink(t);
  if (!link) return "Kirim link produk Shopee ya (mis. https://shopee.co.id/...-i.123.456).";

  const info = await lookupPrice(link);
  return formatTelegram(info);
}

// Ambil URL Shopee pertama dari teks bebas.
function extractShopeeLink(s) {
  const m = s.match(/https?:\/\/[^\s]*shopee\.[^\s]+/i);
  return m ? m[0] : null;
}

// Ambil harga produk; kembalikan objek terstruktur (bukan dump debug).
async function lookupPrice(rawLink) {
  const link = normalizeUrl(rawLink);
  if (!link) return { ok: false, message: "URL tidak valid atau bukan domain Shopee." };

  let finalUrl = link;
  try {
    const r0 = await fetchWithTimeout(link, { headers: { "User-Agent": UA }, redirect: "follow" });
    finalUrl = r0.url || link;
    await r0.text().catch(() => "");
  } catch {
    /* lanjut pakai link asli */
  }

  const ids = extractIds(finalUrl) || extractIds(link);
  if (!ids) return { ok: false, message: "Gagal mengambil shopid/itemid dari URL." };

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

  let j;
  try {
    j = JSON.parse(await r.text());
  } catch {
    return { ok: false, message: "Shopee tidak mengembalikan JSON (kemungkinan diblok anti-bot)." };
  }

  if (!j.data) return { ok: false, message: `Shopee error: ${j.error} ${j.error_msg || ""}`.trim() };
  return { ok: true, data: j.data };
}

// Format balasan bot untuk data produk.
function formatTelegram(info) {
  if (!info.ok) return info.message;
  const d = info.data;

  const lines = [`🛒 ${d.name}`];
  const min = micro(d.price_min);
  const max = micro(d.price_max);
  if (min != null && max != null && min !== max) {
    lines.push(`Harga : ${fmtRp(min)} – ${fmtRp(max)}`);
  } else {
    lines.push(`Harga : ${fmtRp(micro(d.price))}`);
  }
  lines.push(`Stok  : ${d.stock}`);

  if (Array.isArray(d.models) && d.models.length) {
    lines.push(`\nVarian:`);
    for (const mdl of d.models) {
      lines.push(`• ${mdl.name}: ${fmtRp(micro(mdl.price))} (stok ${mdl.stock})`);
    }
  }
  return lines.join("\n");
}

// Kirim pesan balik ke Telegram.
async function sendMessage(env, chatId, text) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}
