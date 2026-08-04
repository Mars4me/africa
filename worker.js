/**
 * Cloudflare Worker — проксі пошуку відео.
 *
 * Навіщо: CORS — обмеження браузера, на сервері його немає. Worker ходить
 * до бекендів сам і віддає клієнту власні CORS-заголовки — з білого списку
 * ALLOWED_ORIGINS (прод + Live Server на localhost).
 *
 * Два джерела даних, у такому порядку:
 *   1. yt-scrape — сторінка результатів youtube.com/results + парсинг
 *      вбудованого ytInitialData. Основний спосіб (див. README).
 *   2. Invidious — перебір публічних дзеркал INSTANCES. Фолбек, бо станом
 *      на 2026-07 вони масово мертві.
 * Обидва віддають однаковий Invidious-подібний JSON, тож клієнт про це
 * нічого не знає; яке джерело спрацювало — видно в заголовку X-Backend.
 *
 * Ендпоінт:  GET /search?q=ЗАПИТ&page=N
 * Задеплоєно: https://winter-star-48dc.sweaterbaddy.workers.dev
 */

// Кандидати в порядку пріоритету. Перебір: беремо перший, що віддав 200 +
// валідний JSON-масив; 403/502/503/таймаут/HTML-заглушка -> одразу наступний.
// Перше вдале дзеркало запам'ятовується в lastGood і наступного разу
// пробується першим. Якщо не відповів жоден — 502 + {error:"all instances
// unavailable"}. Гірший випадок: 6 × 4.5 с ≈ 27 с.
// Тримаємо мертві в списку: вони регулярно оживають, а перебір коштує
// лише таймаут. Перевірено 2026-07-20: валідні дані віддавало лише
// yt.chocolatemoo53.com; решта — 403/401/502 або анти-бот Anubis.
const INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://inv.thepixora.com",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://invidious.f5.si",
];

const UPSTREAM_TIMEOUT = 4500; // мс на одне дзеркало (6 × 4.5 ≈ 27 с найгірше)
const CACHE_TTL = 60;          // с, кеш однакових запитів
const MAX_PAGE = 20;
const MAX_Q = 200;
const RATE_LIMIT = 30;      // запитів з одного IP
const RATE_WINDOW = 60000;  // мс

// Заголовки «як у звичайного браузера». CONSENT=YES+1 — відома куки-заглушка
// згоди: без неї YouTube для запиту без сесії інколи віддає не результати,
// а редірект/сторінку consent.youtube.com.
const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "CONSENT=YES+1",
};

// Звідки дозволено ходити в проксі. Щоб додати ще один — допишіть рядок
// (схема + хост + порт, без завершального слеша) і передеплойте Worker.
const ALLOWED_ORIGINS = [
  "https://mars4me.github.io",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];

// Echo дозволеного Origin; невідомий (або запит без Origin — curl тощо)
// отримує прод-домен як дефолт. Vary: Origin — щоб кеш (наш і браузерний)
// не віддав чужому origin відповідь із попереднім заголовком.
function cors(request) {
  const origin = request && request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

// Живе доки живий isolate — щоб не перебирати список на кожен запит.
// ponytail: in-memory, не KV. Isolate'ів багато, але кожен швидко
// «прогрівається»; KV дав би спільний стан ціною зайвої залежності.
let lastGood = null;

// Rate limit по IP. Особливо важливий при yt-scrape: сплеск запитів з
// одного IP Cloudflare пришвидшує появу consent/капчі від Google —
// і то для всіх користувачів воркера, не лише для того, хто спамить.
// ponytail: in-memory Map на isolate, як і lastGood. Ліміт «на isolate», а
// не глобальний; для жорсткого — Durable Object або KV.
const hits = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now >= rec.resetAt) {
    // прибираємо протухлі записи, щоб Map не ріс безмежно
    if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  rec.count++;
  return rec.count <= RATE_LIMIT;
}

function json(obj, status, request, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...cors(request),
      "Content-Type": "application/json; charset=utf-8",
      ...(extra || {}),
    },
  });
}

// --- Джерело 1: HTML-сторінка результатів YouTube -------------------------

/**
 * Вирізає JSON після "var ytInitialData =" балансом фігурних дужок.
 *
 * Регекс до першого ";" тут не працює: у назвах відео трапляються і ";",
 * і "}", і "</script>". Тому скануємо символи, рахуючи глибину, але
 * пропускаючи все, що всередині рядкового літерала (з урахуванням
 * екранування) — інакше назва на кшталт «рецепт {домашній}» зіб'є лічильник.
 * Повертає підрядок JSON або null.
 */
function extractYtInitialData(html) {
  const markers = ["var ytInitialData = ", "ytInitialData = "];
  let start = -1;
  for (const m of markers) {
    const i = html.indexOf(m);
    if (i !== -1) { start = html.indexOf("{", i + m.length); break; }
  }
  if (start === -1) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  return null; // дужки не збалансувались — HTML обрізаний або це не той блок
}

/** "12:34" / "1:02:03" -> секунди. Сміття -> 0. */
function parseDurationToSeconds(str) {
  if (typeof str !== "string") return 0;
  const parts = str.trim().split(":").map((p) => parseInt(p, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Витягує videoRenderer'и зі структури ytInitialData. */
function pickVideoRenderers(parsed) {
  try {
    const sections =
      parsed.contents.twoColumnSearchResultsRenderer.primaryContents
        .sectionListRenderer.contents;
    const out = [];
    for (const s of sections) {
      const items = s && s.itemSectionRenderer && s.itemSectionRenderer.contents;
      if (!Array.isArray(items)) continue;
      // без videoRenderer — це channelRenderer/playlistRenderer/промо-блок
      for (const it of items) if (it && it.videoRenderer) out.push(it.videoRenderer);
    }
    return out;
  } catch (e) {
    return []; // YouTube змінив розмітку -> порожньо -> підемо у фолбек
  }
}

/** videoRenderer[] -> той самий формат, що вже очікує фронтенд. */
function normalizeYtScrape(videos) {
  const out = [];
  for (const v of videos) {
    if (!v || !v.videoId) continue;
    const live = (v.thumbnailOverlays || []).some(
      (o) =>
        o &&
        o.thumbnailOverlayTimeStatusRenderer &&
        o.thumbnailOverlayTimeStatusRenderer.style === "LIVE"
    );
    const dur = v.lengthText && v.lengthText.simpleText;
    out.push({
      videoId: v.videoId,
      title: (v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || "",
      videoThumbnails: (v.thumbnail && v.thumbnail.thumbnails) || [],
      author:
        (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || "",
      // 0 == LIVE — так само трактує fmtDur() на клієнті
      lengthSeconds: live ? 0 : parseDurationToSeconds(dur),
      // у стрімів це не simpleText, а runs: ["1 234", " watching"]
      viewCount: v.viewCountText
        ? v.viewCountText.simpleText ||
          (v.viewCountText.runs || []).map((r) => r.text).join("")
        : "",
      published: null,
    });
  }
  return out;
}

/**
 * Основний спосіб: тягне сторінку результатів і парсить ytInitialData.
 * Повертає масив відео або null (тоді викликач іде в Invidious).
 */
async function scrapeYouTube(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);
  try {
    // sp=CAI%3D — фільтр «тільки відео». Навіть якщо фільтр перестане
    // діяти, pickVideoRenderers усе одно бере лише videoRenderer.
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=CAI%3D`,
      { signal: ctrl.signal, headers: YT_HEADERS }
    );
    if (!res.ok) return null;
    const html = await res.text();
    // замість результатів приїхала сторінка згоди / капча
    if (html.includes('action="https://consent.youtube.com')) return null;

    const raw = extractYtInitialData(html);
    if (!raw) return null;
    const videos = normalizeYtScrape(pickVideoRenderers(JSON.parse(raw)));
    return videos.length ? videos : null; // нуль відео — теж привід у фолбек
  } catch (e) {
    return null; // таймаут / мережа / битий JSON
  } finally {
    clearTimeout(timer);
  }
}

// --- Джерело 2: Invidious -------------------------------------------------

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
 * абсолютними тут. (У yt-scrape вони вже абсолютні, з i.ytimg.com.)
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
    const CORS = cors(request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, request);

    const url = new URL(request.url);
    if (url.pathname !== "/search") return json({ error: "not_found" }, 404, request);

    // Ліміт до валідації й до будь-якого походу в upstream — однаково для
    // yt-scrape і для Invidious-фолбека.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRateLimit(ip)) {
      return json({ error: "rate_limited" }, 429, request, { "Retry-After": "60" });
    }

    // Валідація входу — це публічний ендпоінт
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ error: "missing_q" }, 400, request);
    if (q.length > MAX_Q) return json({ error: "q_too_long" }, 400, request);

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
      // у кеші лежить заголовок того origin, який зробив MISS — перебиваємо
      r.headers.set("Access-Control-Allow-Origin", CORS["Access-Control-Allow-Origin"]);
      return r;
    }

    function ok(videos, extra) {
      const res = new Response(JSON.stringify(videos), {
        headers: {
          ...CORS,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${CACHE_TTL}`,
          "X-Cache": "MISS",
          ...extra,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // Спосіб 1. Лише для page=1: наступні сторінки YouTube віддає не в
    // ytInitialData, а окремим continuation-запитом до внутрішнього API з
    // токеном зі сторінки. Це помітно більше коду — поки що пагінація
    // цілком на Invidious.
    if (page === 1) {
      const scraped = await scrapeYouTube(q);
      if (scraped) return ok(scraped, { "X-Backend": "yt-scrape" });
    }

    // Спосіб 2. Перебір дзеркал Invidious.
    const path = `/api/v1/search?q=${encodeURIComponent(q)}&page=${page}&type=video`;
    const order = lastGood
      ? [lastGood, ...INSTANCES.filter((i) => i !== lastGood)]
      : INSTANCES.slice();

    for (const base of order) {
      const data = await tryInstance(base, path);
      if (!data) continue;

      lastGood = base;
      return ok(normalize(data, base), { "X-Backend": "invidious", "X-Instance": base });
    }

    lastGood = null; // усі впали — наступного разу починаємо з початку списку
    return json({ error: "all instances unavailable" }, 502, request);
  },
};
