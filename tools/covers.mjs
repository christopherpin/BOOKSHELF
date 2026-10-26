// Finds a cover for every book on the list and every book you own, and saves it to covers/<id>.jpg
// (500px wide), then writes covers.js listing them for the site. Looks in Apple Books first (clean,
// large art), then Open Library, then Google Books; data/cover-overrides.json ({ id: imageUrl }) wins
// over all of them, for any book that comes out wrong.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
async function json(url){
  for (let i = 0; i < 3; i++){
    const r = await fetch(url, { headers: { "User-Agent": "bookshelf-covers (github.com/christopherpin/BOOKSHELF)" } }).catch(() => null);
    if (r?.ok) return r.json();
    await sleep(1500 * (i + 1));
  }
  return null;
}
// the main part of a title, without a subtitle, so "Frederick Douglass: Prophet of Freedom" matches "Frederick Douglass"
const core = t => words(t.split(":")[0]).replace(/^(the|a|an) /, "");
const titleOk = (want, got) => { const a = core(want), b = core(got || ""); return !!b && (b.startsWith(a) || a.startsWith(b)); };
const surname = a => words(a).split(" ").pop();
const authorOk = (want, got) => words(got || "").includes(surname(want));

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
  fs.writeFileSync(file + ".src", buf);
  try{ execFileSync("convert", [file + ".src", "-resize", "500x", "-strip", "-quality", "82", file]); }
  finally{ fs.rmSync(file + ".src", { force: true }); }
  return true;
}

const missing = [];
for (const b of books){
  const file = `covers/${b.id}.jpg`;
  if (fs.existsSync(file) && !refresh && !overrides[b.id]) continue;
  let done = false;
  for (const find of [async () => overrides[b.id], apple, openLibrary, google]){
    const url = await find(b).catch(() => null);
    if (url && await save(url, file)){ console.log("✓", b.title, "←", url); done = true; break; }
  }
  if (!done) missing.push(b.title + " · " + b.author);
  await sleep(300);
}

// covers.js: { id: "covers/<id>.jpg?<hash>" }, so a cover that changes is fetched again
const COVERS = {};
for (const b of books){
  const file = `covers/${b.id}.jpg`;
  if (fs.existsSync(file)) COVERS[b.id] = file + "?" + crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}
fs.writeFileSync("covers.js", "// written by tools/covers.mjs: the saved cover for each book\nconst COVERS = " + JSON.stringify(COVERS, null, 1) + ";\n");
console.log(`${Object.keys(COVERS).length} of ${books.length} books have covers`);
if (missing.length) console.log("No cover found for:\n  " + missing.join("\n  "));
