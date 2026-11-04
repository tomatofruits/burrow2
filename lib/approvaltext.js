"use strict";

const accounts = () => require("./accounts.js");

// The words in the Jam-A-Gram Animal Jam HQ sends when a picture or a pet is
// let in. The admin panel edits them; {name} is the item's (or pet's) name,
// and {where} is "clothing" or "den items". The defaults are the wording the
// server had before the panel could change it.
const KEY = "approvalEcardText";
const DEFAULTS = {
  item: "Your {name} has been approved! It is with your {where}. Enjoy!",
  picture: "Your new picture for {name} has been approved! Enjoy!",
  pet: "Your pet, {name}, has been approved! Enjoy!",
  masterpiece: "Your Masterpiece has been approved! It is with your den items.",
};

const all = () => {
  let saved = {};
  try {
    saved = JSON.parse(accounts().setting(KEY) || "{}");
  }
  catch (err) {
    saved = {};
  }
  const out = {};
  for (const [kind, fallback] of Object.entries(DEFAULTS)) {
    out[kind] = typeof saved[kind] === "string" && saved[kind].trim() ? saved[kind] : fallback;
  }
  return out;
};

const text = (kind, values = {}) => {
  const template = all()[kind] || DEFAULTS[kind] || "";
  return template.replace(/\{name\}/g, String(values.name || "")).replace(/\{where\}/g, String(values.where || "items"));
};

const set = values => {
  const current = all();
  for (const kind of Object.keys(DEFAULTS)) {
    if (typeof values[kind] === "string" && values[kind].trim()) {
      current[kind] = values[kind].slice(0, 500);
    }
  }
  accounts().setSetting(KEY, JSON.stringify(current));
  return current;
};

module.exports = {DEFAULTS, all, text, set};
