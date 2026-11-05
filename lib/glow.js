"use strict";

// The animal glow: a coloured outline around a player's animal and every item
// it wears, chosen on the account page and shown to everyone in the room.
//
// The setting belongs to one animal (avatar.glow in lib/accounts.js), not to
// the account as a whole and not to a user var, so switching animals switches
// glows and logging out and back in keeps each animal's own. It is sent as the
// "xgl" extension message: [username, mode, colours, look, thickness,
// brightness, gradient runs, "all", the active animal's id]. The "all" field
// remains for older clients, which used it for an account-wide "show on".
//
// The server only stores what it has checked. The client is never trusted to
// send arbitrary filter values: every field is clamped here, and colours must
// be six hexadecimal digits.

const MODES = ["none", "solid", "rings", "gradient", "cycle", "rainbow"];
const LOOKS = ["glow", "outline"];
const SHOW_ON = ["all", "current"];
const MIN_THICKNESS = 2;
const MAX_THICKNESS = 24;
const MIN_BRIGHTNESS = 20;
const MAX_BRIGHTNESS = 100;
const MIN_RUNS = 1;
const MAX_RUNS = 5;
const MAX_COLOURS = 3;
// the colours a new glow starts with: a violet, a cyan and a pink.
const DEFAULT_COLOURS = ["8b5cf6", "22d3ee", "f472b6"];

const DEFAULTS = {
  mode: "none",
  colors: DEFAULT_COLOURS.slice(),
  look: "glow",
  thickness: 8,
  brightness: 85,
  runs: 2,
  showOn: "all",
};

const colour = value => {
  const text = typeof value === "string" ? value.trim().replace(/^#/, "") : "";
  return /^[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : null;
};

const whole = (value, fallback, low, high) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
};

// every field checked and within range. Missing fields take their defaults,
// so an old account without a glow reads as "none" rather than failing.
const normalize = source => {
  const value = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const colors = (Array.isArray(value.colors) ? value.colors : [])
    .map(colour)
    .filter(Boolean)
    .slice(0, MAX_COLOURS);
  return {
    mode: MODES.includes(String(value.mode)) ? String(value.mode) : DEFAULTS.mode,
    colors: colors.length ? colors : DEFAULT_COLOURS.slice(),
    look: LOOKS.includes(String(value.look)) ? String(value.look) : DEFAULTS.look,
    thickness: whole(value.thickness, DEFAULTS.thickness, MIN_THICKNESS, MAX_THICKNESS),
    brightness: whole(value.brightness, DEFAULTS.brightness, MIN_BRIGHTNESS, MAX_BRIGHTNESS),
    runs: whole(value.runs, DEFAULTS.runs, MIN_RUNS, MAX_RUNS),
    showOn: SHOW_ON.includes(String(value.showOn)) ? String(value.showOn) : DEFAULTS.showOn,
  };
};

// strictly what the account page sent: a malformed field is refused, not
// quietly replaced. (normalize above is still used for stored state.)
const valid = source => {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return false;
  }
  if (!MODES.includes(String(source.mode)) || !LOOKS.includes(String(source.look))
    || (source.showOn !== undefined && !SHOW_ON.includes(String(source.showOn)))) {
    return false;
  }
  const colors = source.colors;
  if (!Array.isArray(colors) || colors.length < 1 || colors.length > MAX_COLOURS || !colors.every(value => colour(value))) {
    return false;
  }
  const integerIn = (value, low, high) => Number.isInteger(Number(value)) && Number(value) >= low && Number(value) <= high;
  return integerIn(source.thickness, MIN_THICKNESS, MAX_THICKNESS)
    && integerIn(source.brightness, MIN_BRIGHTNESS, MAX_BRIGHTNESS)
    && integerIn(source.runs, MIN_RUNS, MAX_RUNS);
};

// one of the account's animals, the active one when no id is given
const avatarOf = (account, perUserAvId) => {
  const avatars = account && Array.isArray(account.avatars) ? account.avatars : [];
  if (perUserAvId !== undefined && perUserAvId !== null) {
    return avatars.find(avatar => Number(avatar.perUserAvId) === Number(perUserAvId)) || null;
  }
  return avatars.find(avatar => avatar.perUserAvId === account.activeAvatar) || avatars[0] || null;
};

const activeAnimalId = account => {
  const avatar = avatarOf(account);
  return avatar ? Number(avatar.perUserAvId) || 1 : 1;
};

// one animal's glow, always a complete object; the active animal's by default
const of = (account, perUserAvId) => {
  const avatar = avatarOf(account, perUserAvId);
  return normalize(avatar && avatar.glow);
};

// every animal and its own glow, for the account page's animal picker
const list = account => (account && Array.isArray(account.avatars) ? account.avatars : []).map(avatar => ({
  perUserAvId: Number(avatar.perUserAvId) || 1,
  type: Number(avatar.type) || 0,
  name: String(avatar.name || ""),
  glow: normalize(avatar.glow),
}));

// save one animal's glow; null when the id is not one of this account's
const set = (account, perUserAvId, source) => {
  const avatar = avatarOf(account, perUserAvId);
  if (!avatar) {
    return null;
  }
  avatar.glow = normalize(source);
  return avatar;
};

// Glow used to be one setting for the whole account (account.glow). Give it
// to the animal that was active then, and give every other animal its own
// "none". Runs after the account's avatars have been made.
const migrate = account => {
  if (!account || !Array.isArray(account.avatars)) {
    return;
  }
  for (const avatar of account.avatars) {
    if (avatar.glow !== undefined) {
      avatar.glow = normalize(avatar.glow);
    }
  }
  if (account.glow !== undefined) {
    const avatar = avatarOf(account);
    if (avatar && avatar.glow === undefined) {
      avatar.glow = normalize(account.glow);
    }
    delete account.glow;
  }
  for (const avatar of account.avatars) {
    if (avatar.glow === undefined) {
      avatar.glow = normalize();
    }
  }
};

// the fields of an "xgl" message: [username, mode, colours, look, thickness,
// brightness, runs, "all", active animal id]
const wire = account => {
  const id = activeAnimalId(account);
  const glow = of(account, id);
  return [
    account.username,
    glow.mode,
    glow.colors.join(","),
    glow.look,
    String(glow.thickness),
    String(glow.brightness),
    String(glow.runs),
    "all",
    String(id),
  ];
};

module.exports = {MODES, LOOKS, SHOW_ON, DEFAULTS, normalize, valid, of, list, set, migrate, wire, activeAnimalId};
