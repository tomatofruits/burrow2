"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config.js");
const {logText} = require("./logtext.js");
const accounts = require("./accounts.js");

// custom emojis (the staff's panels, the Emojis page): a named picture shown
// in the patched client's chat and its emoji panel (AJClient, gui.ChatBalloon)
// beside the game's own (Twemoji's, lib/emoji.js). the picture is a PNG in
// data/emoji/custom; the name is the ":name:" shortcode typed in chat, so it
// is letters, digits and underscores, lower-cased. a change is told to every
// game playing (world.js's connect), and the list rides the login as the
// colours' do (world.js login).

const NAME = /^[a-z0-9_]{1,30}$/;
const MAX_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const DIR = path.join(config.dataDir, "emoji", "custom");
const SCHEMA = "CREATE TABLE IF NOT EXISTS custom_emojis (name TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL)";

let list = []; // [{name, at, by}], oldest first
const inFlight = new Set(); // names a change went out for: no double tells
const tellers = []; // lib/world.js's connect: one per server run

const fileOf = name => path.join(DIR, `${name}.png`);

const load = () => {
  accounts.database().exec(SCHEMA);
  list = accounts.database().prepare("SELECT name, at, by FROM custom_emojis ORDER BY at, name").all()
    .filter(row => fs.existsSync(fileOf(row.name)));
  if (list.length) {
    console.log(`[emojis] ${logText(list.length)} custom emojis`);
  }
};

// the picture of one, as bytes; null when there is none.
const pictureOf = name => {
  if (!NAME.test(name) || !list.some(entry => entry.name === name)) {
    return null;
  }
  try {
    return fs.readFileSync(fileOf(name));
  }
  catch (err) {
    return null;
  }
};

const tellGames = (action, name, key) => {
  if (inFlight.has(key)) {
    return;
  }
  inFlight.add(key);
  setTimeout(() => inFlight.delete(key), 3000);
  for (const tell of tellers) {
    tell(action, name);
  }
};

// a name with its picture, or what went wrong. replaces one of the same
// name (its picture and its picker cell).
const set = (name, body, by) => {
  name = String(name || "").trim().toLowerCase();
  if (!NAME.test(name)) {
    return {error: "Names are letters, digits and underscores, 30 at most, and are typed as :name:."};
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return {error: "No picture came."};
  }
  if (body.length > MAX_BYTES) {
    return {error: `That picture is too big: ${Math.round(MAX_BYTES / 1024)} KB at most.`};
  }
  if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {error: "That is not a PNG picture."};
  }
  try {
    fs.mkdirSync(DIR, {recursive: true});
    const tmp = `${fileOf(name)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, fileOf(name));
  }
  catch (err) {
    console.log(`[emojis] could not keep ${logText(name)}: ${logText(err.message)}`);
    return {error: "The picture could not be kept (server side)."};
  }
  const at = Math.floor(Date.now() / 1000);
  accounts.database().prepare("INSERT INTO custom_emojis (name, at, by) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, by = excluded.by")
    .run(name, at, by);
  const kept = list.some(entry => entry.name === name);
  list = list.filter(entry => entry.name !== name);
  list.push({name, at, by});
  tellGames(kept ? "r" : "a", name, `${name}:set`);
  console.log(`[emojis] ${logText(by)} ${kept ? "replaced" : "added"} the emoji ${logText(name)}`);
  return {ok: true};
};

const remove = name => {
  name = String(name || "").trim().toLowerCase();
  const entry = list.find(candidate => candidate.name === name);
  if (!entry) {
    return {error: "There is no such emoji."};
  }
  accounts.database().prepare("DELETE FROM custom_emojis WHERE name = ?").run(name);
  try {
    fs.rmSync(fileOf(name), {force: true});
  }
  catch (err) {}
  list = list.filter(candidate => candidate.name !== name);
  tellGames("d", name, `${name}:del`);
  console.log(`[emojis] the emoji ${logText(name)} was taken out`);
  return {ok: true};
};

const listAll = () => [...list];

// the names, login-order: what a joining game is told ("xes").
const listNames = () => list.map(entry => entry.name);

// a change everywhere playing: lib/world.js registers one teller per run.
const connect = tell => tellers.push(tell);

module.exports = {load, set, remove, pictureOf, connect, listAll, listNames, NAME, MAX_BYTES};
