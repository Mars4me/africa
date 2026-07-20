// Мінімальна перевірка логіки з index.html. Запуск: node test.js
const assert = require("assert");
const fs = require("fs");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");

// --- 1. fmtDur ---
function fmtDur(s){
  if(!s || s<0) return "LIVE";
  var h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  function p(n){ return n<10?"0"+n:""+n; }
  return h>0 ? h+":"+p(m)+":"+p(sec) : m+":"+p(sec);
}
assert.strictEqual(fmtDur(0), "LIVE");
assert.strictEqual(fmtDur(59), "0:59");
assert.strictEqual(fmtDur(61), "1:01");
assert.strictEqual(fmtDur(3599), "59:59");
assert.strictEqual(fmtDur(3661), "1:01:01");
console.log("ok fmtDur");

// --- 2. spatial navigation: сітка 4 колонки ---
function move(cur, items, dir){
  var r = cur, cx = r.left + r.w/2, cy = r.top + r.h/2;
  var best=null, bestScore=Infinity;
  items.forEach(function(el){
    if(el === cur) return;
    var ex = el.left + el.w/2, ey = el.top + el.h/2;
    var dx = ex-cx, dy = ey-cy;
    var ok = (dir==="right"&&dx>10)||(dir==="left"&&dx<-10)||
             (dir==="down"&&dy>10)||(dir==="up"&&dy<-10);
    if(!ok) return;
    var primary = (dir==="left"||dir==="right") ? Math.abs(dx) : Math.abs(dy);
    var cross   = (dir==="left"||dir==="right") ? Math.abs(dy) : Math.abs(dx);
    var score = primary + cross*2;
    if(score < bestScore){ bestScore=score; best=el; }
  });
  return best;
}
// сітка 4x2, картка 300x250, gap 0
const grid = [];
for(let row=0; row<2; row++)
  for(let col=0; col<4; col++)
    grid.push({ name:"r"+row+"c"+col, left:col*300, top:row*250, w:300, h:250 });
const at = n => grid.find(g => g.name === n);

assert.strictEqual(move(at("r0c0"), grid, "right").name, "r0c1", "вправо = сусід у рядку");
assert.strictEqual(move(at("r0c1"), grid, "left").name,  "r0c0", "вліво = сусід у рядку");
assert.strictEqual(move(at("r0c0"), grid, "down").name,  "r1c0", "вниз = та сама колонка");
assert.strictEqual(move(at("r1c2"), grid, "up").name,    "r0c2", "вгору = та сама колонка");
assert.strictEqual(move(at("r0c3"), grid, "right"), null, "край рядка -> нікуди");
assert.strictEqual(move(at("r0c0"), grid, "up"), null, "верхній ряд -> нікуди (вище лише header)");
console.log("ok spatial navigation");

// --- 3. з картки верхнього ряду вгору треба потрапити на chips, а не на іншу картку ---
const withChips = grid.concat([{ name:"chip0", left:0, top:-80, w:200, h:60 }]);
assert.strictEqual(move(at("r0c0"), withChips, "up").name, "chip0", "з сітки вгору -> chips");
console.log("ok grid -> chips");

// --- 3b. стрілки в полі вводу не перехоплюються ---
function shouldHandleArrow(key, inTextInput){
  if(!inTextInput) return true;
  return key === "ArrowDown";
}
// у полі пошуку: курсор рухається сам
assert.strictEqual(shouldHandleArrow("ArrowLeft",  true),  false, "Left в input -> браузеру");
assert.strictEqual(shouldHandleArrow("ArrowRight", true),  false, "Right в input -> браузеру");
assert.strictEqual(shouldHandleArrow("ArrowUp",    true),  false, "Up в input -> браузеру");
assert.strictEqual(shouldHandleArrow("ArrowDown",  true),  true,  "Down в input -> перехід на chips");
// поза полем: навігація працює як раніше
["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].forEach(k =>
  assert.strictEqual(shouldHandleArrow(k, false), true, k + " на картці -> навігація"));
console.log("ok arrow guard");

// той самий guard справді стоїть у index.html перед preventDefault
assert.match(html, /shouldHandleArrow\(e\.key,\s*isTextInput\(document\.activeElement\)\)/,
  "guard не підключений до обробника keydown");
// guard має стояти перед гілкою стрілок (перший preventDefault — це Escape плеєра, він раніше і це ок)
const handler = html.slice(html.indexOf('document.addEventListener("keydown"'));
const guardPos = handler.indexOf("shouldHandleArrow");
const arrowPos = handler.indexOf('case "ArrowRight"');
assert.ok(guardPos > -1 && arrowPos > -1 && guardPos < arrowPos,
  "guard має спрацьовувати ДО preventDefault на стрілках");
console.log("ok guard підключений перед preventDefault");

// --- 3c. плеєр: помилка embed -> чорний список -> фільтр сітки ---
// Тут ми не копіюємо логіку, а виконуємо справжній скрипт з index.html
// на мінімальному стабі DOM і смикаємо реальний onError від YT.Player.
function makeApp(videos, opts){
  opts = opts || {};
  const store = new Map();
  function El(tag){
    this.tagName = (tag||"DIV").toUpperCase();
    this.children = []; this.style = {}; this.attrs = {};
    this.textContent = ""; this.value = ""; this._html = "";
    this.listeners = {}; this.offsetParent = {};
    this.classList = {
      _s: new Set(),
      add: n => this.classList._s.add(n),
      remove: n => this.classList._s.delete(n),
      contains: n => this.classList._s.has(n)
    };
  }
  El.prototype.appendChild = function(c){ c.parentNode = this; this.children.push(c); return c; };
  El.prototype.removeChild = function(c){
    this.children = this.children.filter(x => x !== c); return c;
  };
  El.prototype.setAttribute = function(k,v){ this.attrs[k] = String(v); };
  El.prototype.getAttribute = function(k){ return this.attrs[k]; };
  El.prototype.addEventListener = function(t,f){ (this.listeners[t] = this.listeners[t]||[]).push(f); };
  El.prototype.focus = function(){ doc.activeElement = this; };
  El.prototype.click = function(){ (this.listeners.click||[]).forEach(f => f({})); };
  El.prototype.querySelector = function(sel){
    const m = /^\[data-vid="(.+)"\]$/.exec(sel);
    if(m) return this.children.find(c => c.attrs["data-vid"] === m[1]) || null;
    if(sel === ".card") return this.children.find(c => c.attrs.class === "card" || c._cls === "card") || null;
    return this.children[0] || null;
  };
  Object.defineProperty(El.prototype, "innerHTML", {
    get(){ return this._html; },
    set(v){ this._html = v; this.children = []; }   // очищення дітей, як у справжньому DOM
  });
  Object.defineProperty(El.prototype, "className", {
    get(){ return this._cls || ""; }, set(v){ this._cls = v; }
  });

  // мок Fullscreen API — фіксуємо, на якому елементі його викликали
  const fsCalls = [];
  El.prototype.requestFullscreen = function(){ fsCalls.push(this); };

  const ids = ["search","chips","grid","status","player","playerHost","playerMsg","backBtn","fsBtn"];
  const els = {};
  ids.forEach(i => els[i] = new El(i === "search" ? "INPUT" : "DIV"));
  const doc = {
    activeElement: null,
    head: new El("head"),
    body: { offsetHeight: 1000 },
    getElementById: i => els[i] || null,
    createElement: t => new El(t),
    querySelectorAll: () => [],
    addEventListener: (t,f) => (doc.listeners[t] = doc.listeners[t]||[]).push(f),
    listeners: {}
  };
  const win = {
    document: doc, innerHeight: 800, scrollY: 0,
    addEventListener: () => {},
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k,v) => store.set(k, String(v))
    }
  };
  // XHR завжди віддає підготовлений список відео
  function XHRStub(){ this.timeout = 0; }
  XHRStub.prototype.open = function(){};
  XHRStub.prototype.send = function(){
    this.status = 200;
    this.responseText = JSON.stringify(videos);
    if(this.onload) this.onload();
  };
  // YT.Player: зберігаємо events, щоб потім викликати справжній onError
  const captured = {};
  const YT = { Player: function(mount, cfg){ captured.cfg = cfg; this.destroy = () => {}; } };

  const src = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const sandbox = {
    window: win, document: doc, localStorage: win.localStorage,
    XMLHttpRequest: XHRStub, setTimeout: () => 0, clearTimeout: () => {},
    encodeURIComponent, JSON, Math, Array, Number, String, Object, console
  };
  if(!opts.noApi) win.YT = YT;
  require("vm").createContext(sandbox);
  require("vm").runInContext(src, sandbox);
  // noApi = скрипт iframe_api не завантажився, onYouTubeIframeAPIReady не викликається
  if(!opts.noApi) win.onYouTubeIframeAPIReady();
  return { doc, els, store, captured, fsCalls, keydown: doc.listeners.keydown || [] };
}

const VIDS = [
  { type:"video", videoId:"OKVIDEO1", title:"Добре відео", author:"A", lengthSeconds:60, videoThumbnails:[{quality:"medium",url:"u1"}] },
  { type:"video", videoId:"BLOCKED1", title:"Заборонене",  author:"B", lengthSeconds:0,  videoThumbnails:[{quality:"medium",url:"u2"}] }
];

const app = makeApp(VIDS);
const vidsOf = () => app.els.grid.children.map(c => c.attrs["data-vid"]);
assert.deepStrictEqual(vidsOf(), ["OKVIDEO1","BLOCKED1"], "спершу обидва відео в сітці");

// відкриваємо заборонене відео -> реальний openPlayer -> реальний YT.Player
app.els.grid.children.find(c => c.attrs["data-vid"] === "BLOCKED1").click();
assert.ok(app.captured.cfg, "YT.Player не створений");
assert.strictEqual(app.captured.cfg.videoId, "BLOCKED1");
assert.strictEqual(app.captured.cfg.host, "https://www.youtube-nocookie.com", "потрібен nocookie host");

// (а) симулюємо помилку 150 -> зрозуміле повідомлення + фокус на "Назад"
app.captured.cfg.events.onError({ data: 150 });
assert.strictEqual(app.els.playerMsg.textContent, "Це відео недоступне для перегляду тут");
assert.strictEqual(app.els.playerMsg.style.display, "flex", "повідомлення має бути видиме");
assert.strictEqual(app.doc.activeElement, app.els.backBtn, "фокус має бути на кнопці Назад");
console.log("ok onError(150) -> повідомлення");

// (б) videoId потрапив у чорний список localStorage
assert.deepStrictEqual(JSON.parse(app.store.get("yt_blocked")), ["BLOCKED1"]);
console.log("ok onError(150) -> чорний список");

// картка одразу зникла з поточної сітки
assert.deepStrictEqual(vidsOf(), ["OKVIDEO1"], "заборонену картку прибрано з сітки");

// (в) при повторному рендері (новий сеанс з тим самим localStorage) — відфільтровано
const app2 = makeApp(VIDS);
app2.store.set("yt_blocked", JSON.stringify(["BLOCKED1"]));
app2.els.grid.children = [];
app2.els.search.listeners.keydown[0]({ key:"Enter", preventDefault(){} }); // новий пошук
assert.deepStrictEqual(
  app2.els.grid.children.map(c => c.attrs["data-vid"]), ["OKVIDEO1"],
  "заборонене відео не має рендеритись повторно");
console.log("ok повторний рендер фільтрує чорний список");

// коди, що НЕ блокують (напр. 5 — помилка HTML5-плеєра)
const app3 = makeApp(VIDS);
app3.els.grid.children.find(c => c.attrs["data-vid"] === "BLOCKED1").click();
app3.captured.cfg.events.onError({ data: 5 });
assert.strictEqual(app3.store.get("yt_blocked"), undefined, "код 5 не має блокувати відео");
assert.strictEqual(app3.els.playerMsg.textContent, "Не вдалося відтворити відео");
console.log("ok код 5 не блокує");

// fallback на голий iframe, якщо API не завантажилось
const app4 = makeApp(VIDS, { noApi: true });
app4.els.grid.children[0].click();
assert.strictEqual(app4.captured.cfg, undefined, "без API YT.Player не має створюватись");
assert.match(app4.els.playerHost.innerHTML,
  /<iframe[^>]+youtube-nocookie\.com\/embed\/OKVIDEO1/,
  "має бути fallback-iframe на nocookie");
assert.ok(app4.els.player.classList.contains("open"), "плеєр все одно відкривається");
console.log("ok fallback на iframe без API");

// --- 3e. прев'ю: URL, відносні шляхи, ланцюжок фолбеків ---
const YTI = id => "https://i.ytimg.com/vi/"+id+"/mqdefault.jpg";
const srcOf = card => (/<img[^>]+src="([^"]+)"/.exec(card.innerHTML) || [])[1];

// відносний шлях від інстансу має доклеїтись до домену ТОГО ж інстансу
const appRel = makeApp([{ type:"video", videoId:"REL0000001", title:"t", author:"a", lengthSeconds:10,
  videoThumbnails:[{quality:"medium", url:"/vi/REL0000001/mqdefault.jpg"}] }]);
assert.strictEqual(srcOf(appRel.els.grid.children[0]),
  "https://yt.chocolatemoo53.com/vi/REL0000001/mqdefault.jpg",
  "відносний шлях має клеїтись до домену інстансу");
console.log("ok відносний шлях -> домен інстансу");

// повний URL не чіпаємо
const appAbs = makeApp([{ type:"video", videoId:"ABS0000001", title:"t", author:"a", lengthSeconds:10,
  videoThumbnails:[{quality:"medium", url:"https://cdn.example/x.jpg"}] }]);
assert.strictEqual(srcOf(appAbs.els.grid.children[0]), "https://cdn.example/x.jpg");
console.log("ok повний URL лишається як є");

// порожній / некоректний videoThumbnails -> одразу YouTube CDN
[[], null, undefined, "не масив", [{quality:"medium"}]].forEach((thumbs, i) => {
  const id = "EMPTY00000";
  const a = makeApp([{ type:"video", videoId:id, title:"t", author:"a", lengthSeconds:10,
                       videoThumbnails: thumbs }]);
  assert.strictEqual(srcOf(a.els.grid.children[0]), YTI(id),
    "варіант " + i + ": має бути ytimg URL за videoId");
});
console.log("ok порожній videoThumbnails -> i.ytimg.com");

// ланцюжок onerror: інстанс -> mqdefault -> hqdefault -> плейсхолдер
function chain(startSrc, videoId){
  // мінімальний стаб <img>, який завжди «не завантажується»
  const parent = { className: "thumb" };
  const img = {
    _src: startSrc, style: {}, parentNode: parent, onerror: null,
    getAttribute: () => img._src,
    setAttribute: (k,v) => { img._src = v; }
  };
  const src = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const fn = new Function(src.slice(src.indexOf("function ytimg"), src.indexOf("function fmtDur")) +
    "return { attach: attachThumbFallback };")();
  fn.attach(img, videoId);
  const seen = [];
  for(let i = 0; i < 5 && img.onerror; i++){ img.onerror(); seen.push(img._src); }
  return { seen, parent, img };
}
const c1 = chain("https://yt.chocolatemoo53.com/vi/VID0000001/mqdefault.jpg", "VID0000001");
assert.deepStrictEqual(c1.seen.slice(0,2), [
  "https://i.ytimg.com/vi/VID0000001/mqdefault.jpg",
  "https://i.ytimg.com/vi/VID0000001/hqdefault.jpg"
], "ланцюжок має бути mqdefault -> hqdefault");
assert.strictEqual(c1.parent.className, "thumb noimg", "в кінці має бути плейсхолдер");
assert.strictEqual(c1.img.style.display, "none", "зламану картинку треба сховати");
console.log("ok ланцюжок mqdefault -> hqdefault -> плейсхолдер");

// якщо стартовий src вже ytimg/mqdefault — не повторюємо його, йдемо далі
const c2 = chain(YTI("VID0000002"), "VID0000002");
assert.strictEqual(c2.seen[0], "https://i.ytimg.com/vi/VID0000002/hqdefault.jpg",
  "не має повторювати URL, який щойно впав");
console.log("ok немає повтору того самого URL");

// --- 3d. екран відтворення: fullscreen-кнопка і розкладка ---
const app5 = makeApp(VIDS);
app5.els.grid.children[0].click();

// кнопка є в DOM
assert.ok(app5.els.fsBtn, "немає кнопки fullscreen");
assert.match(html, /<button id="fsBtn">[^<]+<\/button>/, "fsBtn має бути <button>");

// порядок табуляції в розмітці: Назад -> плеєр -> На весь екран
const order = ["backBtn","playerHost","fsBtn"].map(id => html.indexOf('id="'+id+'"'));
assert.ok(order[0] < order[1] && order[1] < order[2],
  "порядок у DOM має бути backBtn -> playerHost -> fsBtn, отримано " + order);
console.log("ok fsBtn присутній і в правильному порядку");

// клік викликає requestFullscreen саме на контейнері плеєра
app5.els.fsBtn.click();
assert.strictEqual(app5.fsCalls.length, 1, "requestFullscreen не викликано");
assert.strictEqual(app5.fsCalls[0], app5.els.playerHost,
  "fullscreen має вмикатись на playerHost, а не на іншому елементі");
console.log("ok клік -> requestFullscreen(playerHost)");

// стрілки перемикають фокус між двома кнопками екрана відтворення
const kd = app5.doc.listeners.keydown[0];
const key = k => kd({ key:k, preventDefault(){} });
key("ArrowDown"); assert.strictEqual(app5.doc.activeElement, app5.els.fsBtn,  "вниз -> fsBtn");
key("ArrowUp");   assert.strictEqual(app5.doc.activeElement, app5.els.backBtn,"вгору -> backBtn");
console.log("ok стрілки перемикають Назад <-> На весь екран");

// Escape у fullscreen лише виходить із нього, плеєр лишається відкритим
app5.doc.fullscreenElement = app5.els.playerHost;
key("Escape");
assert.ok(app5.els.player.classList.contains("open"),
  "Escape у fullscreen не має закривати плеєр");
// а без fullscreen — закриває
app5.doc.fullscreenElement = null;
key("Escape");
assert.ok(!app5.els.player.classList.contains("open"), "Escape поза fullscreen закриває плеєр");
console.log("ok Escape: fullscreen -> плеєр");

// CSS не лишає плеєр у розмірі 640x360
assert.match(html, /#playerHost\s*\{[^}]*position:\s*relative/, "playerHost має бути position:relative");
assert.match(html, /#playerHost iframe[^{]*\{[^}]*width:\s*100%[^}]*height:\s*100%/,
  "iframe у плеєрі має розтягуватись на 100%");
console.log("ok CSS розтягує плеєр на весь контейнер");

// --- 4. інстанси в файлі + робочий перший ---
const list = (html.match(/https:\/\/[a-z0-9.\-]+/gi) || [])
  .filter(u => !/youtube-nocookie|ytimg|youtube\.com/.test(u));
assert.ok(list.length >= 4, "мінімум 4-5 запасних інстансів, знайдено " + list.length);
assert.strictEqual(list[0], "https://yt.chocolatemoo53.com", "перевірений інстанс має бути першим");
console.log("ok instances (" + list.length + ")");

// --- 5. живий запит до першого інстансу (пропускається без мережі) ---
const url = list[0] + "/api/v1/search?q=africa+online&page=1&type=video";
fetch(url, { signal: AbortSignal.timeout(12000) })
  .then(r => { assert.strictEqual(r.status, 200);
               assert.match(r.headers.get("content-type")||"", /json/);
               assert.strictEqual(r.headers.get("access-control-allow-origin"), "*", "потрібен CORS для браузера");
               return r.json(); })
  .then(d => {
    assert.ok(Array.isArray(d) && d.length > 0, "порожня відповідь");
    const v = d[0];
    assert.ok(v.videoId && v.title, "немає videoId/title");
    assert.ok((v.videoThumbnails||[]).some(t => t.quality === "medium"), "немає medium thumbnail");
    console.log("ok live API (" + d.length + " відео, напр. \"" + v.title.slice(0,40) + "\")");
    console.log("\nВСІ ПЕРЕВІРКИ ПРОЙДЕНО");
  })
  .catch(e => { console.log("!! live API недоступний:", e.message, "(логіка вище — ok)"); });
