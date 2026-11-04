"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config.js");
const {logText} = require("./logtext.js");
const itemswf = require("./itemswf.js");
const cdn = require("./cdn.js");

// accounts requires defpacks, which requires this: ask for it when it is
// needed, not while the modules are still loading (a cycle)
const accounts = () => require("./accounts.js");

// the Jamaa Journal's pages, as the staff make them (the Journals page): a
// picture and a title each, shown in the game's newspaper (newspaper.*, the
// news button) beside the official ones. a page is one page-media SWF (the
// pictures become one-frame movies, lib/itemswf.js) that the game loads by
// media id; the pages are told to the game in the newspaper defPack (1065)
// through lib/defpacks.js, listed by GenericListXtCommManager's list 627
// (lib/world.js gl), and pushed whole at every change ("xjy"). a player's
// "seen" times (newspaperDefs at login, "nps" while playing) decide which
// pages still carry their "new" burst.

const DEF_ID_BASE = 0; // a page's newspaper def id: its 0-based place in the paper
const MEDIA_ID_BASE = 50000; // a page's picture's media id
const ICON_MEDIA_ID_BASE = 60000; // the strip's small picture of a page
const PAGE_STAND = 600; // the page picture's greater side, in pixels
const MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const DIR = path.join(config.dataDir, "journal");
const SCHEMA = "CREATE TABLE IF NOT EXISTS journal_pages (num INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL)";

let pages = []; // {num, title, file, at, by}, oldest first
const swfCache = new Map(); // "<num>:<kind>" -> the page's movie
const tellers = []; // lib/world.js's connect: one per server run

const fileOf = name => path.join(DIR, name);

const load = () => {
  accounts().database().exec(SCHEMA);
  pages = accounts().database().prepare("SELECT * FROM journal_pages ORDER BY num").all()
    .filter(row => fs.existsSync(fileOf(row.file)));
  if (pages.length) {
    console.log(`[journals] ${logText(pages.length)} pages`);
  }
};

const list = () => pages.map((row, index) => ({num: row.num, title: row.title, at: row.at, by: row.by,
  defId: DEF_ID_BASE + index, mediaId: MEDIA_ID_BASE + row.num, iconMediaId: ICON_MEDIA_ID_BASE + row.num}));

const entries = () => list().map(page => page.defId);

// the rows the newspaper's defPack carries (one per page), the fields the
// official ones have (newspaper.NewspaperManager.onDefsLoaded)
const defRows = () => list().map(page => ({
  id: page.defId,
  name: page.title,
  pageMediaRefId: page.mediaId,
  iconMediaRefId: page.iconMediaId,
  giftType: "0",
  giftRefId: "0",
  amount: "0",
  country: "",
  availabilityStartTime: page.at,
  availabilityEndTime: "0",
  membersOnly: "0",
}));

const pictureOf = num => {
  const row = pages.find(page => page.num === Number(num));
  if (!row) {
    return null;
  }
  try {
    return fs.readFileSync(fileOf(row.file));
  }
  catch (err) {
    return null;
  }
};

// the strip's picture of a page, when one was given; else the page's own,
// which the game shrinks
const iconPictureOf = num => {
  const row = pages.find(page => page.num === Number(num));
  if (!row) {
    return null;
  }
  try {
    if (fs.existsSync(path.join(DIR, `${row.num}-icon.png`))) {
      return fs.readFileSync(path.join(DIR, `${row.num}-icon.png`));
    }
  }
  catch (err) {}
  return pictureOf(num);
};

// the page as the movie the game draws: built from the picture once, kept
// while the page exists
const movieOf = num => {
  const key = `${num}:page`;
  if (swfCache.has(key)) {
    return swfCache.get(key);
  }
  const picture = pictureOf(num);
  if (!picture) {
    return null;
  }
  const image = itemswf.fromPicture({type: "png", data: picture});
  if (!image) {
    return null;
  }
  const movie = itemswf.build(image, PAGE_STAND);
  if (movie) {
    swfCache.set(key, movie);
  }
  return movie;
};

const iconMovieOf = num => {
  const key = `${num}:icon`;
  if (swfCache.has(key)) {
    return swfCache.get(key);
  }
  const picture = iconPictureOf(num);
  if (!picture) {
    return null;
  }
  const image = itemswf.fromPicture({type: "png", data: picture});
  if (!image) {
    return null;
  }
  const movie = itemswf.build(image, 140);
  if (movie) {
    swfCache.set(key, movie);
  }
  return movie;
};

// the media file a request for this page is answered with, when it is one:
// {mediaId, body}, else null (lib/http.js, beside the badge files)
const mediaFor = relPath => {
  for (const page of list()) {
    if (relPath === cdn.hashedPath(`media/${page.mediaId}`)) {
      const movie = movieOf(page.num);
      if (movie) {
        console.log(`[journals] a page's picture served (${page.num})`);
      }
      return movie && {mediaId: page.mediaId, body: movie};
    }
    if (relPath === cdn.hashedPath(`media/${page.iconMediaId}`)) {
      const movie = iconMovieOf(page.num);
      if (movie) {
        console.log(`[journals] a page's icon served (${page.num})`);
      }
      return movie && {mediaId: page.iconMediaId, body: movie};
    }
  }
  return null;
};

const add = (title, pageBody, iconBody, by) => {
  title = String(title || "").trim().slice(0, 60);
  if (!title) {
    return {error: "Give the page a title."};
  }
  if (!Buffer.isBuffer(pageBody) || pageBody.length === 0) {
    return {error: "No page picture came."};
  }
  if (pageBody.length > MAX_BYTES || (Buffer.isBuffer(iconBody) && iconBody.length > MAX_BYTES)) {
    return {error: `That picture is too big: ${Math.round(MAX_BYTES / 1048576)} MB at most.`};
  }
  if (!pageBody.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {error: "The page is not a PNG picture."};
  }
  if (Buffer.isBuffer(iconBody) && iconBody.length > 0 && !iconBody.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {error: "The icon is not a PNG picture."};
  }
  fs.mkdirSync(DIR, {recursive: true});
  const at = Math.floor(Date.now() / 1000);
  const result = accounts().database().prepare("INSERT INTO journal_pages (title, file, at, by) VALUES (?, ?, ?, ?)")
    .run(title, "", at, by);
  const num = Number(result.lastInsertRowid);
  fs.writeFileSync(fileOf(`${num}.png`), pageBody);
  if (Buffer.isBuffer(iconBody) && iconBody.length > 0) {
    fs.writeFileSync(path.join(DIR, `${num}-icon.png`), iconBody);
  }
  accounts().database().prepare("UPDATE journal_pages SET file = ? WHERE num = ?").run(`${num}.png`, num);
  pages = accounts().database().prepare("SELECT * FROM journal_pages ORDER BY num").all();
  require("./defpacks.js").journalsChanged();
  console.log(`[journals] ${logText(by)} added the page ${logText(title)} (${num})`);
  return {ok: true, num};
};

const remove = num => {
  const row = pages.find(page => page.num === Number(num));
  if (!row) {
    return {error: "There is no such page."};
  }
  accounts().database().prepare("DELETE FROM journal_pages WHERE num = ?").run(row.num);
  try {
    fs.rmSync(fileOf(row.file), {force: true});
    fs.rmSync(path.join(DIR, `${row.num}-icon.png`), {force: true});
  }
  catch (err) {}
  swfCache.delete(`${row.num}:page`);
  swfCache.delete(`${row.num}:icon`);
  pages = pages.filter(page => page.num !== row.num);
  require("./defpacks.js").journalsChanged();
  console.log(`[journals] the page ${logText(row.title)} (${row.num}) was taken out`);
  return {ok: true};
};

// a page read, for the new-burst: account.journalSeen (def id -> time)
const markSeen = (account, defId, when) => {
  account.journalSeen = account.journalSeen || {};
  account.journalSeen[String(Number(defId))] = Math.floor(when);
  accounts().save(account);
  return account.journalSeen[String(Number(defId))];
};

const seenFields = account => Object.entries(account.journalSeen || {}).map(([defId, ts]) => ({defId: Number(defId), ts: Number(ts)}));

// a change everywhere playing: the listeners lib/world.js register get
// a change's action and name
const connect = tell => tellers.push(tell);

// the staff's pages in a row of the newspaper's def id, its picture's media
// id and its icon's, and its title — one page in three fields plus the title
const pageTuples = () => list().flatMap(page => [page.defId, page.mediaId, page.iconMediaId, page.title]);

module.exports = {load, list, entries, defRows, pictureOf, iconPictureOf, movieOf, mediaFor, add, remove, markSeen, seenFields, connect, pageTuples,
  DEF_ID_BASE, MEDIA_ID_BASE, MAX_BYTES};
