"use strict";

// the holdable items of defPack 1036 (the game's "emoticon" defs): what an
// avatar can hold, from popcorn to a phantom key. the row of the pack names
// no words, only an id and a media id; the media's own class name gave the
// labels in holdables.json (tools made them once, from the pack), and the
// media is the picture the picker shows (its "attachment" display object).
//
// a player's choice is user var 9012 (the holdable's def id, 0 none). the
// client sends it on picking, then the normal user-communication attachment
// message; the server keeps it and replays the attachment when the player
// enters a room, so late arrivals see their holdable too.

const catalog = require("./holdables.json");

const CHOICE_VAR = 9012;
const VARIANT_VAR = 9014;
const byId = new Map(catalog.map(row => [Number(row.id), row]));

// Some holdables are one picture with a state the game sets by name: the
// Juice Bar's smoothie changes colour this way (its media's setState). The
// picker offers these words beside the one holdable, and the extra travels
// with the attachment message (and with the remembered choice).
const VARIANTS = {
  2: [{label: "Purple", extra: "purple"}, {label: "Orange", extra: "orange"}, {label: "Red", extra: "red"}, {label: "Yellow", extra: "yellow"}],
  10: [{label: "Red", extra: "red"}, {label: "Pink", extra: "pink"}, {label: "Blue", extra: "blue"}, {label: "Green", extra: "green"}],
};

const variantsOf = id => VARIANTS[Number(id)] || [];
const variantOf = (id, index) => variantsOf(id)[Number(index)] || null;

// every holdable, as the client's picker takes them
const list = () => catalog.map(row => ({id: row.id, mediaId: row.mediaId, name: row.name, variants: variantsOf(row.id)}));

const get = id => byId.get(Number(id)) || null;

// the holdable an account picked, or null for none (no var, 0, or one that
// is no longer in the pack)
const of = account => {
  const vars = account.userVars || {};
  const id = Number(vars[CHOICE_VAR]);
  const row = id ? get(id) : null;
  if (!row) {
    return null;
  }
  const variant = variantOf(row.id, vars[VARIANT_VAR]);
  return {...row, extra: variant ? variant.extra : ""};
};

module.exports = {list, get, of, variantsOf, variantOf, CHOICE_VAR, VARIANT_VAR};
