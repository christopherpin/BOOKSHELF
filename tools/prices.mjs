// Looks up buying options for every book in your cart (shelf.cart in data/shelf.json) and writes them to
// data/cart-prices.json for the Cart tab: { updated, books: { id: { checked, offers: [{ store, price, url, note }] } } }.
// Prices come from Bing Shopping, which lists Amazon, AbeBooks, ThriftBooks, Walmart, eBay and other shops;
// most shops' own sites turn away requests from GitHub's servers, so Bing is the one that answers.
// It runs only when the Check prices button asks (data/cart-refresh.json), and looks up each book in the cart
// once: one Bing Shopping page per book.
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

// the same tidying the cover search does: the title without notes in brackets or a subtitle, the first author
const plain = t => t.replace(/\s*\([^)]*\)/g, "").trim() || t;
const firstAuthor = a => a.replace(/\([^)]*\)/g, " ").replace(/\bet al\.?/g, " ").split(/\s*(?:&|\/|;|,|\band\b|\bwith\b)\s*/i).map(s => s.trim()).find(Boolean) || a;
const core = t => words(plain(t).split(":")[0]).replace(/^(the|a|an) /, "");
const surname = a => words(firstAuthor(a)).split(" ").pop();
// a listing is this book when its title starts with the book's title, and it isn't a summary, guide or recording
const NOT_THE_BOOK = /\b(e ?book|kindle|nook|summary|study guide|analysis|sparknotes|cliffs ?notes|workbook|audio ?(book|cd)|mp3|cd|dvd|blu ?ray|poster|t ?shirt|journal|notebook|calendar|bookmark|puzzle|sticker)\b/;
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
// shops that sell only ebooks or audiobooks, or don't sell to readers, are left out
const NOT_A_SHOP = /^(e-?books?|audiobooks?.*|vitalsource|kobo|audible|libro\.?fm|chirp|google play.*|apple books|ebooks\.com|faire|solutioninn|scribd)$/i;
const store = s => STORES[s.toLowerCase().trim()] || s.trim().replace(/\.com$/i, "").replace(/ - .*$/, "");

// Bing Shopping: the shop cards along the top (each a shop's own offer) and the product grid below
async function bing(b, again = true){
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
    if (title && price > 0 && seller && url && isBook(b, text(title)) && !NOT_A_SHOP.test(store(seller))) out.push({ store: store(seller), price, url, note: /used/i.test(label) ? "used" : /used/i.test(title) ? "used" : "" });
  }
  for (const item of html.split('class="br-item ').slice(1)){
    const c = item.slice(0, 20000);
    const goid = c.match(/data-offerId="(\d+)"/)?.[1];
    const title = attr(c.match(/class="br-title[^"]*"[^>]*>(?:<[^>]*>)*([^<]+)/)?.[1] || c.match(/<img [^>]*alt="([^"]+)"/)?.[1] || "");
    const pi = c.indexOf("pd-price");
    const price = pi < 0 ? NaN : num(c.slice(pi, pi + 600).match(/\$([\d,]+\.\d\d)/)?.[1]);
    const seller = text(c.match(/class="resp-one-line br-seller"[^>]*>([^<]*)/)?.[1] || c.match(/class="br-sellerName[^"]*"[^>]*>(?:<[^>]*>)*([^<]+)/)?.[1] || "");
    if (!goid || !(price > 0) || !seller || NOT_A_SHOP.test(store(seller)) || !isBook(b, text(title).replace(/ - [^-]*$/, ""))) continue;
    out.push({ store: store(seller), price, url: "https://www.bing.com/shop/productdetails?" + new URLSearchParams({ q, goid }), note: "" });
  }
  console.log("  bing:", html.length, "bytes,", out.length, "offers");
  // now and then Bing answers with a page with no shop results on it; one more try after a pause
  if (!out.length && again){ await sleep(6000); return bing(b, false); }
  return out;
}

const now = new Date().toISOString();
const result = { updated: now, books: {} };
for (const id of cart){
  const b = books.get(id);
  console.log(b.title, "·", b.author);
  const offers = [];
  try{ offers.push(...await bing(b)); }catch(e){ console.log("   bing failed:", e.message); }
  await sleep(1500);
  // keep the cheapest offer from each shop
  const best = {};
  for (const o of offers) if (!best[o.store] || o.price < best[o.store].price) best[o.store] = o;
  const kept = Object.values(best).sort((a, z) => a.price - z.price);
  for (const o of kept) console.log(`  $${o.price.toFixed(2)}  ${o.store}${o.note ? " (" + o.note + ")" : ""}`);
  // a lookup that found nothing keeps the last prices rather than wiping them
  result.books[id] = kept.length || !old.books?.[id] ? { checked: now, offers: kept } : old.books[id];
}
fs.writeFileSync("data/cart-prices.json", JSON.stringify(result, null, 1) + "\n");
console.log(`${cart.length} books priced`);
