import { describe, expect, it } from 'vitest';

import { encodeQr, QR_BLOCK_LAYOUT, reedSolomonRemainder } from '@/modules/cockpit/cockpitQr';
import type { QrMatrix } from '@/modules/cockpit/cockpitQr';

/**
 * The QR encoder's verification. The symbol this file checks is the one the desktop cockpit
 * draws for the phone-remote link, so "it renders something square" is not enough: a decoder
 * has to get the URL back out of the matrix.
 *
 * THE DECODER IS INDEPENDENT OF THE ENCODER. It re-derives the function-pattern map, reads the
 * format information back out of both copies, unmasks, walks the data zigzag, de-interleaves
 * the codeword blocks and parses the byte-mode segment. A shared bug in the data path would
 * have to be mirrored here as well to stay green — the encoder writes the matrix, the decoder
 * only ever reads it.
 */

// --------------------------- an independent GF(256) ------------

const EXP: number[] = [];
const LOG: number[] = [];
{
  let value = 1;
  for (let exponent = 0; exponent < 255; exponent += 1) {
    EXP[exponent] = value;
    LOG[value] = exponent;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
}

const mul = (left: number, right: number): number =>
  left === 0 || right === 0 ? 0 : EXP[(LOG[left]! + LOG[right]!) % 255]!;

/** Evaluates a high-first codeword polynomial at `x` in GF(256). */
const evaluate = (codeword: readonly number[], x: number): number => {
  let value = 0;
  for (const coefficient of codeword) value = mul(value, x) ^ coefficient;
  return value;
};

// --------------------------- reading the symbol ------------

/**
 * The modules a decoder must skip: finders with separators, timing, alignment, both format
 * bands, the dark module, and (from version 7) both version-information blocks. Derived from
 * the geometry alone, exactly as a reader that never saw the encoder would.
 */
function functionModules(version: number): boolean[][] {
  const size = version * 4 + 17;
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, column: number): void => {
    if (row >= 0 && column >= 0 && row < size && column < size) reserved[row]![column] = true;
  };
  const markFinder = (top: number, left: number): void => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) mark(top + dy, left + dx);
    }
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i);
    mark(i, 6);
  }

  const centres: Record<number, number[]> = {
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
  const list = centres[version] ?? [];
  const last = list[list.length - 1];
  for (const row of list) {
    for (const column of list) {
      if ((row === 6 && column === 6) || (row === 6 && column === last) || (row === last && column === 6)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(row + dy, column + dx);
      }
    }
  }

  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  mark(size - 8, 8);

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(b, a);
      mark(a, b);
    }
  }
  return reserved;
}

const isDark = (matrix: QrMatrix, row: number, column: number): boolean =>
  matrix.modules[row]?.[column] === true;

/** Reads the 15 format bits from the copy around the top-left finder (LSB-first). */
function readFormatBits(matrix: QrMatrix): number {
  let bits = 0;
  const read = (row: number, column: number, index: number): void => {
    if (isDark(matrix, row, column)) bits |= 1 << index;
  };
  for (let i = 0; i < 6; i += 1) read(i, 8, i);
  read(7, 8, 6);
  read(8, 8, 7);
  read(8, 7, 8);
  for (let i = 9; i < 15; i += 1) read(8, 14 - i, i);
  return bits;
}

/** The second format copy: bits 0…7 along row 8, bits 8…14 up column 8. */
function readFormatBitsMirror(matrix: QrMatrix): number {
  let bits = 0;
  const size = matrix.size;
  const read = (row: number, column: number, index: number): void => {
    if (isDark(matrix, row, column)) bits |= 1 << index;
  };
  for (let i = 0; i < 8; i += 1) read(8, size - 1 - i, i);
  for (let i = 8; i < 15; i += 1) read(size - 15 + i, 8, i);
  return bits;
}

/** Strips the `0x5412` mask and checks the 10-bit BCH, returning the 5 data bits. */
function decodeFormatBits(bits: number): number {
  const unmasked = bits ^ 0x5412;
  let remainder = unmasked;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (((remainder >>> bit) & 1) === 1) remainder ^= 0x537 << (bit - 10);
  }
  expect(remainder, `format information ${bits.toString(2)} fails its BCH check`).toBe(0);
  return (unmasked >>> 10) & 0x1f;
}

/** The 18 version bits, read from the bottom-left block. */
function readVersionBits(matrix: QrMatrix): number {
  let bits = 0;
  const size = matrix.size;
  for (let i = 0; i < 18; i += 1) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    if (isDark(matrix, a, b)) bits |= 1 << i;
  }
  return bits;
}

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

/** Unmasks and reads the zigzag, yielding the interleaved codewords. */
function readCodewords(matrix: QrMatrix, mask: number): number[] {
  const reserved = functionModules(matrix.version);
  const predicate = MASK_PREDICATES[mask]!;
  const bits: number[] = [];
  let upward = true;
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < matrix.size; step += 1) {
      const row = upward ? matrix.size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        if (reserved[row]![column] === true) continue;
        const raw = isDark(matrix, row, column);
        bits.push(raw !== predicate(row, column) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index + bit]!;
    codewords.push(value);
  }
  return codewords;
}

/** Reverse of the encoder's interleaving: the blocks, with their data and EC halves. */
function splitBlocks(
  version: number,
  codewords: readonly number[],
): { data: number[]; ec: number[] }[] {
  const layout = QR_BLOCK_LAYOUT[version]!;
  const blocks = layout.dataCodewords.map((length) => ({
    data: new Array<number>(length).fill(0),
    ec: new Array<number>(layout.ecPerBlock).fill(0),
  }));
  let cursor = 0;
  const longest = Math.max(...layout.dataCodewords);
  for (let index = 0; index < longest; index += 1) {
    for (let block = 0; block < blocks.length; block += 1) {
      if (index < blocks[block]!.data.length) {
        blocks[block]!.data[index] = codewords[cursor]!;
        cursor += 1;
      }
    }
  }
  for (let index = 0; index < layout.ecPerBlock; index += 1) {
    for (const block of blocks) {
      block.ec[index] = codewords[cursor]!;
      cursor += 1;
    }
  }
  return blocks;
}

/** Reads one symbol back to the text it carries. Throws if the structure is not a valid symbol. */
function decode(matrix: QrMatrix): string {
  // Both format copies must agree and describe level M and the symbol's own mask.
  const format = decodeFormatBits(readFormatBits(matrix));
  expect(format >> 3, 'format information is level M (00)').toBe(0b00);
  const mask = format & 0b111;
  expect(mask, 'the declared mask is the one the matrix was drawn with').toBe(matrix.mask);
  expect(readFormatBitsMirror(matrix), 'both format copies agree').toBe(readFormatBits(matrix));

  if (matrix.version >= 7) {
    const bits = readVersionBits(matrix);
    let remainder = bits;
    for (let bit = 17; bit >= 12; bit -= 1) {
      if (((remainder >>> bit) & 1) === 1) remainder ^= 0x1f25 << (bit - 12);
    }
    expect(remainder & 0xfff, 'version information passes its BCH check').toBe(0);
    expect(bits >>> 12, 'version information names the symbol version').toBe(matrix.version);
  }

  // Every block must be a valid Reed–Solomon codeword: all ec syndromes zero.
  const blocks = splitBlocks(matrix.version, readCodewords(matrix, mask));
  for (const block of blocks) {
    const codeword = [...block.data, ...block.ec];
    for (let syndrome = 0; syndrome < block.ec.length; syndrome += 1) {
      expect(
        evaluate(codeword, EXP[syndrome]!),
        `Reed–Solomon syndrome ${syndrome} is non-zero`,
      ).toBe(0);
    }
  }

  // Concatenate the data halves in block order, then parse mode / count / bytes.
  const data = blocks.flatMap((block) => block.data);
  const bits: number[] = [];
  for (const byte of data) {
    for (let bit = 7; bit >= 0; bit -= 1) bits.push((byte >>> bit) & 1);
  }
  let cursor = 0;
  const take = (length: number): number => {
    let value = 0;
    for (let index = 0; index < length; index += 1) value = (value << 1) | bits[cursor + index]!;
    cursor += length;
    return value;
  };
  expect(take(4), 'the first segment is byte mode').toBe(0b0100);
  const count = take(matrix.version < 10 ? 8 : 16);
  const bytes: number[] = [];
  for (let index = 0; index < count; index += 1) bytes.push(take(8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

// --------------------------- the checks ------------

/** The official version-1…10 level-M byte capacities (ISO/IEC 18004 Table 7). */
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

describe('the QR encoder the cockpit draws its remote link with', () => {
  it('round-trips the remote URL through an independent decoder', () => {
    const url = 'https://cockpit.example.test:8443/cockpit/remote';
    const matrix = encodeQr(url);
    expect(matrix.size).toBe(matrix.version * 4 + 17);
    expect(decode(matrix)).toBe(url);
  });

  it('covers a short origin and a long IPv6 origin', () => {
    for (const url of [
      'http://localhost:3000/cockpit/remote',
      'https://[2001:db8::1]:8443/cockpit/remote?from=qr',
    ]) {
      expect(decode(encodeQr(url))).toBe(url);
    }
  });

  it('draws the three finder patterns, their separators, the timing rows and the dark module', () => {
    const matrix = encodeQr('https://a.example/cockpit/remote');
    const corners = [
      [0, 0],
      [0, matrix.size - 7],
      [matrix.size - 7, 0],
    ] as const;
    for (const [top, left] of corners) {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const expected =
            dy === 0 || dy === 6 || dx === 0 || dx === 6 ||
            (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4);
          expect(isDark(matrix, top + dy, left + dx), `finder (${top},${left}) at ${dy},${dx}`).toBe(
            expected,
          );
        }
      }
    }
    for (let index = 8; index < matrix.size - 8; index += 1) {
      expect(isDark(matrix, 6, index), `row timing at ${index}`).toBe(index % 2 === 0);
      expect(isDark(matrix, index, 6), `column timing at ${index}`).toBe(index % 2 === 0);
    }
    expect(isDark(matrix, matrix.size - 8, 8), 'the always-dark module').toBe(true);
  });

  it('chooses the smallest version that holds the payload, and refuses what does not fit', () => {
    for (let index = 0; index < BYTE_CAPACITY_M.length; index += 1) {
      const version = index + 1;
      const atCapacity = encodeQr('x'.repeat(BYTE_CAPACITY_M[index]!));
      expect(atCapacity.version, `${BYTE_CAPACITY_M[index]} bytes fits version ${version}`).toBe(version);
      expect(decode(atCapacity)).toBe('x'.repeat(BYTE_CAPACITY_M[index]!));
    }
    expect(() => encodeQr('x'.repeat(BYTE_CAPACITY_M[9]! + 1))).toThrow(/covers up to 213/);
  });

  it('computes Reed–Solomon remainders whose syndromes vanish', () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    const remainder = reedSolomonRemainder(data, 10);
    expect(remainder).toHaveLength(10);
    const codeword = [...data, ...remainder];
    for (let syndrome = 0; syndrome < 10; syndrome += 1) {
      expect(evaluate(codeword, EXP[syndrome]!), `syndrome ${syndrome}`).toBe(0);
    }
  });

  it('is deterministic for the same text', () => {
    const first = encodeQr('https://example.test/cockpit/remote');
    const second = encodeQr('https://example.test/cockpit/remote');
    expect(second.version).toBe(first.version);
    expect(second.mask).toBe(first.mask);
    expect(second.modules).toEqual(first.modules);
  });
});
