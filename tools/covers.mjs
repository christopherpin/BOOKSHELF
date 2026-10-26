// Finds a cover for every book on the list and every book you own, and saves it to covers/<id>.jpg
// (500px wide), then writes covers.js listing them for the site. Looks in Apple Books first (clean,
// large art), then Open Library, then Google Books; data/cover-overrides.json ({ id: imageUrl }) wins
// over all of them, for any book that comes out wrong. A cover once saved is kept: only an override or a
// run by hand with "refresh" ticked replaces it.
import fs from "node:fs";
import sharp from "sharp";
import crypto from "node:crypto";

const BOOKS = new Function(fs.readFileSync("books.js", "utf8") + "; return BOOKS;")();
const fold = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const bookId = (title, author) => fold(title + " " + author).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const words = s => fold(s).replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const read = (f, d) => { try{ return JSON.parse(fs.readFileSync(f, "utf8")); }catch{ return d; } };

const owned = read("data/shelf.json", {}).owned || [];
const books = [...BOOKS.map(b => ({ ...b, id: bookId(b.title, b.author) })), ...owned];
const overrides = read("data/cover-overrides.json", {});
const refresh = !!process.env.REFRESH;
fs.mkdirSync("covers", { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// each service allows only so many searches a minute (Apple Books about 20), so searches to one host are
// spaced out; a host that says "slow down" (403/429) is left alone for the rest of the run. A book whose
// lookup failed (rather than found nothing) isn't counted as not found, so the next run tries it again.
const lastCall = {}, gap = { "itunes.apple.com": 3200 }, down = new Set();
let failed = false;
async function json(url){
  const host = new URL(url).host;
  for (let i = 0; i < 3 && !down.has(host); i++){
    const wait = (lastCall[host] || 0) + (gap[host] || 1000) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[host] = Date.now();
    const r = await fetch(url, { headers: { "User-Agent": "bookshelf-covers (github.com/christopherpin/BOOKSHELF)" } }).catch(e => ({ ok: false, status: e.message }));
    if (r.ok){ const j = await r.json().catch(() => null); if (j) return j; }
    console.log("  ", host, r.status);
    if (r.status === 403 || r.status === 429){ down.add(host); console.log("  ", host, "is refusing searches; skipping it for the rest of this run"); }
    else await sleep(1500 * (i + 1));
  }
  failed = true;
  return null;
}
// the main part of a title, without a subtitle, so "Frederick Douglass: Prophet of Freedom" matches "Frederick Douglass"
const core = t => words(t.split(":")[0]).replace(/^(the|a|an) /, "");
const titleOk = (want, got) => { const a = core(want), b = core(got || ""); return !!b && (b.startsWith(a) || a.startsWith(b)); };
const surname = a => words(a).split(" ").pop();
const authorOk = (want, got) => words(got || "").includes(surname(want));
// what to search for: the title without notes in brackets, and the first person named, without "(Ed.)" and the like,
// so "Classics of Free Thought · Paul Blanshard (Ed.)" or "Rethinking the Modular · Alexander & May" can be found
const plain = t => t.replace(/\s*\([^)]*\)/g, "").trim() || t;
const firstAuthor = a => a.replace(/\([^)]*\)/g, " ").replace(/\bet al\.?/g, " ").split(/\s*(?:&|\/|;|,|\band\b|\bwith\b)\s*/i).map(s => s.trim()).find(Boolean) || a;
const searchable = b => ({ ...b, title: plain(b.title), author: firstAuthor(b.author) });

async function apple(b){
  const j = await json("https://itunes.apple.com/search?" + new URLSearchParams({ term: b.title + " " + b.author, media: "ebook", entity: "ebook", limit: "15" }));
  const hit = (j?.results || []).find(r => titleOk(b.title, r.trackName) && authorOk(b.author, r.artistName) && r.artworkUrl100);
  return hit && hit.artworkUrl100.replace(/\/\d+x\d+bb\./, "/1000x1000bb.");
}
async function openLibrary(b){
  const j = await json("https://openlibrary.org/search.json?" + new URLSearchParams({ title: b.title, author: b.author, fields: "title,author_name,cover_i", limit: "10" }));
  const hit = (j?.docs || []).find(d => d.cover_i && titleOk(b.title, d.title) && (d.author_name || []).some(a => authorOk(b.author, a)));
  return hit && `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg?default=false`;
}
// last of all, the same Open Library lookup the site does live for a book with no saved cover, so whatever
// cover you've been seeing for it gets saved and stays put
async function asOnSite(b){
  const j = await json("https://openlibrary.org/search.json?" + new URLSearchParams({ title: b.title, author: b.author, fields: "cover_i", limit: "5" }));
  const hit = (j?.docs || []).find(d => d.cover_i);
  return hit && `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg?default=false`;
}
// Open Library's everyday search ("q"), which forgives the punctuation and joint authors the title/author
// fields choke on: the plain title and the first author's surname, matched on the title
async function openLibraryLoose(b){
  const j = await json("https://openlibrary.org/search.json?" + new URLSearchParams({ q: b.title + " " + surname(b.author), fields: "title,cover_i", limit: "10" }));
  const hit = (j?.docs || []).find(d => d.cover_i && titleOk(b.title, d.title));
  return hit && `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg?default=false`;
}
async function google(b){
  const j = await json("https://www.googleapis.com/books/v1/volumes?" + new URLSearchParams({ q: `intitle:${b.title} inauthor:${surname(b.author)}`, maxResults: "10" }));
  const hit = (j?.items || []).map(i => i.volumeInfo).find(v => v.imageLinks?.thumbnail && titleOk(b.title, v.title) && (v.authors || []).some(a => authorOk(b.author, a)));
  return hit && hit.imageLinks.thumbnail.replace("http://", "https://").replace("&edge=curl", "") + "&fife=w800";
}
async function save(url, file){
  const r = await fetch(url).catch(() => null);
  if (!r?.ok) return false;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 4000) return false; // a blank placeholder, not a cover
  try{ await sharp(buf).resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(file); }
  catch{ return false; }
  return true;
}

// books nothing was found for, by this script's version: they're tried again only when the script changes
// (a better search) or on a refresh, so a run after each shelf change takes seconds instead of half an hour
const version = crypto.createHash("md5").update(fs.readFileSync("tools/covers.mjs")).digest("hex").slice(0, 8);
const notFound = refresh ? {} : read("covers/missing.json", {});
const missing = [];
for (const b of books){
  const file = `covers/${b.id}.jpg`;
  if (fs.existsSync(file) && !refresh && !overrides[b.id]) continue;
  if (notFound[b.id] === version && !overrides[b.id]){ missing.push(b.title + " · " + b.author); continue; }
  let done = false;
  failed = false;
  for (const find of [async () => overrides[b.id], apple, openLibrary, google, openLibraryLoose, async () => asOnSite(b)]){
    const url = await find(searchable(b)).catch(() => null);
    if (url && await save(url, file)){ console.log("✓", b.title, "←", url); done = true; break; }
  }
  if (!done){ missing.push(b.title + " · " + b.author); if (!failed) notFound[b.id] = version; }
  else delete notFound[b.id];
  await sleep(300);
}

// covers.js: { id: "covers/<id>.jpg?<hash>" }, so a cover that changes is fetched again
const COVERS = {};
for (const b of books){
  const file = `covers/${b.id}.jpg`;
  if (fs.existsSync(file)) COVERS[b.id] = file + "?" + crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}
for (const id of Object.keys(notFound)) if (fs.existsSync(`covers/${id}.jpg`) || !books.some(b => b.id === id)) delete notFound[id];
fs.writeFileSync("covers/missing.json", JSON.stringify(notFound, null, 1) + "\n");
fs.writeFileSync("covers.js", "// written by tools/covers.mjs: the saved cover for each book\nconst COVERS = " + JSON.stringify(COVERS, null, 1) + ";\n");
console.log(`${Object.keys(COVERS).length} of ${books.length} books have covers`);
if (missing.length) console.log("No cover found for:\n  " + missing.join("\n  "));
