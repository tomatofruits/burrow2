"use strict";

// The animal glow: a coloured outline around a player's animal and every item
// it wears, chosen on the account page and shown to everyone in the room.
//
// The setting belongs to the account (account.glow), not to a user var, and
// is sent as the "xgl" extension message. It travels as plain fields so the
// patched client (AJClient.onGlow, AvatarWorldView) can render it without
// another lookup: [username, mode, colours, look, thickness, brightness,
// gradient runs, show on, the active animal's id].
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
    || !SHOW_ON.includes(String(source.showOn))) {
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

// the account's glow, always a complete object
const of = account => normalize(account && account.glow);

// the active animal's perUserAvId, for "show on: only my current animal".
const activeAnimalId = account => {
  const avatars = account && Array.isArray(account.avatars) ? account.avatars : [];
  const active = avatars.find(avatar => avatar.perUserAvId === account.activeAvatar) || avatars[0];
  return active ? Number(active.perUserAvId) || 1 : 1;
};

// the fields of an "xgl" message: [username, mode, colours, look, thickness,
// brightness, runs, show on, active animal id]
const wire = account => {
  const glow = of(account);
  return [
    account.username,
    glow.mode,
    glow.colors.join(","),
    glow.look,
    String(glow.thickness),
    String(glow.brightness),
    String(glow.runs),
    glow.showOn,
    String(activeAnimalId(account)),
  ];
};

module.exports = {MODES, LOOKS, SHOW_ON, DEFAULTS, normalize, valid, of, wire, activeAnimalId};
