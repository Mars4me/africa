/**
 * Cloudflare Worker — проксі до Invidious.
 *
 * Навіщо: CORS — обмеження браузера, на сервері його немає. Worker ходить
 * до дзеркал сам і завжди віддає клієнту власні CORS-заголовки.
 *
 * Ендпоінт:  GET /search?q=ЗАПИТ&page=N
 * Відповідь: JSON-масив відео у форматі Invidious (той самий, що й раніше),
 *            тому клієнту не треба нічого знати про конкретні дзеркала.
 *
 * Задеплоєно: https://winter-star-48dc.sweaterbaddy.workers.dev
 */

// Перевірено 2026-07-20: валідні дані віддавало лише перше (і воно ж
// відповідає з IP Cloudflare — підтверджено заголовком X-Instance).
// Решта — 403/401/502 або анти-бот Anubis. Тримаємо їх у списку:
// вони регулярно оживають, а перебір коштує лише таймаут.
const INSTANCES = [
  "https://yt.chocolatemoo53.com",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.tiekoetter.com",
  "https://invidious.f5.si",
  "https://inv.zoomerville.com",
  "https://invidious.privacyredirect.com",
];

const UPSTREAM_TIMEOUT = 5000; // мс на одне дзеркало
const CACHE_TTL = 60;          // с, кеш однакових запитів
const MAX_PAGE = 20;
const MAX_Q = 200;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Живе доки живий isolate — щоб не перебирати список на кожен запит.
// ponytail: in-memory, не KV. Isolate'ів багато, але кожен швидко
// «прогрівається»; KV дав би спільний стан ціною зайвої залежності.
let lastGood = null;

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...(extra || {}) },
  });
}

/** Один запит до дзеркала з таймаутом. Повертає масив або null. */
async function tryInstance(base, path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);
  try {
    const res = await fetch(base + path, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (SmartTV) TVVideo/1.0" },
    });
    if (!res.ok) return null;
    // Anubis та інші заглушки віддають 200 + text/html — це не наші дані
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null; // таймаут / мережа / битий JSON — просто пробуємо наступне
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Дзеркала віддають прев'ю відносними шляхами ("/vi/ID/mqdefault.jpg").
 * Клієнт більше не знає, яке дзеркало відповіло, тому робимо URL
 * абсолютними тут.
 */
function normalize(videos, base) {
  for (const v of videos) {
    if (!Array.isArray(v.videoThumbnails)) continue;
    for (const t of v.videoThumbnails) {
      if (typeof t.url === "string" && t.url.startsWith("/")) t.url = base + t.url;
    }
  }
  return videos;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    const url = new URL(request.url);
    if (url.pathname !== "/search") return json({ error: "not_found" }, 404);

    // Валідація входу — це публічний ендпоінт
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ error: "missing_q" }, 400);
    if (q.length > MAX_Q) return json({ error: "q_too_long" }, 400);

    let page = parseInt(url.searchParams.get("page") || "1", 10);
    if (!Number.isFinite(page) || page < 1 || page > MAX_PAGE) page = 1;

    // Ключ кешу нормалізований: лише q і page, без зайвих параметрів
    const cacheKey = new Request(
      `https://tv-proxy.local/search?q=${encodeURIComponent(q)}&page=${page}`,
      { method: "GET" }
    );
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("X-Cache", "HIT");
      return r;
    }

    const path = `/api/v1/search?q=${encodeURIComponent(q)}&page=${page}&type=video`;
    const order = lastGood
      ? [lastGood, ...INSTANCES.filter((i) => i !== lastGood)]
      : INSTANCES.slice();

    for (const base of order) {
      const data = await tryInstance(base, path);
      if (!data) continue;

      lastGood = base;
      const res = new Response(JSON.stringify(normalize(data, base)), {
        headers: {
          ...CORS,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${CACHE_TTL}`,
          "X-Instance": base,
          "X-Cache": "MISS",
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    lastGood = null; // усі впали — наступного разу починаємо з початку списку
    return json({ error: "all_instances_down" }, 503);
  },
};
