// Looks up buying options for every book in your cart (shelf.cart in data/shelf.json) and writes them to
// data/cart-prices.json for the Cart tab: { updated, books: { id: { checked, offers: [{ store, price, url, note }] } } }.
// Prices come from Bing Shopping (which lists Amazon, ThriftBooks, Walmart, eBay and other shops) and AbeBooks;
// most shops' own sites turn away requests from GitHub's servers, so these two are the ones that answer.
// A run prices only books that have no prices yet, unless the Refresh prices button asked for a fresh look
// (data/cart-refresh.json newer than the last run) or it's run by hand with "refresh" ticked.
import fs from "node:fs";

const BOOKS = new Function(fs.readFileSync("books.js", "utf8") + "; return BOOKS;")();
const fold = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const bookId = (title, author) => fold(title + " " + author).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const words = s => fold(s).replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const read = (f, d) => { try{ return JSON.parse(fs.readFileSync(f, "utf8")); }catch{ return d; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const shelf = read("data/shelf.json", {});
const books = new Map([...BOOKS.map(b => ({ ...b, id: bookId(b.title, b.author) })), ...(shelf.owned || [])].map(b => [b.id, b]));
const cart = (shelf.cart || []).filter(id => books.has(id));
const old = read("data/cart-prices.json", { books: {} });
const asked = read("data/cart-refresh.json", {}).requested;
const refresh = !!process.env.REFRESH || (asked && (!old.updated || asked > old.updated));
const todo = cart.filter(id => refresh || !old.books?.[id]);

// the same tidying the cover search does: the title without notes in brackets or a subtitle, the first author
const plain = t => t.replace(/\s*\([^)]*\)/g, "").trim() || t;
const firstAuthor = a => a.replace(/\([^)]*\)/g, " ").replace(/\bet al\.?/g, " ").split(/\s*(?:&|\/|;|,|\band\b|\bwith\b)\s*/i).map(s => s.trim()).find(Boolean) || a;
const core = t => words(plain(t).split(":")[0]).replace(/^(the|a|an) /, "");
const surname = a => words(firstAuthor(a)).split(" ").pop();
// a listing is this book when its title starts with the book's title, and it isn't a summary, guide or recording
const NOT_THE_BOOK = /\b(summary|study guide|analysis|sparknotes|cliffs ?notes|workbook|audio ?(book|cd)|mp3|cd|dvd|blu ?ray|poster|t ?shirt|journal|notebook|calendar|bookmark|puzzle|sticker)\b/;
const isBook = (b, title) => { const t = words(title).replace(/^(the|a|an) /, ""); return t.startsWith(core(b.title)) && !NOT_THE_BOOK.test(t); };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
async function page(url){
  for (let i = 0; i < 3; i++){
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (r?.ok) return r.text();
    await sleep(2000 * (i + 1));
  }
  return "";
}
const text = s => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#183;/g, "·").replace(/\s+/g, " ").trim();
const attr = s => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
const num = s => s ? +s.replace(/,/g, "") : NaN;
const STORES = { "amazon.com": "Amazon", "thriftbooks.com": "ThriftBooks", "walmart.com": "Walmart", "ebay": "eBay", "barnesandnoble.com": "Barnes & Noble",
  "barnes & noble": "Barnes & Noble", "booksamillion.com": "Books-A-Million", "target.com": "Target", "abebooks": "AbeBooks", "biblio.com": "Biblio", "alibris": "Alibris",
  "bookshop.org": "Bookshop.org", "powells.com": "Powell's", "betterworldbooks.com": "Better World Books", "better world books": "Better World Books" };
const store = s => STORES[s.toLowerCase().trim()] || s.trim().replace(/\.com$/i, "").replace(/ - .*$/, "");

// Bing Shopping: the shop cards along the top (each a shop's own offer) and the product grid below
async function bing(b){
  const q = `${plain(b.title)} ${firstAuthor(b.author)} book`;
  const html = await page("https://www.bing.com/shop?" + new URLSearchParams({ q }));
  const out = [];
  for (const card of html.split('class="br-gOffCard').slice(1)){
    const c = card.slice(0, 12000);
    const title = attr(c.match(/class="br-offTtl[^"]*">(?:<span title="([^"]*)")?([\s\S]*?)<\/div>/)?.slice(1).find(Boolean) || "");
    const price = num(c.match(/class="br-price">\$([\d,]+\.\d\d)/)?.[1]);
    const seller = text(c.match(/class="br-offSlrTxt">([^<]*)/)?.[1] || "");
    const label = text(c.match(/class="br-offSecLbl"[^>]*>([\s\S]*?)<\/div><\/div>/)?.[1] || "");
    let url = attr(c.match(/class="br-offLink"[^>]*href="([^"]+)"/)?.[1] || "");
    // the card links through a Bing ad redirect; the shop's own address is inside it
    const u = url.match(/[?&]u=([^&]+)/)?.[1];
    if (u) try{ url = decodeURIComponent(Buffer.from(u, "base64").toString("utf8")); }catch{}
    if (title && price > 0 && seller && url && isBook(b, text(title))) out.push({ store: store(seller), price, url, note: /used/i.test(label) ? "used" : /used/i.test(title) ? "used" : "" });
  }
  for (const item of html.split('class="br-item ').slice(1)){
    const c = item.slice(0, 20000);
    const goid = c.match(/data-offerId="(\d+)"/)?.[1];
    const title = attr(c.match(/class="br-title[^"]*"[^>]*>(?:<[^>]*>)*([^<]+)/)?.[1] || c.match(/<img [^>]*alt="([^"]+)"/)?.[1] || "");
    const pi = c.indexOf("pd-price");
    const price = pi < 0 ? NaN : num(c.slice(pi, pi + 600).match(/\$([\d,]+\.\d\d)/)?.[1]);
    const seller = text(c.match(/class="resp-one-line br-seller"[^>]*>([^<]*)/)?.[1] || c.match(/class="br-sellerName[^"]*"[^>]*>(?:<[^>]*>)*([^<]+)/)?.[1] || "");
    if (!goid || !(price > 0) || !seller || !isBook(b, text(title).replace(/ - [^-]*$/, ""))) continue;
    out.push({ store: store(seller), price, url: "https://www.bing.com/shop/productdetails?" + new URLSearchParams({ q, goid }), note: "" });
  }
  if (process.env.DEBUG) console.log("  bing:", html.length, "bytes,", out.length, "offers");
  return out;
}

// AbeBooks: the cheapest copies, new and used, with shipping added when it's shown
async function abe(b){
  const html = await page("https://www.abebooks.com/servlet/SearchResults?" + new URLSearchParams({ tn: plain(b.title).split(":")[0], an: firstAuthor(b.author), sortby: "17", cm_sp: "SearchF-_-topnav-_-Results" }));
  const out = [];
  for (const li of html.split('data-test-id="listing-item-').slice(1)){
    const c = li.slice(0, 30000);
    const title = text(c.match(/data-test-id="listing-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1] || "");
    const author = text(c.match(/data-test-id="listing-author"[^>]*>([\s\S]*?)<\/p>/)?.[1] || "");
    const href = c.match(/data-test-id="listing-title-link"[^>]*href="([^"]+)"/)?.[1] || c.match(/href="([^"]+\/bd)"/)?.[1];
    const price = num(c.match(/data-test-id="listing-price">US\$ ([\d,]+(?:\.\d\d)?)/)?.[1]);
    const ship = c.match(/data-test-id="item-shipping-price-\d+"[\s\S]{0,600}?US\$ ([\d,]+\.\d\d)/)?.[1];
    const cond = text(c.match(/data-test-id="listing-condition">([^<]*)/)?.[1] || "");
    if (!href || !(price > 0) || !isBook(b, title) || !words(author).includes(surname(b.author))) continue;
    out.push({ store: "AbeBooks", price: Math.round((price + (num(ship) || 0)) * 100) / 100, url: "https://www.abebooks.com" + attr(href), note: (/new/i.test(cond) ? "new" : "used") + (ship ? " · shipped" : "") });
  }
  if (process.env.DEBUG) console.log("  abebooks:", html.length, "bytes,", out.length, "offers");
  return out;
}

const now = new Date().toISOString();
const result = { updated: refresh || todo.length ? now : old.updated, books: {} };
for (const id of cart) if (old.books?.[id] && !todo.includes(id)) result.books[id] = old.books[id];
for (const id of todo){
  const b = books.get(id);
  console.log(b.title, "·", b.author);
  const offers = [];
  for (const find of [bing, abe]){
    try{ offers.push(...await find(b)); }catch(e){ console.log("  ", find.name, "failed:", e.message); }
    await sleep(1500);
  }
  // keep the cheapest offer from each shop
  const best = {};
  for (const o of offers) if (!best[o.store] || o.price < best[o.store].price) best[o.store] = o;
  const kept = Object.values(best).sort((a, z) => a.price - z.price);
  for (const o of kept) console.log(`  $${o.price.toFixed(2)}  ${o.store}${o.note ? " (" + o.note + ")" : ""}`);
  // a lookup that found nothing keeps the last prices rather than wiping them
  result.books[id] = kept.length || !old.books?.[id] ? { checked: now, offers: kept } : old.books[id];
}
fs.writeFileSync("data/cart-prices.json", JSON.stringify(result, null, 1) + "\n");
console.log(`${todo.length} of ${cart.length} books priced${refresh ? " (refresh)" : ""}`);
