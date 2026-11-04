"use strict";

// end-to-end check of the small comforts added on 2026-10-11: bigger
// limits, the newer chat commands, whispers, names typed over, looks per
// room, eggs that hatch at once. simulated players, a real server.

const assert = require("assert");
const harness = require("./harness.js");

const HTTP_PORT = 18085;
const GAME_PORT = 19344;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const TOWNSHIP = "jamaa_township.room_main#1";
const {postJson} = harness;

const say = (client, roomId, text) =>
  client.send(`<msg t='sys'><body action='pubMsg' r='${roomId}'><txt><![CDATA[${text}%0]]></txt></body></msg>`);
// what a command's message box said.
const told = async client => (await client.untilXt("xtl"))[2];

// logs in and asks for the township, as the game always does first.
// returns where the server put them.
const arrive = async username => {
  const auth = await (await postJson(`${BASE}/authenticate`, {username, password: "KettlePass01"})).json();
  const client = new harness.GameClient(GAME_PORT);
  await client.connect();
  const login = await client.logIn(username, auth.auth_token);
  assert.strictEqual(login.status, "1");
  client.xt("rj", 1, TOWNSHIP, 1, 0, 0);
  const joined = await client.untilXt("rj");
  const file = (await client.untilXt("rp"))[2];
  client.xt("au", joined[4], 1, 400, 400, 14, 1);
  return {client, login, roomId: joined[4], room: joined[3], file};
};

const run = async () => {
  for (const username of ["Ann", "Ben"]) {
    const response = await fetch(`${BASE}/api/register`, {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({username, password: "KettlePass01", avatarType: 1, agreed: true})});
    assert.strictEqual(response.status, 200);
  }
  let {client: a, login, roomId, room} = await arrive("Ann");
  const {client: b, roomId: benRoom} = await arrive("Ben");
  await a.untilXt("ac");
  assert.strictEqual(room, TOWNSHIP);
  assert.strictEqual(login.params.pendingFlags & 2, 2); // the client's bigger inventories

  // skips the stale "il" messages (the worn list of one animal, three fields
  // per item at index 9) until Ben is told Ann wears exactly the two
  const wornOnB = async expected => {
    for (;;) {
      const heard = await b.untilXt("il");
      if (heard[2] === "1" && heard[5] === "Ann" && Number(heard[8]) === 2
        && String(heard[10]) === String(expected[0]) && String(heard[13]) === String(expected[1])) {
        return heard;
      }
    }
  };

  // --- !go: by short name, by a room's own name, and not to nowhere
  say(a, roomId, "!go nowhere");
  assert.match(await told(a), /no place called nowhere/);
  say(a, roomId, "!go list");
  assert.match(await told(a), /township.*sarepia/);
  say(a, roomId, "!go sarepia");
  let moved = await a.untilXt("rj");
  assert.strictEqual(moved[3], "sarepia.room_main#1");
  assert.strictEqual((await a.untilXt("rp"))[2], "sarepia.room_main");
  roomId = moved[4];

  // --- a look for this room only, and for no other
  say(a, roomId, "!theme here fall2022");
  assert.strictEqual((await a.untilXt("rp"))[2], "theme_1636.sarepia.room_main");
  say(a, roomId, "!theme here easter");
  assert.match(await told(a), /Use: !theme/);
  say(a, roomId, "!go sarepia.flag_shop");
  moved = await a.untilXt("rj");
  assert.strictEqual((await a.untilXt("rp"))[2], "sarepia.flag_shop");
  say(a, moved[4], "!go sarepia");
  moved = await a.untilXt("rj");
  assert.strictEqual((await a.untilXt("rp"))[2], "theme_1636.sarepia.room_main"); // remembered
  roomId = moved[4];
  say(a, roomId, "!theme here off");
  assert.strictEqual((await a.untilXt("rp"))[2], "sarepia.room_main");

  // --- whispers: buddies only; a popup from afar, a bubble for two in one room
  say(a, roomId, "!w Ben Psst, over HERE");
  assert.match(await told(a), /not one of your buddies/);
  a.xt("ba", roomId, "Ben");
  await b.untilXt("ba");
  b.xt("bc", benRoom, "Ann", 1);
  await a.untilXt("bs");
  say(a, roomId, "!w Ben Psst, over HERE");
  assert.deepStrictEqual((await b.untilXt("xw")).slice(2), ["0", "Ann", "Psst, over HERE"]); // from afar: a box; capitals kept
  assert.match(await told(a), /Whispered to Ben/);
  say(b, benRoom, "!go sarepia");
  const benMoved = await b.untilXt("rj");
  await b.untilXt("rp");
  b.xt("au", benMoved[4], 1, 300, 300, 14, 1);
  await a.untilXt("ac");
  say(b, benMoved[4], "!w ann hello");
  assert.deepStrictEqual((await a.untilXt("xw")).slice(2), ["1"]); // in one room: the next bubble is a green one
  assert.deepStrictEqual((await a.nextXt("uc")).slice(3), ["hello", "0"]);

  // --- names typed over in the switcher windows: an animal's, a pet's
  a.xt("xrn", roomId, "a", 1, "Sir Fluffy Paws");
  assert.strictEqual((await a.untilXt("ad"))[15], "Sir Fluffy Paws");
  assert.deepStrictEqual((await a.untilXt("xrn")).slice(2), ["a", "1", "1", "Sir Fluffy Paws"]);
  a.xt("xrn", roomId, "a", 1, "<b>");
  assert.deepStrictEqual((await a.untilXt("xrn")).slice(2), ["a", "1", "0", "Sir Fluffy Paws"]);
  a.xt("xrn", roomId, "p", 999, "Biscuit");
  assert.deepStrictEqual((await a.untilXt("xrn")).slice(2, 5), ["p", "999", "0"]);
  say(a, roomId, "!name Nope"); // no longer a command: just something said
  assert.strictEqual((await a.untilXt("uc"))[3], "!name Nope");

  // --- clothes: everything off and back
  const give = async query => {
    const found = (await (await fetch(`${BASE}/api/search?q=${query}&kind=clothing`)).json()).results[0];
    assert.strictEqual((await fetch(`${BASE}/api/give`, {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({username: "Ann", kind: "clothing", id: found.id, colorIndex: 0})})).status, 200);
    return (await a.untilXt("il"))[9]; // its inventory id
  };
  const hat = await give("top+hat");
  const scarf = await give("scarf");
  a.xt("iu", roomId, 2, 0, hat, scarf);
  await a.untilXt("iu");
  await a.untilXt("il");
  say(a, roomId, "!outfit off");
  let changed = await a.untilXt("il");
  assert.deepStrictEqual([changed[2], changed[7], changed[8]], ["3", "0", "2"]);
  assert.match(await told(a), /Everything is off/);
  say(a, roomId, "!outfit undo");
  changed = await a.untilXt("il");
  assert.deepStrictEqual([changed[2], changed[7], changed[8]], ["3", "2", "0"]);
  assert.match(await told(a), /Back to what you wore before/);
  say(a, roomId, "!again");
  assert.match(await told(a), /Buy something in a shop first/);
  // A purchase, then more of it: only after a yes to the question.
  a.xt("gl", roomId, 5);
  const shop = await a.untilXt("gl");
  a.xt("ib", roomId, 5, 1, shop[9], 0, 0, -1, "");
  await a.untilXt("ib");
  const owned = async () => {
    a.xt("il", roomId, "Ann", 1, 1);
    let list = await a.untilXt("il");
    while (list[2] !== "0") {
      list = await a.untilXt("il");
    }
    return Number(list[8]);
  };
  const before = await owned();
  say(a, roomId, "!again 101");
  assert.match(await told(a), /from 1 to 100/);
  say(a, roomId, "!again 3");
  const question = await a.untilXt("xyn");
  assert.match(question[3], /Buy 3 more/);
  a.xt("xyn", roomId, question[2], 0); // no
  assert.strictEqual(await owned(), before);
  say(a, roomId, "!again 3");
  a.xt("xyn", roomId, (await a.untilXt("xyn"))[2], 1); // yes
  assert.strictEqual(await owned(), before + 3);
  say(a, roomId, "!help"); // gone: the list is at /commands
  assert.strictEqual((await a.untilXt("uc"))[3], "!help");
  assert.match(await (await fetch(`${BASE}/commands`)).text(), /!outfit save <i>NAME<\/i>/); // the page sets what to type in italics

  // --- den undo, mail, music
  say(a, roomId, "!den undo");
  assert.match(await told(a), /nothing to put back/);
  say(a, roomId, "!den name Beach House");
  assert.match(await told(a), /now called Beach House/);
  b.xt("dj", benMoved[4], "denAnn", 1, -1);
  assert.strictEqual((await b.untilXt("rj"))[14], "Ann's Beach House");
  b.xt("rj", 1, "sarepia.room_main#1", 1, 0, 0);
  await b.untilXt("rp");
  say(a, roomId, "!mail clear");
  assert.match(await told(a), /0 read Jam-A-Grams deleted/);
  say(a, roomId, "!music all");
  const tracks = await a.untilXt("di");
  // the game's 55 tracks and this server's own (lib/extramusic.js)
  const allTracks = 55 + require("../lib/extramusic.js").TRACKS.length;
  assert.match(await told(a), new RegExp(`${allTracks} music tracks added`));
  assert.ok(Number(tracks[3]) >= allTracks);
  say(a, roomId, "!music all");
  await a.untilXt("di");
  assert.match(await told(a), /every music track already/);

  // --- an egg is hatched as soon as it is bought (three days by the game's clock)
  const eggDef = require("../lib/defpacks.js");
  await eggDef.init();
  const egg = eggDef.petIds().find(id => eggDef.petDef(id).isEgg === "1");
  a.xt("pc", roomId, 312, egg, 0, 0, 1, 2, 0);
  const made = await a.untilXt("pc");
  assert.strictEqual(made[2], "1");
  assert.ok(Number(made[10]) <= Date.now() / 1000 - 259200);
  // ... and named from the hatched popup (EggPetHatchedPopup waits for this answer)
  a.xt("pn", roomId, made[5], 15386, 15428);
  assert.deepStrictEqual((await a.untilXt("pn")).slice(2), ["1", made[5], "15386|15428"]);

  // --- a custom emoji put in by staff (lib/emojis.js): the panels' route
  // keeps the picture, a connected game is told at once ("xes"), and the
  // picture is served to anyone who asks. setup needs an admin sign-in.
  const webSession = () => {
    let cookie = "";
    return async (pathName, body) => {
      const isPng = Buffer.isBuffer(body);
      const headers = {cookie};
      const options = body === undefined ? {headers} : {method: "POST", headers: headers["Content-Type"] = isPng ? {...headers, "Content-Type": "image/png"} : {...headers, "Content-Type": "application/json"}, body: isPng ? body : JSON.stringify(body)};
      const response = await fetch(`${BASE}${pathName}`, options);
      const set = response.headers.get("set-cookie");
      if (set) {
        cookie = set.split(";")[0];
      }
      return {status: response.status, data: await response.json().catch(() => ({}))};
    };
  };
  const emojiPanel = webSession();
  assert.strictEqual((await emojiPanel("/admin/api/setup", {password: "AdminPass99!"})).status, 200);
  assert.strictEqual((await emojiPanel("/admin/api/login", {password: "AdminPass99!"})).status, 200);
  const pngBody = applePng();
  function applePng() {
    // a real 24x24 PNG, assembled here (IHDR, red-green pixels, IEND)
    const colour = [200, 40, 160];
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc(24 * (1 + 24 * 3));
    for (let y = 0; y < 24; y++) {
      const row = y * (1 + 24 * 3);
      for (let x = 0; x < 24; x++) {
        raw[row + 1 + x * 3] = colour[0]; raw[row + 1 + x * 3 + 1] = colour[1]; raw[row + 1 + x * 3 + 2] = colour[2];
      }
    }
    const table = [];
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) {
        v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
      }
      table[n] = v >>> 0;
    }
    const crcOf = buf => {
      let c = 0xFFFFFFFF;
      for (const b of buf) { c = table[(c ^ b) & 0xFF] ^ (c >>> 8); }
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const typeBuf = Buffer.from(type, "ascii");
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(Buffer.concat([typeBuf, data])));
      return Buffer.concat([len, typeBuf, data, crc]);
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk("IHDR", ihdr),
      chunk("IDAT", require("zlib").deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0))
    ]);
  }
  const putUp = await emojiPanel("/admin/api/emojis?name=cheese", pngBody);
  assert.strictEqual(putUp.status, 200, JSON.stringify(putUp.data));
  const heardEmoji = await a.untilXt("xes");
  assert.deepStrictEqual(heardEmoji.slice(2), ["a", "cheese"]);
  const emojiPicture = await fetch(`${BASE}/emoji/custom/cheese.png`);
  assert.strictEqual(emojiPicture.status, 200);
  assert.ok((await emojiPicture.arrayBuffer()).byteLength > 0);
  const gone = await emojiPanel("/admin/api/emojis?delete=cheese", new Uint8Array(0));
  assert.strictEqual(gone.status, 200, JSON.stringify(gone.data));
  await b.untilXt("xes");
  assert.strictEqual((await fetch(`${BASE}/emoji/custom/cheese.png`)).status, 404);
  assert.deepStrictEqual((await emojiPanel("/admin/api/emojis")).data.emojis, []);

  // --- the Jamaa Journal's pages (lib/journals.js): staff add a picture a
  // page; it is in the newspaper's defPack (1065), in its list (627), its
  // media is served, and a read is kept ("nps")
  const journalPng = (() => {
    const zlib = require("zlib");
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc(24 * (1 + 24 * 3));
    for (let y = 0; y < 24; y++) {
      const row = y * (1 + 24 * 3);
      for (let x = 0; x < 24; x++) {
        raw[row + 1 + x * 3] = 30; raw[row + 1 + x * 3 + 1] = 120; raw[row + 1 + x * 3 + 2] = 220;
      }
    }
    const table = [];
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) {
        v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
      }
      table[n] = v >>> 0;
    }
    const crcOf = buf => {
      let c = 0xFFFFFFFF;
      for (const b of buf) { c = table[(c ^ b) & 0xFF] ^ (c >>> 8); }
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const t = Buffer.from(type, "ascii");
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(Buffer.concat([t, data])));
      return Buffer.concat([len, t, data, crc]);
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0))
    ]);
  })();
  const journalAdmin = emojiPanel; // already set up and signed in above
  const addedPage = await journalAdmin("/admin/api/journals?title=" + encodeURIComponent("An overview"), journalPng);
  assert.strictEqual(addedPage.status, 200, JSON.stringify(addedPage.data));
  const journalPages = (await journalAdmin("/admin/api/journals")).data.pages;
  assert.strictEqual(journalPages.length, 1);
  const pageNum = journalPages[0].num;
  const pageDefId = pageNum - 1; // the paper's pages are numbered by place
  // the picture, as the game's media
  const pageMedia = await fetch(BASE + "/" + require("../lib/cdn.js").hashedPath("media/" + (50000 + pageNum)));
  assert.strictEqual(pageMedia.status, 200, "page movie at " + require("../lib/cdn.js").hashedPath("media/" + (50000 + pageNum)));
  const pageSwf = Buffer.from(await pageMedia.arrayBuffer());
  assert.ok(pageSwf.subarray(0, 3).toString("latin1") === "FWS" || pageSwf.subarray(0, 3).toString("latin1") === "CWS");
  // the newspaper's list names it
  a.xt("gl", roomId, 627);
  const paperList = await a.untilXt("gl");
  assert.ok(paperList.slice(9).map(Number).includes(pageDefId), "the journal list has the page");
  // the defpack the newspaper reads has its row
  const packBytes = await (await fetch(BASE + "/" + require("../lib/cdn.js").hashedPath("defPacks/1065"))).arrayBuffer();
  const pack = require("../lib/amf3.js").decode(require("zlib").inflateRawSync(Buffer.from(packBytes)));
  assert.strictEqual(pack[String(pageDefId)].name, "An overview");
  assert.strictEqual(Number(pack[String(pageDefId)].pageMediaRefId), 50000 + pageNum);
  // a read is kept, and answered
  a.xt("nps", roomId, pageDefId);
  const seenReply = await a.untilXt("nps");
  assert.strictEqual(Number(seenReply[2]), pageDefId);
  assert.ok(Number(seenReply[3]) > 0);
  // and it can be taken out again
  assert.strictEqual((await journalAdmin("/admin/api/journals?delete=" + pageNum, new Uint8Array(0))).status, 200);
  assert.deepStrictEqual((await journalAdmin("/admin/api/journals")).data.pages, []);

  // --- a picture pet (lib/picturepets.js): put in from the panel, waiting
  // for a moderator on the Review page with the item pictures, approved onto
  // the named player's account; its def and its picture reach the game
  const petPng = journalPng; // the same 24-square PNG does
  const petAdmin = emojiPanel; // already set up and signed in above
  const putPet = await petAdmin("/admin/api/picturepets?name=Pixel&username=Ann&type=0", petPng);
  assert.strictEqual(putPet.status, 200, JSON.stringify(putPet.data));
  const picturePets = (await petAdmin("/admin/api/picturepets")).data.pets;
  assert.strictEqual(picturePets.length, 1);
  assert.strictEqual(picturePets[0].state, "pending");
  const petNum = picturePets[0].num;
  // in the same queue as the item pictures
  const queue = (await petAdmin("/admin/api/review")).data.waiting;
  assert.ok(queue.some(entry => entry.kind === "pet" && Number(entry.id) === petNum && entry.name === "Pixel"));
  // approved: Ann's account has it, and the game's pet pack names it
  const approvedPet = await petAdmin("/admin/api/review", {kind: "pet", id: petNum, approve: true});
  assert.strictEqual(approvedPet.status, 200);
  assert.match(String(approvedPet.data.ok || ""), /Jam-A-Gram/);
  // the card itself, in Ann's game (lib/ecards.js noteFromHq)
  a.xt("el", roomId, 0);
  const gramList = await a.untilXt("el");
  const petGrams = [];
  for (let at = 3; at + 17 <= gramList.length; at += 17) {
    petGrams.push(gramList.slice(at, at + 17));
  }
  assert.ok(petGrams.some(card => /Your pet, Pixel, has been approved/.test(card[5])), "the pet's owner hears of its approval");
  a.xt("pl", roomId, "Ann");
  const petList = await a.untilXt("pl");
  assert.ok(petList.includes("Pixel"), "Ann's pet list has the picture pet");
  const petDefId = 200 + (petNum % 56);
  const defpackUrl = require("../lib/cdn.js").hashedPath("defPacks/1046");
  const petPack = require("../lib/amf3.js").decode(require("zlib").inflateRawSync(Buffer.from(await (await fetch(BASE + "/" + defpackUrl)).arrayBuffer())));
  assert.strictEqual(String(petPack[String(petDefId)].mediaRefId), String(45000 + petNum));
  // the panel's own preview of it (the Pets tab's icon)
  const petPreview = await petAdmin("/admin/api/picturepets?view=" + petNum);
  assert.strictEqual(petPreview.status, 200, "pet preview " + JSON.stringify(petPreview.data).slice(0, 80));
  const petPicture = await fetch(BASE + "/" + require("../lib/cdn.js").hashedPath("media/" + (45000 + petNum)));
  assert.strictEqual(petPicture.status, 200);
  const petMovie = Buffer.from(await petPicture.arrayBuffer());
  assert.ok(petMovie.subarray(0, 3).toString("latin1").match(/^[FC]WS$/));
  // its stage: the picture centered on the origin, its bottom there (a pet
  // stands on its spot, the name tag below), not its top-left as item art is
  const petStage = (() => {
    let at = 8, bit = 0;
    const bits = count => {
      let value = 0;
      for (let n = 0; n < count; n++) {
        value = (value << 1) | ((petMovie[at] >> (7 - bit)) & 1);
        if (++bit === 8) { bit = 0; at++; }
      }
      return value;
    };
    const signed = count => (bits(count) << (32 - count)) >> (32 - count);
    const n = bits(5);
    return [signed(n), signed(n), signed(n), signed(n)].map(value => value / 20);
  })();
  assert.deepStrictEqual(petStage, [-12, 12, -24, 0], "the pet picture is centered and stands on the origin");
  // and it can be taken out
  assert.strictEqual((await petAdmin("/admin/api/picturepets?delete=" + petNum, new Uint8Array(0))).status, 200);
  assert.deepStrictEqual((await petAdmin("/admin/api/picturepets")).data.pets, []);

  // --- she starts in the township as ever, in a look picked at random if she asked for one
  say(a, roomId, "!theme random on");
  assert.match(await told(a), /picked at random/);
  a.socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 200));
  const again = await arrive("Ann");
  assert.match(again.file, /^theme_\d+\.jamaa_township\.room_main/);
  again.client.socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 200));

  // --- "start in your own den" (asked for at sign-in): the game asks for the township and is put in the den
  const denAuth = await (await postJson(`${BASE}/authenticate`, {username: "Ann", password: "KettlePass01", login_choices: {startInDen: true}})).json();
  const home = new harness.GameClient(GAME_PORT);
  await home.connect();
  await home.logIn("Ann", denAuth.auth_token);
  home.xt("rj", 1, TOWNSHIP, 1, 0, 0);
  assert.strictEqual((await home.untilXt("rj"))[3], "denAnn");
  home.socket.destroy();
  b.socket.destroy();
};

harness.withServer("comforts test", HTTP_PORT, GAME_PORT, run).catch(err => {
  console.error(err);
  process.exit(1);
});

