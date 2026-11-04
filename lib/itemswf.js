"use strict";

const zlib = require("zlib");

// A custom den item with a picture of its own (lib/itemart.js), as the file
// the game itself is given: items/<id> files are one-frame SWFs, and every
// part of the game that shows an item file reads them as such
// (den.DenItemHelper, then den.DenItem.resizeAndPositionIcon, which sizes
// and centres the icon). The picture as a plain bitmap could not be that
// file: resizeAndPositionIcon only knows the game's own art (a Loader's
// content, a MovieClip) and throws on anything else, which was a cell in the
// inventory with no picture in it, and the items after it undrawn too (the
// throwing callback broke the window's painting of the rest). So a picture
// becomes the shape a base item's file is: a bitmap character that a shape
// of the picture's size fills (a JPEG is carried as it is), and the file is
// served as item files are (lib/http.js, wrapped as {ba, so}).
//
// also here, since the SWF holds the picture's pixels and not its file: the
// decoders a stored PNG or GIF picture is read with.

// ---------- PNG to pixels ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};

// PNG filter 4's neighbour average, rounded down
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// the pixels of `lines` rows of one PNG image (a whole picture, or one
// Adam7 pass): `raw`, from `at`, is defiltered into `out`, rows top down;
// the new position, or null for a filter control that says nothing.
const defilter = (raw, at, out, lines, rowBytes, shift) => {
  let previous = Buffer.alloc(rowBytes + shift);
  for (let y = 0; y < lines; y++) {
    const filter = raw[at++];
    if (filter > 4 || at + rowBytes > raw.length) {
      return null;
    }
    const row = Buffer.alloc(rowBytes + shift);
    raw.copy(row, shift, at, at + rowBytes);
    at += rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const a = row[i];
      const b = previous[shift + i];
      const c = previous[i];
      let value = row[shift + i];
      if (filter === 1) {
        value += a;
      }
      else if (filter === 2) {
        value += b;
      }
      else if (filter === 3) {
        value += (a + b) >>> 1;
      }
      else if (filter === 4) {
        value += paeth(a, b, c);
      }
      row[shift + i] = value & 0xff;
    }
    out.set(row.subarray(shift), y * rowBytes);
    previous = row;
  }
  return at;
};

// a sample (index `n`) of a row of defiltered bytes; PNG packs 1-, 2- and
// 4-bit samples more than one to a byte, most-significant bits first
const sampleOf = (row, bits, n) => {
  if (bits < 8) {
    const bit = n * bits;
    return (row[bit >>> 3] >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
  }
  return bits === 16 ? row[n * 2] : row[n];
};

// a sample as a channel of 0-255: 8-bit samples are ones, 16-bit ones by
// their high byte, and smaller ones spread their value over a whole byte
const spread = (value, bits) => bits < 8 ? Math.round(value * 255 / ((1 << bits) - 1)) : value;

const readPng = data => {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  let width = 0;
  let height = 0;
  let bits = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let plte = null;
  let trns = null;
  let at = 8;
  let ended = false;
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    if (at + 12 + length > data.length) {
      return null;
    }
    const type = data.toString("latin1", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bits = body[8];
      colorType = body[9];
      interlace = body[12];
    }
    else if (type === "PLTE") {
      plte = body;
    }
    else if (type === "tRNS") {
      trns = body;
    }
    else if (type === "IDAT") {
      idat.push(body);
    }
    else if (type === "IEND") {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  const channels = PNG_CHANNELS[colorType];
  if (!ended || !channels || idat.length === 0 || width < 1 || height < 1 || width * height > (1 << 28)
    || (colorType === 2 || colorType === 6) && ![8, 16].includes(bits)
    || colorType === 3 && (!plte || ![1, 2, 4, 8].includes(bits))
    || (colorType === 0 || colorType === 4) && ![1, 2, 4, 8, 16].includes(bits)
    || interlace > 1) {
    return null;
  }
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  }
  catch {
    return null;
  }
  return {width, height, bits, channels, colorType, interlace, raw, plte, trns};
};

// a whole stored PNG as RGBA pixels, or null; kept pictures (lib/itemart.js
// cleanPng) are checked whole when their upload arrives, and this walks a
// second time with what the pixels' own bytes require.
const decodePng = data => {
  const header = readPng(data);
  if (!header) {
    return null;
  }
  const {width, height, bits, channels, colorType, interlace, raw, plte, trns} = header;
  // the sample the picture's tRNS treats as clear, as the PNG standards
  // store the image's own samples: right in the bits they are made of
  const clearOf = at => trns && trns.length >= 2 ? (bits === 16 ? trns.readUInt16BE(at) : trns.readUInt16BE(at) & ((1 << bits) - 1)) : null;
  const pixels = new Uint8Array(width * height * 4);
  // one image's rows (the whole picture, or an Adam7 pass) widened and
  // painted by its colour type; every pixel put where the file's grid says
  const paint = (rows, stride, subWidth, subHeight, x0, y0, stepX, stepY) => {
    // a sample of `n` as the value its file has it in (16-bit samples the
    // whole 16 bits, which the transparency colour is compared with)
    const rawSample = (row, bits, n) => bits === 16 ? row[n * 2] << 8 | row[n * 2 + 1] : sampleOf(row, bits, n);
    const eye = (row, bits, n) => bits === 16 ? row[n * 2] : spread(sampleOf(row, bits, n), bits);
    for (let y = 0; y < subHeight; y++) {
      const row = rows.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < subWidth; x++) {
        const pixel = ((y0 + y * stepY) * width + x0 + x * stepX) * 4;
        let alpha = 255;
        if (colorType === 0) {
          const own = clearOf(0);
          const value = rawSample(row, bits, x);
          pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = eye(row, bits, x);
          alpha = own !== null && value === own ? 0 : 255;
        }
        else if (colorType === 2) {
          const own = trns && trns.length >= 6 && colorType === 2 ? [clearOf(0), clearOf(2), clearOf(4)] : null;
          const value = [0, 1, 2].map(channel => rawSample(row, bits, x * 3 + channel));
          pixels[pixel] = eye(row, bits, x * 3);
          pixels[pixel + 1] = eye(row, bits, x * 3 + 1);
          pixels[pixel + 2] = eye(row, bits, x * 3 + 2);
          alpha = own && value[0] === own[0] && value[1] === own[1] && value[2] === own[2] ? 0 : 255;
        }
        else if (colorType === 3) {
          const index = sampleOf(row, bits, x);
          if (index * 3 + 3 > plte.length) {
            return false;
          }
          pixels[pixel] = plte[index * 3];
          pixels[pixel + 1] = plte[index * 3 + 1];
          pixels[pixel + 2] = plte[index * 3 + 2];
          alpha = trns && index < trns.length ? trns[index] : 255;
        }
        else if (colorType === 4) {
          pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = eye(row, bits, x * 2);
          alpha = eye(row, bits, x * 2 + 1);
        }
        else {
          pixels[pixel] = eye(row, bits, x * 4);
          pixels[pixel + 1] = eye(row, bits, x * 4 + 1);
          pixels[pixel + 2] = eye(row, bits, x * 4 + 2);
          alpha = eye(row, bits, x * 4 + 3);
        }
        pixels[pixel + 3] = alpha;
      }
    }
    return true;
  };
  // filter shift so each byte defilters against its own row's left neighbour
  const shift = Math.max(1, (channels * bits) >>> 3);
  if (interlace === 0) {
    const rowBytes = Math.ceil(width * channels * bits / 8);
    const rows = Buffer.alloc(rowBytes * height);
    if (defilter(raw, 0, rows, height, rowBytes, shift) === null) {
      return null;
    }
    if (!paint(rows, rowBytes, width, height, 0, 0, 1, 1)) {
      return null;
    }
  }
  else {
    // Adam7, seven passes over sparse grids of the picture
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    let at = 0;
    for (const [x0, y0, stepX, stepY] of passes) {
      const subWidth = Math.ceil((width - x0) / stepX);
      const subHeight = Math.ceil((height - y0) / stepY);
      const rowBytes = Math.ceil(subWidth * channels * bits / 8);
      if (subWidth < 1 || subHeight < 1) {
        if (rowBytes > 0) {
          return null; // a pass with rows but no cells would be a broken file
        }
        continue;
      }
      const rows = Buffer.alloc(rowBytes * subHeight);
      at = defilter(raw, at, rows, subHeight, rowBytes, shift);
      if (at === null || !paint(rows, rowBytes, subWidth, subHeight, x0, y0, stepX, stepY)) {
        return null;
      }
    }
  }
  return {width, height, pixels: Buffer.from(pixels)};
};

// ---------- GIF to pixels ----------

// a GIF's LZW: the palette indices an image paints, in order; null when it
// is not one this can read.
const lzwDecode = (codes, smallest, count) => {
  if (smallest < 2) {
    return null;
  }
  const clear = 1 << smallest;
  const end = clear + 1;
  let size = smallest + 1;
  let next = end + 1;
  let previous = null;
  const dictionary = [];
  for (let i = 0; i < clear; i++) {
    dictionary[i] = Buffer.from([i]);
  }
  const out = new Uint8Array(count);
  let written = 0;
  let at = 0; // a bit reader over `codes`, least-significant bit first
  let accumulator = 0;
  let bits = 0;
  while (written < count) {
    while (bits < size && at < codes.length) {
      accumulator += codes[at++] << bits;
      bits += 8;
    }
    if (bits < size) {
      return null; // the codes end before the image is whole
    }
    const code = accumulator & ((1 << size) - 1);
    accumulator >>= size;
    bits -= size;
    if (code === clear) {
      size = smallest + 1;
      next = end + 1;
      previous = null;
      continue;
    }
    if (code === end) {
      return null;
    }
    let entry;
    if (previous === null) {
      entry = dictionary[code];
      if (entry === undefined) {
        return null;
      }
    }
    else if (code < next) {
      entry = dictionary[code];
      if (next < (1 << 12)) { // the dictionary is full: codes stop being added
        dictionary[next++] = Buffer.concat([dictionary[previous], entry.subarray(0, 1)]);
        if (next === (1 << size) && size < 12) {
          size++;
        }
      }
    }
    else if (code === next) {
      if (next >= (1 << 12)) {
        return null;
      }
      entry = Buffer.concat([dictionary[previous], dictionary[previous].subarray(0, 1)]);
      dictionary[next++] = entry;
      if (next === (1 << size) && size < 12) {
        size++;
      }
    }
    else {
      return null; // a code that says nothing yet
    }
    const copied = Math.min(entry.length, count - written);
    out.set(entry.subarray(0, copied), written);
    written += copied;
    previous = code;
  }
  return out;
};

// a whole stored GIF as RGBA pixels: its first image; null when it is not
// one this can read. a GIF of many frames sways in the pages only: the
// item's file carries its first frame.
const decodeGif = data => {
  if (data.length < 13 || (data.toString("latin1", 0, 6) !== "GIF87a" && data.toString("latin1", 0, 6) !== "GIF89a")) {
    return null;
  }
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  const packed = data[10];
  const global = packed & 0x80 ? data.subarray(13, 13 + 3 * (2 << (packed & 7))) : null;
  let at = 13 + (global ? global.length : 0);
  if (at > data.length) {
    return null;
  }
  let transparent = -1;
  let firstImage = null;
  while (at < data.length) {
    const marker = data[at++];
    if (marker === 0x3b) {
      return null; // no image in the file
    }
    if (marker === 0x21) {
      const label = data[at++];
      if (at >= data.length) {
        return null;
      }
      if (label === 0xf9 && data[at] >= 4 && data[at + 1] & 1) {
        transparent = data[at + 4];
      }
      let size = data[at];
      if (size === undefined) {
        return null;
      }
      while (size !== 0) {
        at += size + 1;
        if (at >= data.length) {
          return null;
        }
        size = data[at];
      }
      at++;
      continue;
    }
    if (marker === 0x2c) {
      firstImage = at;
      break;
    }
    return null; // a block this does not know
  }
  if (firstImage === null || firstImage + 10 > data.length) {
    return null;
  }
  const left = data.readUInt16LE(firstImage);
  const top = data.readUInt16LE(firstImage + 2);
  const imageWidth = data.readUInt16LE(firstImage + 4);
  const imageHeight = data.readUInt16LE(firstImage + 6);
  const imagePacked = data[firstImage + 8];
  if (left >= width || top >= height || imageWidth < 1 || imageHeight < 1
    || left + imageWidth > width || top + imageHeight > height) {
    return null;
  }
  let palette;
  let at2 = firstImage + 9;
  if (imagePacked & 0x80) {
    const length = 3 * (2 << (imagePacked & 7));
    if (at2 + length > data.length) {
      return null;
    }
    palette = data.subarray(at2, at2 + length);
    at2 += length;
  }
  else {
    if (!global) {
      return null; // an image with no palette of its own, or of the file's
    }
    palette = global;
  }
  if (at2 >= data.length) {
    return null;
  }
  const smallest = data[at2++];
  if (smallest > 7) {
    return null;
  }
  const codes = [];
  while (at2 < data.length) {
    const length = data[at2++];
    if (length === 0) {
      break;
    }
    if (at2 + length > data.length) {
      return null;
    }
    codes.push(data.subarray(at2, at2 + length));
    at2 += length;
  }
  const indices = lzwDecode(Buffer.concat(codes), smallest, imageWidth * imageHeight);
  if (!indices) {
    return null;
  }
  // indices paint in rows; a plain image straight through, an interlaced one
  // through the order GIF writes its lines in (four passes)
  const rows = [];
  if (imagePacked & 0x40) {
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
      for (let y = start; y < imageHeight; y += step) {
        rows.push(y);
      }
    }
  }
  else {
    for (let y = 0; y < imageHeight; y++) {
      rows.push(y);
    }
  }
  if (rows.length !== imageHeight) {
    return null;
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let imageY = 0; imageY < imageHeight; imageY++) {
    const atRow = (top + rows[imageY]) * width * 4 + left * 4;
    for (let imageX = 0; imageX < imageWidth; imageX++) {
      const index = indices[imageY * imageWidth + imageX];
      const pixel = atRow + imageX * 4;
      if (index * 3 + 2 < palette.length) {
        pixels[pixel] = palette[index * 3];
        pixels[pixel + 1] = palette[index * 3 + 1];
        pixels[pixel + 2] = palette[index * 3 + 2];
        pixels[pixel + 3] = index === transparent ? 0 : 255;
      }
    }
  }
  return {width, height, pixels};
};

// ---------- picture to SWF ----------

// how large a picture item's file stands: a den item's icon is drawn fitted
// to 168 or 80, its standing on a spot to the spot's own scale, so 160 keeps
// a picture from standing hugely larger than the game's things ever are
const STAND = 160;

// the bits a signed value is written in: one more than its unsigned count
const fittingBits = value => value === 0 ? 1 : 32 - Math.clz32(Math.abs(value)) + 1;

// a bag of bits: the fields of SWF records, bit by bit
class Bits {
  constructor() {
    this.bytes = []; // the whole bytes written
    this.pending = 0; // bits of the next byte, held till it is whole
    this.value = 0;
  }

  // `n` unsigned bits, most-significant first
  u(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.value = (this.value << 1) | ((value >>> i) & 1);
      if (++this.pending === 8) {
        this.bytes.push(this.value);
        this.value = 0;
        this.pending = 0;
      }
    }
  }

  // `n` bits of a signed value, in two's complement
  s(value, n) {
    if (value >= (1 << (n - 1)) || value < -(1 << (n - 1))) {
      throw new Error(`a value of ${value} does not go in ${n} bits`);
    }
    this.u(value & ((1 << n) - 1), n);
  }

  // what is written, whatever bits remain padded
  out() {
    this.align();
    return Buffer.from(this.bytes);
  }

  // pad the pending bits with zeros, so the next field starts at a byte
  // (where SWF keeps whole-byte fields)
  align() {
    if (this.pending) {
      this.bytes.push(this.value << (8 - this.pending));
      this.value = 0;
      this.pending = 0;
    }
  }
}

// a RECT: four signed values, in as few bits as the widest of them takes
const rectOf = values => {
  const bits = Math.max(...values.map(fittingBits));
  const bag = new Bits();
  bag.u(bits, 5);
  for (const value of values) {
    bag.s(value, bits);
  }
  return bag.out();
};

// a MATRIX: how much of the shape's twips a pixel of a bitmap fill is
// (nothing of the picture is ever hung or turned)
const matrixOf = scale => {
  const value = Math.round(scale * 20 * 65536); // a fixed 16.16 number
  const bits = fittingBits(value);
  const bag = new Bits();
  bag.u(1, 1); // it scales
  bag.u(bits, 5);
  bag.s(value, bits);
  bag.s(value, bits);
  bag.u(0, 1); // it does not turn
  bag.u(0, 5); // nothing moves it
  return bag.out();
};

// a tag record's bytes
const tagOf = (code, body) => {
  const head = Buffer.alloc(body.length >= 63 ? 6 : 2);
  head.writeUInt16LE((code << 6) | (body.length >= 63 ? 63 : body.length));
  if (body.length >= 63) {
    head.writeUInt32LE(body.length, 2);
  }
  return Buffer.concat([head, body]);
};

const byte16 = value => Buffer.from([value & 0xff, (value >>> 8) & 0xff]); // UI16, least significant byte first
const bytes32 = value => Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);

// a JPEG's size, from its start-of-frame marker (lib/itemart.js cleanJpeg
// reads it the same way)
const jpegSize = data => {
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) {
      return null;
    }
    const marker = data[at + 1];
    if (marker === 0xd9) {
      return null;
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5)};
    }
    at += 2 + data.readUInt16BE(at + 2);
  }
  return null;
};

// a picture (lib/itemart.js file's own {data, type}) as what build takes:
// its pixels, or a JPEG as its own bytes; null when it cannot be read
const fromPicture = picture => {
  if (!picture) {
    return null;
  }
  if (picture.type === "jpeg") {
    const size = jpegSize(picture.data);
    if (!size || size.width < 1 || size.height < 1) {
      return null;
    }
    return {cover: "jpeg", data: picture.data, width: size.width, height: size.height};
  }
  const pixels = picture.type === "png" ? decodePng(picture.data) : decodeGif(picture.data);
  return pixels && {cover: "lossless", width: pixels.width, height: pixels.height, pixels: pixels.pixels};
};

// a MATRIX that only moves a shape: no scale, no turn
const translateMatrixOf = (x, y) => {
  const bits = Math.max(fittingBits(x), fittingBits(y), 1);
  const bag = new Bits();
  bag.u(0, 1); // it does not scale
  bag.u(0, 1); // it does not turn
  bag.u(bits, 5);
  bag.s(x, bits);
  bag.s(y, bits);
  return bag.out();
};

// a picture to one-frame SWF: tags then header, the stage for exactly the
// shape drawn on it, the shape scaled so its greater side is STAND, in
// twips (a twentieth of a pixel each). `anchor` "bottom" puts the picture's
// bottom at the origin and its middle there too, as the game's own pets are
// drawn (feet on the spot, the name tag below): its top-left otherwise, as
// item pictures are.
const build = (image, stand = STAND, anchor = "topLeft") => {
  if (!image || image.width < 1 || image.height < 1
    || image.cover === "jpeg" && !image.data
    || image.cover === "lossless" && (!image.pixels || image.pixels.length < image.width * image.height * 4)) {
    return null;
  }
  // the bitmap character is 1, the shape that fills it 2
  let bitmap;
  if (image.cover === "jpeg") {
    bitmap = tagOf(21, Buffer.concat([byte16(1), image.data])); // DefineBitsJPEG2
  }
  else {
    // DefineBitsLossless2, format 5: pixels as 4 bytes a piece, alpha
    // first, and each colour joined to its alpha (which shows through as
    // dark with nothing over it); the rows are whole, with nothing of a pad
    const rows = Buffer.alloc(image.width * 4 * image.height);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const read = (y * image.width + x) * 4;
        const write = y * (image.width * 4) + x * 4;
        const alpha = image.pixels[read + 3];
        rows[write] = alpha;
        if (alpha === 255) {
          rows[write + 1] = image.pixels[read];
          rows[write + 2] = image.pixels[read + 1];
          rows[write + 3] = image.pixels[read + 2];
        }
        else if (alpha) {
          rows[write + 1] = image.pixels[read] * alpha + 127 >>> 8;
          rows[write + 2] = image.pixels[read + 1] * alpha + 127 >>> 8;
          rows[write + 3] = image.pixels[read + 2] * alpha + 127 >>> 8;
        }
      }
    }
    bitmap = tagOf(36, Buffer.concat([byte16(1), Buffer.from([5]), byte16(image.width), byte16(image.height),
      zlib.deflateSync(rows)]));
  }
  const scale = Math.min(1, (stand || STAND) / Math.max(image.width, image.height));
  const shapeWidth = Math.round(image.width * 20 * scale);
  const shapeHeight = Math.round(image.height * 20 * scale);
  // a pet stands on the origin: its picture centered on it, feet there
  const bottom = anchor === "bottom";
  const placeX = bottom ? -Math.round(shapeWidth / 2) : 0;
  const placeY = bottom ? -shapeHeight : 0;
  // the shape's records: round the rectangle, top-left to top-right, down,
  // left, and up, drawn with the fill style list's one fill (the bitmap)
  const edges = [[shapeWidth, 0], [0, shapeHeight], [-shapeWidth, 0], [0, -shapeHeight]];
  const edgeBits = Math.max(...edges.map(pair => Math.max(fittingBits(pair[0]), fittingBits(pair[1]))));
  const drawn = new Bits();
  drawn.u(0, 1); // not an edge: a style change
  drawn.u(0, 1); // no new styles
  drawn.u(0, 1); // no line style change
  drawn.u(1, 1); // fill style 1 changes (its index follows)
  drawn.u(0, 1); // fill style 0 does not: the fill is the fill of the path
  drawn.u(1, 1); // and the pen moves
  drawn.u(0, 5); // 0 bits of movement: it stays at (0, 0)
  drawn.u(1, 1); // fill style 1: the first style
  for (const [dx, dy] of edges) {
    drawn.u(1, 1); // an edge record
    drawn.u(1, 1); // straight
    drawn.u(edgeBits - 2, 4); // the values fit in `edgeBits` bits
    drawn.u(1, 1); // moving both along and down
    drawn.s(dx, edgeBits);
    drawn.s(dy, edgeBits);
  }
  drawn.u(0, 1); // the end of the shape's records
  drawn.u(0, 5);
  // SHAPEWITHSTYLE: the one fill style as a bitmap fill that repeats along
  // its edges, then the records' bytes. each fill style of the array is byte
  // aligned, and so are the records after the styles' counts.
  const fill = matrixOf(scale);
  const styles = new Bits();
  styles.u(1, 8); // one fill style
  styles.u(0x41, 8); // a bitmap fill, repeated along the edges
  styles.u(1, 8); // the bitmap it fills with: character 1, a UI16 low byte first
  styles.u(0, 8);
  for (const byte of fill) {
    styles.u(byte, 8); // the bitmap fill's matrix, bits of its own
  }
  styles.align(); // the next style would start here; there are none
  styles.u(0, 8); // nothing of a line style
  styles.u(1, 4); // a fill style's index fits a bit
  styles.u(0, 4); // no line style index ever
  for (const byte of drawn.out()) {
    styles.u(byte, 8);
  }
  const shape = Buffer.concat([byte16(2), rectOf([0, shapeWidth, 0, shapeHeight]), styles.out()]);
  // the shape is stood inside a sprite of its own (one frame, the shape at
  // its own place), and the sprite is what stands on the stage: the shape of
  // every one of the game's item files (its own places carry a name, which
  // nothing here reads)
  const emptyMatrix = Buffer.from([0]); // no scale, no turn, nothing moved
  const placeMatrix = bottom ? translateMatrixOf(placeX, placeY) : emptyMatrix;
  const sprite = Buffer.concat([
    byte16(3), // the sprite's own character id
    byte16(1), // one frame
    tagOf(26, Buffer.concat([Buffer.from([0x06]), byte16(1), byte16(2), emptyMatrix])), // the shape at depth 1 in it
    tagOf(1, Buffer.alloc(0)), // its frame
    tagOf(0, Buffer.alloc(0)), // its end
  ]);
  // the tags: what it is, the bitmap and the shape that fills it, the sprite
  // about the shape, the sprite stood on the stage, the frame, the end
  const tags = Buffer.concat([
    tagOf(69, Buffer.from([0x08, 0, 0, 0])), // FileAttributes: ActionScript 3 (the flag byte first, as the real files carry it)
    tagOf(9, Buffer.from([255, 255, 255])), // SetBackgroundColor: like the real files carry (and a renderer needs)
    bitmap,
    tagOf(2, shape), // DefineShape
    tagOf(39, sprite), // DefineSprite
    // PlaceObject2: a place of character 3 at depth 1, at its own place,
    // named (the flags: a character, a matrix, a name)
    tagOf(26, Buffer.concat([Buffer.from([0x26]), byte16(1), byte16(3), placeMatrix,
      Buffer.from("picture", "latin1"), Buffer.alloc(1)])),
    tagOf(1, Buffer.alloc(0)), // ShowFrame
    tagOf(0, Buffer.alloc(0)), // End
  ]);
  const stage = rectOf([placeX, placeX + shapeWidth, placeY, placeY + shapeHeight]); // a RECT is Xmin, Xmax, Ymin, Ymax
  const open = Buffer.concat([Buffer.from("FWS", "latin1"), Buffer.from([9]), bytes32(0), stage, byte16(24 * 256), byte16(1)]); // 24 frames a second, one frame
  open.writeUInt32LE(open.length + tags.length, 4);
  return Buffer.concat([open, tags]);
};

module.exports = {decodePng, decodeGif, fromPicture, build};
