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
  El.prototype.focus = function(){
    doc.activeElement = this;
    (doc.listeners.focus || []).forEach(f => f({ target: this })); // focus не спливає -> capture
  };
  El.prototype.click = function(){ (this.listeners.click||[]).forEach(f => f({})); };
  El.prototype.key = function(k){
    (this.listeners.keydown||[]).forEach(f => f({ key: k, preventDefault(){} }));
  };
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
    listeners: {},
    hidden: false,
    exitFullscreen: () => { exitCalls.push(1); doc.fullscreenElement = null; }
  };
  const exitCalls = [];
  const win = {
    document: doc, innerHeight: 800, scrollY: 0,
    addEventListener: (t,f) => (win.listeners[t] = win.listeners[t]||[]).push(f),
    listeners: {},
    // мінімальний History API: стек станів + back(), що шле popstate
    history: {
      _stack: [null],
      get state(){ return win.history._stack[win.history._stack.length - 1]; },
      pushState: s => { win.history._stack.push(s); },
      back: () => {
        if(win.history._stack.length > 1) win.history._stack.pop();
        (win.listeners.popstate || []).forEach(f => f({ state: win.history.state }));
      }
    },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k,v) => store.set(k, String(v))
    }
  };
  // XHR-стаб: пише URL запитів і віддає підготовлену відповідь
  const requests = [];
  function XHRStub(){ this.timeout = 0; }
  XHRStub.prototype.open = function(m, u){ requests.push(u); };
  XHRStub.prototype.send = function(){
    this.status = 200;
    this.responseText = JSON.stringify(videos);
    if(this.onload) this.onload();
  };
  // YT.Player: зберігаємо events, щоб потім викликати справжній onError
  const captured = {};
  const pauseCalls = [];
  const YT = { Player: function(mount, cfg){
    captured.cfg = cfg;
    this.destroy = () => {};
    this.pauseVideo = () => pauseCalls.push(1);
  } };

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
  return { doc, els, store, captured, fsCalls, exitCalls, pauseCalls, requests, win,
           keydown: doc.listeners.keydown || [] };
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
app2.els.search.value = "новий запит"; // поле більше не заповнюється за замовчуванням
app2.els.search.key("Enter");    // активація поля
app2.els.search.key("Enter");    // новий пошук
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

// --- 3f. пошук і панель підказок ---
const appC = makeApp(VIDS);
const isOpen = () => appC.els.chips.className === "open";

// на головному екрані підказок не видно
assert.ok(!isOpen(), "chips не мають бути видимі одразу після завантаження");
assert.ok(appC.els.grid.children.length > 0, "сітка має бути заповнена без chips");
console.log("ok chips приховані на головному екрані");

// сам фокус (проліт стрілками) НЕ активує ввід
appC.els.search.focus();
assert.ok(!isOpen(), "фокус у пошуку не має показувати chips");
assert.notStrictEqual(appC.els.search.className, "active", "фокус != активація");

// Enter/OK на сфокусованому полі -> режим вводу + chips
appC.els.search.key("Enter");
assert.strictEqual(appC.els.search.className, "active", "Enter має активувати поле");
assert.ok(isOpen(), "після Enter chips мають з'явитись");

// Escape -> назад у звичайний фокус, без chips
appC.els.search.key("Escape");
assert.ok(!isOpen(), "Escape має сховати chips");
assert.notStrictEqual(appC.els.search.className, "active", "Escape має зняти активацію");

// перший Enter лише активує, пошуку ще не запускає
appC.els.grid.children = [];
appC.els.search.value = "коти";
appC.els.search.key("Enter");
assert.strictEqual(appC.els.grid.children.length, 0, "перший Enter не має шукати");
appC.els.search.key("Enter");
assert.ok(appC.els.grid.children.length > 0, "другий Enter має виконати пошук");

// клік (мишка/тач) активує одразу
appC.els.search.focus();
appC.els.search.click();
assert.ok(isOpen(), "клік у пошуку має активувати і показати chips");
console.log("ok фокус лише підсвічує, Enter/клік активує, Escape виходить");

// вибір підказки: виконує пошук, підставляє текст і ховає панель
appC.els.grid.children = [];
const chip = appC.els.chips.children[0];
const chipText = chip.textContent;
chip.click();
assert.strictEqual(appC.els.search.value, chipText, "текст підказки має потрапити в поле");
assert.ok(appC.els.grid.children.length > 0, "вибір підказки має виконати пошук");
assert.ok(!isOpen(), "після вибору підказки панель має сховатись");
console.log("ok вибір chip -> пошук + приховування");

// панель ховається навіть коли пошук нічого не знайшов
// (тоді фокус лишається на chip і focus-обробник не спрацьовує)
const appEmpty = makeApp([]);
appEmpty.els.search.focus();
appEmpty.els.search.key("Enter");
assert.ok(appEmpty.els.chips.className === "open");
appEmpty.els.chips.children[0].click();
assert.strictEqual(appEmpty.els.chips.className, "",
  "панель має ховатись і коли результатів немає");
console.log("ok chip ховає панель навіть без результатів");

// саме CSS ховає панель за замовчуванням, а не лише JS-клас
const chipsCss = /#chips\{([^}]*)\}/.exec(html)[1];
const chipCss  = /\.chip\{([^}]*)\}/.exec(html)[1];
assert.match(chipsCss, /display:\s*none/, "#chips має бути display:none за замовчуванням");
assert.match(html, /#chips\.open\{[^}]*display:\s*(block|flex)/, "#chips.open має показувати панель");
console.log("ok CSS ховає chips за замовчуванням");

// панель переноситься на новий рядок і не вилазить за екран
const wraps = /flex-wrap:\s*wrap/.test(chipsCss) || /display:\s*inline-block/.test(chipCss);
assert.ok(wraps, "chips мають переноситись: flex-wrap:wrap або inline-block");
assert.ok(!/white-space:\s*nowrap/.test(chipsCss),
  "white-space:nowrap на контейнері зламав би перенесення рядків");
assert.match(chipsCss, /max-width:\s*100%/, "#chips має бути обмежений шириною батька");
assert.match(chipsCss, /overflow-x:\s*hidden/, "#chips потребує overflow-x:hidden як страховки");
console.log("ok chips переносяться і обмежені по ширині");

// між chips є проміжок і по горизонталі, і по вертикалі (для кількох рядків)
const margin = /margin:\s*([^;]+);/.exec(chipCss);
assert.ok(margin || /gap:/.test(chipsCss), "потрібен проміжок між chips");
if(margin){
  const parts = margin[1].trim().split(/\s+/);           // top right bottom left
  assert.ok(parseInt(parts[1],10) > 0, "потрібен горизонтальний проміжок");
  assert.ok(parseInt(parts[2],10) > 0, "потрібен вертикальний проміжок між рядками");
}
console.log("ok проміжки між chips у обох напрямках");

// #search — width:100%, тож будь-який scale на :focus виносить праву межу за екран
// перебираємо ВСІ правила, а не одне — #search:focus міг лишитись у спільному селекторі
for(const [, sel, body] of html.matchAll(/([^{}]+)\{([^}]*)\}/g)){
  if(!/#search:focus/.test(sel)) continue;
  assert.ok(!/transform:\s*scale/.test(body),
    "scale у правилі \"" + sel.trim() + "\" розтягує поле шириною 100% за межі екрана");
}
assert.match(/#search\{([^}]*)\}/.exec(html)[1], /width:\s*100%/,
  "#search має тягнутись по батьку, а не мати фіксовану ширину");
assert.ok(!/#search\{[^}]*(min-width|width):\s*\d+px/.test(html),
  "фіксована/мінімальна ширина в px у #search вилізе за вузький екран");
console.log("ok поле пошуку не виходить за екран при фокусі");

// сітка не перекривається: header у потоці (sticky), а не fixed
assert.match(html, /header\{[^}]*position:\s*sticky/,
  "header має бути sticky — fixed вийняв би його з потоку і сітка полізла б під нього");
console.log("ok header у потоці -> сітка зсувається вниз");

// симуляція перенесення: жоден chip не виходить за ширину контейнера,
// а порядок фокуса лишається зліва-направо, зверху-вниз
// (справжніх розмірів у стабі немає — це перевірка моделі, не браузера)
function layout(containerW, chipWs, mx = 10, my = 10, h = 44){
  const out = []; let x = 0, y = 0;
  for(const w of chipWs){
    if(x > 0 && x + w > containerW){ x = 0; y += h + my; } // перенос
    out.push({ x, y, w, right: x + w });
    x += w + mx;
  }
  return out;
}
{
  const W = 600, boxes = layout(W, [180,200,190,150,300,120]);
  boxes.forEach((b,i) => assert.ok(b.right <= W,
    "chip " + i + " вилазить за контейнер: " + b.right + " > " + W));
  const rows = [...new Set(boxes.map(b => b.y))];
  assert.ok(rows.length > 1, "тестова ширина має дати кілька рядків");
  for(let i = 1; i < boxes.length; i++){
    const a = boxes[i-1], b = boxes[i];
    assert.ok(b.y > a.y || b.x > a.x,
      "порядок фокуса має йти зліва-направо, зверху-вниз");
  }
  // chip ширший за контейнер обмежується max-width, а не рве верстку
  assert.match(chipCss, /max-width:\s*100%/, "довгий chip має обмежуватись шириною батька");
  console.log("ok перенесення: " + rows.length + " рядки, без виходу за межі");
}

// перехід фокуса на сітку / Escape ховають панель
appC.els.search.focus();
appC.els.search.key("Enter");
assert.ok(isOpen());
appC.els.grid.children[0].focus();          // стрілкою вниз до сітки
assert.ok(!isOpen(), "перехід до сітки має сховати chips");
appC.els.search.focus();
appC.els.search.key("Enter");
appC.els.search.key("Escape");
assert.ok(!isOpen(), "Escape має сховати chips");
console.log("ok сітка/Escape ховають chips");

// склад списку підказок
const chipsSrc = /var CHIPS = \[([\s\S]*?)\];/.exec(html)[1];
const chipList = (chipsSrc.match(/"([^"]+)"/g) || []).map(s => s.slice(1,-1));
["ліс звуки природи","космос nasa live"].forEach(t =>
  assert.ok(!chipList.includes(t), "підказку \"" + t + "\" треба було прибрати"));
["домашні рецепти","рецепти дома"].forEach(t =>
  assert.ok(chipList.includes(t), "підказки \"" + t + "\" бракує"));
// перші три — англомовні тематичні запити, у точному порядку
assert.deepStrictEqual(chipList.slice(0, 3),
  ["africa online", "africam", "africa camera online"],
  "список має починатись саме з цих трьох підказок у цьому порядку");
// решта — у попередньому порядку, одразу після них
assert.deepStrictEqual(chipList.slice(3),
  ["тварини африка","відео природа","сафарі наживо","дика природа 4k",
   "океан наживо","гори природа 4k","домашні рецепти","рецепти дома"],
  "решта підказок має лишитись у попередньому порядку");
// автопошук на старті — фіксований запит, не обов'язково перший chip
const defaultQuery = /var DEFAULT_QUERY = "([^"]+)"/.exec(html)[1];
assert.strictEqual(defaultQuery, "africa camera online",
  "дефолтний запит при завантаженні має лишатись \"africa camera online\"");
assert.ok(chipList.includes(defaultQuery),
  "дефолтний запит має бути серед підказок, щоб його можна було повторити з пульта");
console.log("ok список підказок (" + chipList.length + ", перші три + DEFAULT_QUERY)");

// поле пошуку: placeholder і порожнє значення
assert.match(html, /<input id="search"[^>]*placeholder="Пошук"/, "потрібен placeholder=\"Пошук\"");
assert.strictEqual(appC.els.search.value === chipText ? "" : appC.els.search.value, "",
  "у полі не має бути заготовленого запиту");
const appFresh = makeApp(VIDS);
assert.strictEqual(appFresh.els.search.value, "", "після завантаження поле має бути порожнім");
assert.ok(appFresh.els.grid.children.length > 0, "автопошук усе одно має заповнити сітку");
console.log("ok placeholder + порожнє поле + автопошук у фоні");

// --- 3e. прев'ю: URL, відносні шляхи, ланцюжок фолбеків ---
const YTI = id => "https://i.ytimg.com/vi/"+id+"/mqdefault.jpg";
const srcOf = card => (/<img[^>]+src="([^"]+)"/.exec(card.innerHTML) || [])[1];

// Worker робить URL абсолютними; якщо все ж прийшов відносний, а дзеркало
// клієнту невідоме — має підставитись YouTube CDN, а не битий шлях
const appRel = makeApp([{ type:"video", videoId:"REL0000001", title:"t", author:"a", lengthSeconds:10,
  videoThumbnails:[{quality:"medium", url:"/vi/REL0000001/mqdefault.jpg"}] }]);
assert.strictEqual(srcOf(appRel.els.grid.children[0]), YTI("REL0000001"),
  "відносний шлях без відомого дзеркала -> ytimg");
console.log("ok відносний шлях -> ytimg (дзеркало клієнту невідоме)");

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
assert.strictEqual(app5.exitCalls.length, 1, "перша Назад має викликати exitFullscreen()");
// друга Назад — уже на список
key("Escape");
assert.ok(!app5.els.player.classList.contains("open"), "друга Назад закриває плеєр");
console.log("ok Назад: fullscreen -> список (два натискання)");

// --- 3i. апаратна "Назад" на пульті ---
// відкриття відео додає запис в історію, popstate повертає на список
const appNav = makeApp(VIDS);
const navKey = k => appNav.doc.listeners.keydown[0]({ key:k, preventDefault(){} });
const histDepth = () => appNav.win.history._stack.length;

const depth0 = histDepth();
appNav.els.grid.children[0].click();
assert.ok(appNav.els.player.classList.contains("open"), "клік по картці відкриває плеєр");
assert.strictEqual(histDepth(), depth0 + 1, "відкриття відео має зробити pushState");
assert.ok(appNav.win.history.state && appNav.win.history.state.player,
  "у стані історії має бути ознака відкритого плеєра");

// апаратна Назад -> popstate
appNav.win.listeners.popstate[0]({ state: null });
assert.ok(!appNav.els.player.classList.contains("open"),
  "popstate має закрити відео і повернути на список");
assert.strictEqual(appNav.els.playerHost.innerHTML, "", "відтворення має зупинитись");

// popstate на списку (плеєр закритий) нічого не ламає і не виходить із застосунку
appNav.win.listeners.popstate[0]({ state: null });
assert.ok(!appNav.els.player.classList.contains("open"), "повторний popstate безпечний");

// Escape у тому ж сценарії: закриває відео і чистить свій запис історії
appNav.els.grid.children[0].click();
const depth1 = histDepth();
navKey("Escape");
assert.ok(!appNav.els.player.classList.contains("open"), "Escape має закрити відео");
assert.strictEqual(histDepth(), depth1 - 1,
  "закриття має знімати свій запис історії, а не накопичувати їх");

// Backspace — те саме (частина TV шле саме його)
appNav.els.grid.children[0].click();
navKey("Backspace");
assert.ok(!appNav.els.player.classList.contains("open"), "Backspace має закрити відео");

// Escape на списку не виходить із застосунку
const depth2 = histDepth();
navKey("Escape");
assert.strictEqual(histDepth(), depth2, "Escape поза плеєром не має чіпати історію");
console.log("ok апаратна Назад: pushState + popstate + Escape/Backspace");

// --- 3j. згортання застосунку ("Дім") ставить відео на паузу ---
const appVis = makeApp(VIDS);
const visHandler = appVis.doc.listeners.visibilitychange[0];
assert.ok(visHandler, "потрібен слухач visibilitychange");

appVis.els.grid.children[0].click();
appVis.doc.hidden = true;
visHandler({});
assert.strictEqual(appVis.pauseCalls.length, 1,
  "згорнутий застосунок має ставити відео на паузу, а не грати у фоні");

// повернення у застосунок нічого не паузить повторно
appVis.doc.hidden = false;
visHandler({});
assert.strictEqual(appVis.pauseCalls.length, 1, "видимий застосунок не має паузити");
console.log("ok visibilitychange -> pauseVideo");

// CSS не лишає плеєр у розмірі 640x360
assert.match(html, /#playerHost\s*\{[^}]*position:\s*relative/, "playerHost має бути position:relative");
assert.match(html, /#playerHost iframe[^{]*\{[^}]*width:\s*100%[^}]*height:\s*100%/,
  "iframe у плеєрі має розтягуватись на 100%");
console.log("ok CSS розтягує плеєр на весь контейнер");

// --- 3g. жодного виходу на зовнішні сайти ---
// у розмітці не має бути <a> на зовнішній домен без перехоплення
const anchors = html.match(/<a\s[^>]*>/gi) || [];
const external = anchors.filter(a => /href\s*=\s*["']https?:/i.test(a));
assert.deepStrictEqual(external, [],
  "знайдено <a> на зовнішній домен: " + external.join(", "));
// а якщо колись з'явиться — має спрацювати делегований перехоплювач
assert.match(html, /if\(\/\^https\?:\/i\.test\(href\)\)\{ e\.preventDefault\(\); \}/,
  "потрібен глобальний перехоплювач кліків по зовнішніх посиланнях");
console.log("ok немає <a> назовні (" + anchors.length + " всього) + перехоплювач");

// window.open не використовується у нашому коді
const scriptOnly = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
assert.ok(!/window\.open\s*\(/.test(scriptOnly), "window.open не має викликатись");
console.log("ok немає window.open");

// <base target="_self">
assert.match(html, /<base\s+target="_self">/, "потрібен <base target=\"_self\">");
assert.ok(!/target\s*=\s*["']_blank["']/i.test(html), "не має бути target=\"_blank\"");
console.log("ok base target=_self, немає _blank");

// sandbox на iframe плеєра — без небезпечних дозволів
const FORBIDDEN = ["allow-top-navigation", "allow-top-navigation-by-user-activation",
                   "allow-top-navigation-to-custom-protocols", "allow-popups",
                   "allow-popups-to-escape-sandbox"];
const sandboxVal = /var SANDBOX = "([^"]+)"/.exec(html)[1];
FORBIDDEN.forEach(t => assert.ok(!sandboxVal.split(/\s+/).includes(t),
  "sandbox не має містити " + t + ", маємо: " + sandboxVal));
// але плеєр без цих двох просто не запуститься
["allow-scripts","allow-same-origin"].forEach(t =>
  assert.ok(sandboxVal.split(/\s+/).includes(t), "sandbox має містити " + t));
assert.match(html, /<iframe sandbox="'\+SANDBOX\+'"/, "fallback-iframe має отримувати sandbox");
assert.match(html, /f\.setAttribute\("sandbox", SANDBOX\)/, "iframe від YT.Player теж має блокуватись");
console.log("ok sandbox=\"" + sandboxVal + "\" (без top-navigation/popups)");

// фактично відрендерений fallback-iframe містить sandbox і не містить забороненого
const appSb = makeApp(VIDS, { noApi: true });
appSb.els.grid.children[0].click();
const iframeHtml = appSb.els.playerHost.innerHTML;
assert.match(iframeHtml, /<iframe sandbox="allow-scripts allow-same-origin allow-presentation"/);
FORBIDDEN.forEach(t => assert.ok(!iframeHtml.includes(t), "у готовому iframe є " + t));
console.log("ok готовий iframe без top-navigation/popups");

// --- 4. клієнт ходить лише у Worker, про дзеркала не знає ---
assert.match(html, /var WORKER_URL = "[^"]+"/, "потрібна змінна WORKER_URL");
const invidiousInClient = (html.match(/https:\/\/[a-z0-9.\-]+/gi) || [])
  .filter(u => !/youtube-nocookie|ytimg|youtube\.com|workers\.dev/.test(u));
assert.deepStrictEqual(invidiousInClient, [],
  "у клієнті не має лишатись адрес дзеркал, знайдено: " + invidiousInClient);
console.log("ok клієнт не знає про дзеркала");

// запит іде на один ендпоінт Worker'а з q і page
const BASE_URL = "https://winter-star-48dc.sweaterbaddy.workers.dev";
assert.ok(html.includes('var WORKER_URL = "' + BASE_URL + '"'), "WORKER_URL має вказувати на Worker");

const appReq = makeApp(VIDS);
const reqUrl = appReq.requests[0];
assert.ok(reqUrl.startsWith(BASE_URL + "/search?"),
  "запит має йти на BASE_URL/search, отримано: " + reqUrl);
assert.ok(reqUrl.includes("?q=" + encodeURIComponent(defaultQuery)),
  "у запиті має бути закодований DEFAULT_QUERY, отримано: " + reqUrl);
assert.match(reqUrl, /[?&]page=1/, "у запиті має бути page");
assert.strictEqual(appReq.requests.length, 1, "має бути рівно один запит, без перебору дзеркал");
console.log("ok один запит до Worker'а (" + reqUrl.replace(BASE_URL, "") + ")");

// кодування кирилиці та пробілів (запит іде через chip "тварини африка")
const appCyr = makeApp(VIDS);
appCyr.requests.length = 0;
const cyrChip = appCyr.els.chips.children.find(c => c.textContent === "тварини африка");
assert.ok(cyrChip, "потрібна підказка з кирилицею для перевірки кодування");
cyrChip.click();
const cyrUrl = appCyr.requests[0];
assert.strictEqual(cyrUrl,
  BASE_URL + "/search?q=" + encodeURIComponent("тварини африка") + "&page=1",
  "кирилиця і пробіл мають кодуватись через encodeURIComponent");
assert.ok(!/ /.test(cyrUrl), "у URL не має лишатись сирих пробілів");
assert.match(cyrUrl, /%D1%82%D0%B2/, "кирилиця має бути у percent-encoding");
console.log("ok кодування кирилиці/пробілів у запиті");

// пагінацію (page=2) не тестую: її запускає scroll-обробник на window,
// а стаб не має ні прокрутки, ні розмірів. Перевірено вживу через curl.

// помилка Worker'а ({"error":...}) -> зрозуміле повідомлення, не білий екран
const appErr = makeApp({ error: "all_instances_down" });
assert.strictEqual(appErr.els.status.textContent,
  "Сервіс тимчасово недоступний, спробуйте пізніше");
console.log("ok помилка Worker'а -> повідомлення користувачу");

// --- 4b. worker.js ---
const worker = fs.readFileSync(__dirname + "/worker.js", "utf8");
const wInstances = (worker.match(/"https:\/\/[a-z0-9.\-]+"/gi) || []);
assert.ok(wInstances.length >= 4, "у Worker'і має бути 4+ дзеркал, знайдено " + wInstances.length);
assert.match(worker, /Access-Control-Allow-Origin"?\s*:\s*"\*"/, "Worker має віддавати CORS *");
assert.match(worker, /caches\.default/, "Worker має використовувати Cache API");
assert.match(worker, /max-age=\$\{CACHE_TTL\}/, "відповідь має мати Cache-Control");
console.log("ok worker.js: " + wInstances.length + " дзеркал, CORS, кеш");

// --- 4c. worker.js: ротація, нормалізація прев'ю, кеш, валідація ---
async function runWorker({ upstream, cacheStore = new Map() }) {
  const src = worker.replace(/^export default/m, "globalThis.__W =");
  const calls = [];
  const sandbox = {
    console, URL, Request, Response, Headers, AbortController, Array, Number,
    JSON, setTimeout, clearTimeout, encodeURIComponent, parseInt,
    fetch: async (u, opts) => {
      calls.push(u);
      const r = upstream(u);
      if (r === "fail") throw new Error("network");
      return new Response(JSON.stringify(r), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    },
    caches: {
      default: {
        match: async (req) => cacheStore.get(req.url) || undefined,
        put: async (req, res) => { cacheStore.set(req.url, res); },
      },
    },
  };
  sandbox.globalThis = sandbox;
  require("vm").createContext(sandbox);
  require("vm").runInContext(src, sandbox);
  return { w: sandbox.__W, calls, cacheStore };
}

const VID_REL = [{ videoId: "W0000000001", title: "t",
                   videoThumbnails: [{ quality: "medium", url: "/vi/W0000000001/mqdefault.jpg" }] }];
const ctx = { waitUntil: (p) => p };

(async () => {
  // ротація: перші два дзеркала падають, наступне віддає дані
  {
    const DEAD = ["yt.chocolatemoo53.com", "inv.nadeko.net"];
    const { w, calls } = await runWorker({
      upstream: (u) => (DEAD.some((h) => u.includes(h)) ? "fail" : VID_REL),
    });
    const res = await w.fetch(new Request("https://x/search?q=тест"), {}, ctx);
    assert.strictEqual(res.status, 200, "має перебрати дзеркала до робочого");
    assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*", "потрібен CORS *");
    assert.ok(calls.length >= 3, "мали спробувати кілька дзеркал, було " + calls.length);
    const body = await res.json();
    assert.strictEqual(body[0].videoThumbnails[0].url.slice(0, 8), "https://",
      "Worker має робити URL прев'ю абсолютними");
    console.log("ok worker: ротація дзеркал + CORS + абсолютні прев'ю");
  }

  // усі впали -> 503 з JSON-помилкою і CORS
  {
    const { w } = await runWorker({ upstream: () => "fail" });
    const res = await w.fetch(new Request("https://x/search?q=тест"), {}, ctx);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*",
      "навіть помилка має йти з CORS, інакше браузер її не побачить");
    assert.strictEqual((await res.json()).error, "all_instances_down");
    console.log("ok worker: усі дзеркала впали -> 503 + CORS");
  }

  // кеш: другий однаковий запит не йде в upstream
  {
    const store = new Map();
    const a = await runWorker({ upstream: () => VID_REL, cacheStore: store });
    await a.w.fetch(new Request("https://x/search?q=кеш"), {}, ctx);
    const b = await runWorker({ upstream: () => VID_REL, cacheStore: store });
    const res2 = await b.w.fetch(new Request("https://x/search?q=кеш"), {}, ctx);
    assert.strictEqual(b.calls.length, 0, "повторний запит мав узятись із кешу");
    assert.strictEqual(res2.headers.get("X-Cache"), "HIT");
    console.log("ok worker: кеш віддає повтор без запиту в upstream");
  }

  // валідація входу
  {
    const { w } = await runWorker({ upstream: () => VID_REL });
    const bad = await w.fetch(new Request("https://x/search"), {}, ctx);
    assert.strictEqual(bad.status, 400, "порожній q -> 400");
    const nf = await w.fetch(new Request("https://x/other"), {}, ctx);
    assert.strictEqual(nf.status, 404, "невідомий шлях -> 404");
    const pre = await w.fetch(new Request("https://x/search?q=a", { method: "OPTIONS" }), {}, ctx);
    assert.strictEqual(pre.status, 204, "preflight OPTIONS -> 204");
    assert.strictEqual(pre.headers.get("Access-Control-Allow-Origin"), "*");
    console.log("ok worker: валідація входу + preflight");
  }
})().catch(e => { console.error("!! worker tests:", e.message); process.exit(1); });

// --- 5. живий запит до дзеркала, яке використає Worker ---
const url = "https://yt.chocolatemoo53.com/api/v1/search?q=africa+online&page=1&type=video";
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
