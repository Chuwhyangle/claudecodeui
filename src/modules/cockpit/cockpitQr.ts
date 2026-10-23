/**
 * A QR Code (Model 2) encoder, small enough to live beside the cockpit.
 *
 * WHY THIS EXISTS. The desktop stage shows a code the phone scans to reach `/cockpit/remote`.
 * The alternative was a QR package, but the cockpit's only use is one short URL: a dependency
 * would add a supply-chain surface and a bundle to a surface that is otherwise a pure render.
 * So this file implements the slice of ISO/IEC 18004 the remote link needs — byte mode, error
 * correction level M, versions 1…10 — and nothing else.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE. Other modes (numeric, alphanumeric, kanji) and versions
 * above 10 would never be reached by an origin + `/cockpit/remote` (213 bytes in byte mode at
 * version 10-M is several times the longest URL a browser will produce), and every branch that
 * cannot be reached is a branch nobody reads. {@link encodeQr} throws rather than silently
 * truncating when the input does not fit.
 *
 * The matrix is returned as `modules[row][column]`, `true` = dark, so a renderer can walk it
 * without knowing anything about QR. Function patterns, format information and the chosen mask
 * are already applied: the matrix is the finished symbol.
 */

/** One finished symbol. `size` is the module count per side (`4 * version + 17`). */
export type QrMatrix = {
  version: number;
  size: number;
  /** The mask that produced the lowest penalty, 0…7. */
  mask: number;
  modules: boolean[][];
};

/** Error-correction level M: two format bits `00`, ~15 % recovery. */
const EC_LEVEL_BITS = 0b00;

/** Largest version this encoder supports; the byte capacities below stop there. */
const MAX_VERSION = 10;

/**
 * Per-version block layout for level M: total codewords, EC codewords per block, and the data
 * codewords of each block in transmission order (short blocks first, as the spec lists them).
 * The table is repeated from ISO/IEC 18004 Table 9; the totals are asserted in the tests.
 */
export const QR_BLOCK_LAYOUT: Record<
  number,
  { totalCodewords: number; ecPerBlock: number; dataCodewords: number[] }
> = {
  1: { totalCodewords: 26, ecPerBlock: 10, dataCodewords: [16] },
  2: { totalCodewords: 44, ecPerBlock: 16, dataCodewords: [28] },
  3: { totalCodewords: 70, ecPerBlock: 26, dataCodewords: [44] },
  4: { totalCodewords: 100, ecPerBlock: 18, dataCodewords: [32, 32] },
  5: { totalCodewords: 134, ecPerBlock: 24, dataCodewords: [43, 43] },
  6: { totalCodewords: 172, ecPerBlock: 16, dataCodewords: [27, 27, 27, 27] },
  7: { totalCodewords: 196, ecPerBlock: 18, dataCodewords: [31, 31, 31, 31] },
  8: { totalCodewords: 242, ecPerBlock: 22, dataCodewords: [38, 38, 39, 39] },
  9: { totalCodewords: 292, ecPerBlock: 22, dataCodewords: [36, 36, 36, 37, 37] },
  10: { totalCodewords: 346, ecPerBlock: 26, dataCodewords: [43, 43, 43, 43, 44] },
};

/** Alignment-pattern centre coordinates per version (QR versions 1…10). */
const ALIGNMENT_CENTRES: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// --------------------------- GALOIS FIELD GF(256) ------------

/** The field's reducing polynomial, `x^8 + x^4 + x^3 + x^2 + 1`, as the spec defines QR's field. */
const GF_EXP: number[] = [];
const GF_LOG: number[] = [];

(() => {
  let value = 1;
  for (let exponent = 0; exponent < 255; exponent += 1) {
    GF_EXP[exponent] = value;
    GF_LOG[value] = exponent;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
})();

const gfMultiply = (left: number, right: number): number => {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[(GF_LOG[left] + GF_LOG[right]) % 255];
};

/**
 * The generator polynomial for `degree` EC codewords, as coefficients high-to-low with the
 * leading 1 included: `(x - α^0)(x - α^1)…(x - α^(degree-1))`.
 */
function generatorPolynomial(degree: number): number[] {
  let polynomial = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= gfMultiply(polynomial[j], GF_EXP[i]);
    }
    polynomial = next;
  }
  return polynomial;
}

/** The `degree` Reed–Solomon codewords for one block, by polynomial long division. */
export function reedSolomonRemainder(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      // The generator's leading coefficient is 1 (stripped here: index i + 1).
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// --------------------------- BIT STREAM ------------

/** An append-only bit buffer, MSB first — the order QR's data placement reads. */
class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }
}

/** The character-count field's width in byte mode: 8 bits below version 10, 16 from it. */
const charCountBits = (version: number): number => (version < 10 ? 8 : 16);

/** Bytes of UTF-8 payload one version holds, after the mode and count fields. */
function byteCapacity(version: number): number {
  const layout = QR_BLOCK_LAYOUT[version];
  if (layout === undefined) throw new Error(`no QR block layout for version ${version}`);
  const dataBits = layout.dataCodewords.reduce((total, count) => total + count * 8, 0);
  return Math.floor((dataBits - 4 - charCountBits(version)) / 8);
}

/** The smallest version that holds `byteLength` bytes at level M; throws when none does. */
function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteCapacity(version) >= byteLength) return version;
  }
  throw new Error(
    `QR payload is ${byteLength} bytes; this encoder covers up to ${byteCapacity(MAX_VERSION)} (version ${MAX_VERSION}, level M)`,
  );
}

// --------------------------- MATRIX BUILD ------------

/** A module whose final colour is data-dependent; `null` until the masked data is written. */
type MutableMatrix = {
  version: number;
  size: number;
  modules: (boolean | null)[][];
  /** True for function patterns and reserved areas — never masked, never data. */
  reserved: boolean[][];
};

const createMatrix = (version: number): MutableMatrix => {
  const size = version * 4 + 17;
  return {
    version,
    size,
    modules: Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
};

const setFunction = (matrix: MutableMatrix, row: number, column: number, dark: boolean): void => {
  matrix.modules[row]![column] = dark;
  matrix.reserved[row]![column] = true;
};

/** A 7×7 finder pattern with its light separator, drawn around a top-left corner. */
function drawFinder(matrix: MutableMatrix, top: number, left: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const row = top + dy;
      const column = left + dx;
      if (row < 0 || column < 0 || row >= matrix.size || column >= matrix.size) continue;
      const inside = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
      const dark =
        inside &&
        ((dy === 0 || dy === 6) ||
          (dx === 0 || dx === 6) ||
          (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
      setFunction(matrix, row, column, dark);
    }
  }
}

/** The 5×5 alignment pattern centred on (row, column). */
function drawAlignment(matrix: MutableMatrix, row: number, column: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dark = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
      setFunction(matrix, row + dy, column + dx, dark);
    }
  }
}

/** Reserves the two format-information bands (the values are written once the mask is chosen). */
function reserveFormatAreas(matrix: MutableMatrix): void {
  const last = matrix.size - 1;
  for (let i = 0; i <= 8; i += 1) {
    if (!matrix.reserved[8]![i]) setFunction(matrix, 8, i, false);
    if (!matrix.reserved[i]![8]) setFunction(matrix, i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(matrix, 8, last - i, false);
    setFunction(matrix, last - i, 8, false);
  }
  // The always-dark module, part of the top-left format band's surroundings.
  setFunction(matrix, matrix.size - 8, 8, true);
}

/** Draws every pattern that does not depend on the data or the mask. */
function drawFunctionPatterns(matrix: MutableMatrix): void {
  const { size, version } = matrix;
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, 0, size - 7);
  drawFinder(matrix, size - 7, 0);

  // Timing patterns: row 6 and column 6, dark at even coordinates.
  for (let i = 8; i < size - 8; i += 1) {
    setFunction(matrix, 6, i, i % 2 === 0);
    setFunction(matrix, i, 6, i % 2 === 0);
  }

  const centres = ALIGNMENT_CENTRES[version] ?? [];
  const lastCentre = centres[centres.length - 1];
  for (const row of centres) {
    for (const column of centres) {
      // The three finder corners already own their area; the alignment grid skips them.
      const overlapsFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === lastCentre) ||
        (row === lastCentre && column === 6);
      if (overlapsFinder) continue;
      drawAlignment(matrix, row, column);
    }
  }

  reserveFormatAreas(matrix);

  // Version information (18 bits, twice) exists from version 7 on.
  if (version >= 7) {
    const bits = versionInformationBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(matrix, b, a, dark);
      setFunction(matrix, a, b, dark);
    }
  }
}

/** 6 version bits + 12 BCH bits, the trailing 12 computed with generator `0x1F25`. */
function versionInformationBits(version: number): number {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if (((remainder >>> bit) & 1) === 1) remainder ^= 0x1f25 << (bit - 12);
  }
  return (version << 12) | (remainder & 0xfff);
}

/** 5 format bits + 10 BCH bits, XORed with the spec's `0x5412` mask. */
function formatInformationBits(mask: number): number {
  const data = (EC_LEVEL_BITS << 3) | mask;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (((remainder >>> bit) & 1) === 1) remainder ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** Writes the 15 format bits into both copies of the band. */
function writeFormatInformation(matrix: MutableMatrix, mask: number): void {
  const bits = formatInformationBits(mask);
  const size = matrix.size;
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    // Copy 1, around the top-left finder: bits 0…5 climb column 8, 6…8 cross the corner,
    // and 9…14 run left along row 8.
    if (i < 6) matrix.modules[i]![8] = dark;
    else if (i === 6) matrix.modules[7]![8] = dark;
    else if (i === 7) matrix.modules[8]![8] = dark;
    else if (i === 8) matrix.modules[8]![7] = dark;
    else matrix.modules[8]![14 - i] = dark;
    // Copy 2, split between the bottom-left (bits 0…7) and top-right (bits 8…14) corners.
    if (i < 8) matrix.modules[8]![size - 1 - i] = dark;
    else matrix.modules[size - 15 + i]![8] = dark;
  }
}

/** The eight mask predicates (row, column) → whether a data module is inverted. */
const MASK_PREDICATES: ReadonlyArray<(row: number, column: number) => boolean> = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/**
 * Writes the interleaved codeword bits into the matrix in the spec's two-column zigzag,
 * starting bottom-right, skipping column 6 (the vertical timing pattern) and every reserved
 * module, and applying `mask` to each data module.
 */
function placeData(matrix: MutableMatrix, codewords: readonly number[], mask: number): void {
  const predicate = MASK_PREDICATES[mask];
  if (predicate === undefined) throw new Error(`no QR mask ${mask}`);
  const { size } = matrix;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // The vertical timing column is not a data column.
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        if (matrix.reserved[row]![column] === true) continue;
        const bit =
          bitIndex < codewords.length * 8
            ? (codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1
            : 0;
        bitIndex += 1;
        matrix.modules[row]![column] = (bit === 1) !== predicate(row, column);
      }
    }
    upward = !upward;
  }
  if (bitIndex < codewords.length * 8) {
    throw new Error(`QR matrix is too small: ${bitIndex} of ${codewords.length * 8} data bits placed`);
  }
}

/** A run's penalty: 3 for five same-coloured modules, 1 more for each beyond. */
const runPenalty = (length: number): number => (length >= 5 ? 3 + (length - 5) : 0);

/** The four penalty rules of ISO/IEC 18004 §8.8.2, summed. */
function penalty(matrix: MutableMatrix): number {
  const { size } = matrix;
  const dark = (row: number, column: number): boolean => matrix.modules[row]![column] === true;
  let total = 0;

  // Rule 1 — runs of five or more, in rows and in columns.
  for (let row = 0; row < size; row += 1) {
    let rowRun = 1;
    let columnRun = 1;
    for (let index = 1; index < size; index += 1) {
      if (dark(row, index) === dark(row, index - 1)) rowRun += 1;
      else {
        total += runPenalty(rowRun);
        rowRun = 1;
      }
      if (dark(index, row) === dark(index - 1, row)) columnRun += 1;
      else {
        total += runPenalty(columnRun);
        columnRun = 1;
      }
    }
    total += runPenalty(rowRun) + runPenalty(columnRun);
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const colour = dark(row, column);
      if (
        dark(row, column + 1) === colour &&
        dark(row + 1, column) === colour &&
        dark(row + 1, column + 1) === colour
      ) {
        total += 3;
      }
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 sequence with four light modules on one side.
  const FINDER_LIKE = [true, false, true, true, true, false, true];
  const matches = (values: readonly boolean[], start: number, pattern: readonly boolean[]): boolean =>
    pattern.every((value, index) => values[start + index] === value);
  const rowValues = (row: number): boolean[] =>
    Array.from({ length: size }, (_unused, column) => dark(row, column));
  const columnValues = (column: number): boolean[] =>
    Array.from({ length: size }, (_unused, row) => dark(row, column));
  const countPattern = (values: readonly boolean[]): number => {
    let found = 0;
    for (let start = 0; start + 11 <= values.length; start += 1) {
      const lightBefore =
        matches(values, start, [false, false, false, false]) &&
        matches(values, start + 4, FINDER_LIKE);
      const lightAfter =
        matches(values, start, FINDER_LIKE) &&
        matches(values, start + 7, [false, false, false, false]);
      if (lightBefore) found += 1;
      if (lightAfter) found += 1;
    }
    return found;
  };
  for (let index = 0; index < size; index += 1) {
    total += 40 * countPattern(rowValues(index));
    total += 40 * countPattern(columnValues(index));
  }

  // Rule 4 — deviation of the dark-module share from 50 %, in 5 % steps.
  let darkCount = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (dark(row, column)) darkCount += 1;
    }
  }
  const deviation = Math.abs((darkCount * 100) / (size * size) - 50);
  total += Math.floor(deviation / 5) * 10;

  return total;
}

/** Splits the padded data codewords into blocks, appends EC, and interleaves both runs. */
function interleaveCodewords(version: number, dataCodewords: readonly number[]): number[] {
  const layout = QR_BLOCK_LAYOUT[version];
  if (layout === undefined) throw new Error(`no QR block layout for version ${version}`);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const length of layout.dataCodewords) {
    const data = dataCodewords.slice(offset, offset + length);
    if (data.length !== length) {
      throw new Error(`QR data codewords ended early: ${dataCodewords.length} for version ${version}`);
    }
    offset += length;
    blocks.push({ data, ec: reedSolomonRemainder(data, layout.ecPerBlock) });
  }
  if (offset !== dataCodewords.length) {
    throw new Error(`QR data codeword count ${dataCodewords.length} exceeds version ${version}'s ${offset}`);
  }

  const interleaved: number[] = [];
  const longestData = Math.max(...blocks.map((block) => block.data.length));
  for (let index = 0; index < longestData; index += 1) {
    for (const block of blocks) {
      const value = block.data[index];
      if (value !== undefined) interleaved.push(value);
    }
  }
  for (let index = 0; index < layout.ecPerBlock; index += 1) {
    for (const block of blocks) interleaved.push(block.ec[index]!);
  }
  return interleaved;
}

/**
 * Encodes `text` as a byte-mode, level-M QR symbol over versions 1…10.
 *
 * The mask is chosen the way the spec asks: build all eight, keep the one with the lowest
 * penalty. Ties go to the lower mask index, which keeps the output deterministic.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  const version = chooseVersion(bytes.length);
  const layout = QR_BLOCK_LAYOUT[version]!;

  // Mode (0100), the character count, the payload, the terminator, then the spec's pad bytes.
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4);
  buffer.push(bytes.length, charCountBits(version));
  for (const byte of bytes) buffer.push(byte, 8);
  const capacityBits = layout.dataCodewords.reduce((total, count) => total + count * 8, 0);
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.push(0, terminator);
  while (buffer.length % 8 !== 0) buffer.push(0, 1);
  const dataCodewords: number[] = [];
  for (let index = 0; index < buffer.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | buffer.bits[index + bit]!;
    dataCodewords.push(value);
  }
  const padBytes = [0xec, 0x11];
  for (let index = 0; dataCodewords.length < capacityBits / 8; index += 1) {
    dataCodewords.push(padBytes[index % 2]!);
  }

  const codewords = interleaveCodewords(version, dataCodewords);

  let best: { matrix: MutableMatrix; mask: number; score: number } | null = null;
  for (let mask = 0; mask < MASK_PREDICATES.length; mask += 1) {
    const candidate = createMatrix(version);
    drawFunctionPatterns(candidate);
    placeData(candidate, codewords, mask);
    writeFormatInformation(candidate, mask);
    const score = penalty(candidate);
    if (best === null || score < best.score) best = { matrix: candidate, mask, score };
  }

  const winner = best!;
  return {
    version,
    size: winner.matrix.size,
    mask: winner.mask,
    modules: winner.matrix.modules.map((row) => row.map((module) => module === true)),
  };
}
