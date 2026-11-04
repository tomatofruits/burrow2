"use strict";
// One handler: playeritems.js says an item is waiting for a moderator, and the
// Discord bot (lib/discordbot.js) posts it with Approve / Turn away buttons.
let handler = null;
module.exports = {
  on(fn) {
    handler = fn;
    return () => {
      if (handler === fn) handler = null;
    };
  },
  emit(entry) {
    if (handler) Promise.resolve().then(() => handler(entry)).catch(() => {});
  },
};
