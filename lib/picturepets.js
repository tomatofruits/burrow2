"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config.js");
const {logText} = require("./logtext.js");
const itemswf = require("./itemswf.js");
const cdn = require("./cdn.js");
const approvaltext = require("./approvaltext.js");

// accounts requires defpacks, which requires this: ask for it when it is
// needed, not while the modules are still loading (a cycle)
const accounts = () => require("./accounts.js");

// picture pets: a picture made into a pet (the panels' Pets page). every one
// waits for a moderator on the Review page, the same place custom item
// pictures wait (lib/playeritems.js review, lib/modpanel.js reviewRoutes),
// whatever the staff's role; approving gives the pet to the player named
// when it was put in. the picture becomes a one-frame movie (lib/itemswf.js)
// served as a media id, and the pet def pack (1046) carries a row for it
// (lib/defpacks.js) so the game draws it: newspaper.* no, pet.*: the movie
// has no pet state, which PetBase/WorldPet/DenItemHelper come around.

const DEF_ID_BASE = 200; // the pet def ids pictures get (the low byte of lBits; 55 at most)
const MEDIA_ID_BASE = 45000; // a picture pet's media id
const MAX_BYTES = 1024 * 1024;
const STAND = 56; // the game's own pets are about this big
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const DIR = path.join(config.dataDir, "picturepets");
const SCHEMA = "CREATE TABLE IF NOT EXISTS picture_pets (num INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, username TEXT NOT NULL, type INTEGER NOT NULL, file TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, state TEXT NOT NULL, petInv INTEGER)";

let pets = []; // rows, newest last
const mediaCache = new Map(); // num -> the movie

const fileOf = name => path.join(DIR, name);

const load = () => {
  accounts().database().exec(SCHEMA);
  pets = accounts().database().prepare("SELECT * FROM picture_pets ORDER BY num").all()
    .filter(row => fs.existsSync(fileOf(row.file)));
  const waiting = pets.filter(row => row.state === "pending").length;
  if (pets.length) {
    console.log(`[pets] ${logText(pets.length)} picture pets (${logText(waiting)} waiting)`);
  }
};

const defIdOf = num => DEF_ID_BASE + (Number(num) % (256 - DEF_ID_BASE));

const approvedList = () => pets.filter(row => row.state === "approved");

// the rows the pet def pack carries (one per approved pet), the fields the
// game's are read as (PetXtCommManager.petDefsResponse)
const defRows = () => approvedList().map(row => ({
  id: defIdOf(row.num),
  mediaRefId: MEDIA_ID_BASE + row.num,
  type: String(row.type),
  titleStrId: "0",
  isMember: "0",
  cost: "0",
  status: "0",
  toyListId: "0",
  foodListId: "0",
  isReward: "0",
  isEgg: "0",
  availabilityStartTime: "0",
  availabilityEndTime: "0",
}));

// the def of one approved pet, for the server's own pet code (lib/defpacks.js
// petDef), which reads its fields as the pack's strings
const defOf = defId => {
  const row = approvedList().find(candidate => defIdOf(candidate.num) === Number(defId));
  return row ? defRows().find(candidate => candidate.id === defIdOf(row.num)) : null;
};

const list = () => pets.map(row => ({num: row.num, name: row.name, username: row.username, type: row.type, at: row.at, by: row.by,
  state: row.state, petInv: row.petInv, mediaId: MEDIA_ID_BASE + row.num, defId: defIdOf(row.num)}));

const pictureOf = num => {
  const row = pets.find(candidate => candidate.num === Number(num));
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

const movieOf = num => {
  const key = Number(num);
  if (mediaCache.has(key)) {
    return mediaCache.get(key);
  }
  const picture = pictureOf(key);
  if (!picture) {
    return null;
  }
  const image = itemswf.fromPicture({type: "png", data: picture});
  const movie = image && itemswf.build(trimmed(image), STAND, "bottom");
  if (movie) {
    mediaCache.set(key, movie);
  }
  return movie;
};

// the picture without the empty space around it, so that the pet fills its
// size and stands on the middle of what was drawn, whatever the margins the
// picture was saved with. what is all but clear counts as empty.
const trimmed = image => {
  if (!image || image.cover !== "lossless" || !image.pixels) {
    return image;
  }
  let xMin = image.width, xMax = -1, yMin = image.height, yMax = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] > 8) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
  }
  if (xMax < xMin || yMax < yMin || (xMin === 0 && yMin === 0 && xMax === image.width - 1 && yMax === image.height - 1)) {
    return image;
  }
  const width = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y + yMin) * image.width + xMin) * 4;
    pixels.set(image.pixels.subarray(from, from + width * 4), y * width * 4);
  }
  return {cover: "lossless", width, height, pixels};
};

// the media file a request for this pet's picture is answered with
const mediaFor = relPath => {
  for (const row of approvedList()) {
    if (relPath === cdn.hashedPath(`media/${MEDIA_ID_BASE + row.num}`)) {
      const movie = movieOf(row.num);
      if (movie) {
        console.log(`[pets] a picture pet's picture served (${row.num})`);
      }
      return movie && {mediaId: MEDIA_ID_BASE + row.num, body: movie};
    }
  }
  return null;
};

const add = (name, username, type, body, by) => {
  name = String(name || "").trim().slice(0, 30);
  const owner = accounts().byName(String(username || "").trim());
  if (!name) {
    return {error: "Give the pet a name."};
  }
  if (!owner) {
    return {error: "No such player to give the pet to."};
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
  if (pets.filter(row => row.state === "approved").length >= 256 - DEF_ID_BASE) {
    return {error: "There are as many picture pets as the game can name. Take one out first."};
  }
  fs.mkdirSync(DIR, {recursive: true});
  const at = Math.floor(Date.now() / 1000);
  const result = accounts().database().prepare("INSERT INTO picture_pets (name, username, type, file, at, by, state, petInv) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)")
    .run(name, owner.username, Number(type) || 0, "", at, by);
  const num = Number(result.lastInsertRowid);
  fs.writeFileSync(fileOf(`${num}.png`), body);
  accounts().database().prepare("UPDATE picture_pets SET file = ? WHERE num = ?").run(`${num}.png`, num);
  pets = accounts().database().prepare("SELECT * FROM picture_pets ORDER BY num").all();
  try {
    require("./approvalfeed.js").emit({what: "pet", kind: "pet", id: num, name, maker: owner.username});
  }
  catch (err) {}
  console.log(`[pets] ${logText(by)} put in the picture pet ${logText(name)} for ${logText(owner.username)}, waiting`);
  return {ok: true, num};
};

// the pets waiting: the Review page shows them with the item pictures
const waiting = () => list().filter(entry => entry.state === "pending");

const review = (num, approve, by) => {
  const row = pets.find(candidate => candidate.num === Number(num));
  if (!row || row.state !== "pending") {
    return {error: "That is not waiting for approval."};
  }
  const owner = accounts().byName(row.username);
  if (!owner) {
    return {error: "The player it was made for is gone; turn it away."};
  }
  if (!approve) {
    accounts().database().prepare("DELETE FROM picture_pets WHERE num = ?").run(row.num);
    try {
      fs.rmSync(fileOf(row.file), {force: true});
    }
    catch (err) {}
    mediaCache.delete(row.num);
    pets = pets.filter(candidate => candidate.num !== row.num);
    return {ok: `${row.name} was turned away and deleted.`};
  }
  if (owner.pets.length >= 1000) {
    return {error: "That player has as many pets as they can hold."};
  }
  const pet = {inv: owner.nextInv++, lBits: defIdOf(row.num), uBits: 0, eBits: 0, name: `${row.name}`, createdAt: Math.floor(Date.now() / 1000), mastery: 0};
  owner.pets.push(pet);
  accounts().save(owner);
  accounts().database().prepare("UPDATE picture_pets SET state = 'approved', petInv = ? WHERE num = ?").run(pet.inv, row.num);
  pets = accounts().database().prepare("SELECT * FROM picture_pets ORDER BY num").all();
  require("./defpacks.js").petsChanged();
  // a card from HQ, as a painting's maker gets (lib/ecards.js noteFromHq)
  try {
    require("./world.js").ecards.noteFromHq(owner, approvaltext.text("pet", {name: row.name}));
  }
  catch (err) {}
  console.log(`[pets] ${logText(by)} approved the picture pet ${logText(row.name)} for ${logText(owner.username)}`);
  return {ok: `${row.name} is ${owner.username}'s pet now, and a Jam-A-Gram tells them.`};
};

// `ownerOnly`: a player's own pet from the account page, which may only take
// back one that still waits for approval (an approved one is in their game).
const remove = (num, ownerOnly = null) => {
  const row = pets.find(candidate => candidate.num === Number(num));
  if (!row) {
    return {error: "There is no such picture pet."};
  }
  if (ownerOnly !== null && row.username !== ownerOnly) {
    return {error: "That is not one of your picture pets."};
  }
  if (ownerOnly !== null && row.state !== "pending") {
    return {error: "That one is in the game now; ask a moderator to take it out."};
  }
  // one in the game is taken out of its owner's pets too, or it would be a
  // pet whose picture is gone
  if (row.state === "approved" && row.petInv) {
    const owner = accounts().byName(row.username);
    if (owner) {
      const before = owner.pets.length;
      owner.pets = owner.pets.filter(pet => pet.inv !== row.petInv);
      for (const avatar of owner.avatars) {
        if (avatar.petInvId === row.petInv) {
          avatar.petInvId = 0;
        }
      }
      if (owner.pets.length !== before) {
        accounts().save(owner);
      }
    }
  }
  accounts().database().prepare("DELETE FROM picture_pets WHERE num = ?").run(row.num);
  try {
    fs.rmSync(fileOf(row.file), {force: true});
  }
  catch (err) {}
  mediaCache.delete(row.num);
  pets = pets.filter(candidate => candidate.num !== row.num);
  require("./defpacks.js").petsChanged();
  return {ok: true};
};

// one player's own picture pets, for the account page
const of = username => list().filter(entry => entry.username === username);

module.exports = {load, list, of, defRows, defOf, waiting, mediaFor, pictureOf, add, review, remove, DEF_ID_BASE, MEDIA_ID_BASE, MAX_BYTES};
