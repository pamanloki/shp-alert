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
      return text("ERROR: " + (e.message || e));
    }
  },
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function text(s) {
  return new Response(s, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// Ambil shopid & itemid dari berbagai bentuk URL Shopee.
function extractIds(s) {
  let m = s.match(/-i\.(\d+)\.(\d+)/);     // .../nama-produk-i.<shopid>.<itemid>
  if (m) return { shopid: m[1], itemid: m[2] };
  m = s.match(/\/product\/(\d+)\/(\d+)/);   // .../product/<shopid>/<itemid>
  if (m) return { shopid: m[1], itemid: m[2] };
  return null;
}

async function probe(link) {
  // Ikuti redirect dulu (buat short link s.shopee.co.id / share link).
  let finalUrl = link;
  try {
    const r0 = await fetch(link, { headers: { "User-Agent": UA }, redirect: "follow" });
    finalUrl = r0.url || link;
    await r0.text().catch(() => "");
  } catch (e) { /* lanjut pakai link asli */ }

  const ids = extractIds(finalUrl) || extractIds(link);
  if (!ids) return `LINK : ${link}\nFINAL: ${finalUrl}\n\nGAGAL ambil shopid/itemid dari URL.`;

  const { shopid, itemid } = ids;
  const api = `https://shopee.co.id/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetch(api, {
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
      const D = 100000; // harga Shopee dalam satuan mikro
      parsed =
        `name      = ${d.name}\n` +
        `price     = ${fmtRp(d.price / D)}\n` +
        `price_min = ${fmtRp(d.price_min / D)}\n` +
        `price_max = ${fmtRp(d.price_max / D)}\n` +
        `stock     = ${d.stock}`;
    } else {
      parsed = `error=${j.error}  msg=${j.error_msg || ""}`;
    }
  } catch { parsed = "(body bukan JSON — kemungkinan diblok/anti-bot)"; }

  return (
    `LINK : ${link}\nFINAL: ${finalUrl}\n` +
    `shopid=${shopid} itemid=${itemid}\nAPI  : ${api}\n` +
    `HTTP ${r.status}  ct=${r.headers.get("content-type")}  len=${body.length}\n\n` +
    `${parsed}\n\n--- BODY (0..700) ---\n${body.slice(0, 700)}`
  );
}

function fmtRp(n) {
  if (!isFinite(n)) return "?";
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}
