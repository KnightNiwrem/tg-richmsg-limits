/**
 * Telegram rich message limit checker.
 *
 * Checks whether an array of {@linkcode InputRichBlock}s (as sent in the
 * `blocks` field of an `InputRichMessage`) adheres to the limits documented
 * in the Telegram Bot API:
 *
 * - Up to 32768 UTF-8 characters in the rich message text, including custom
 *   emoji alternative text and formula source.
 * - Up to 500 blocks, including nested blocks, list items, ordered list items,
 *   table rows, quotation blocks, and details blocks.
 * - Up to 16 levels of nested formatting and blocks.
 * - Up to 50 media attachments in total, including photos, videos, and audio
 *   files.
 * - Up to 20 columns in a table.
 *
 * This module only checks the limits above; it does not validate whether the
 * message would render correctly.
 *
 * @example
 * ```ts
 * import { checkRichBlocks } from "./mod.ts";
 *
 * const result = checkRichBlocks([{ type: "paragraph", text: "Hello" }]);
 * if (!result.ok) {
 *   console.error(result.violations);
 * }
 * ```
 *
 * @module
 */

import type {
  InputRichBlock,
  RichBlockTableCell,
  RichText,
} from "grammy/types";

export type { InputRichBlock, RichBlockTableCell, RichText };

/** The set of numeric limits that a rich message must adhere to. */
export interface RichMessageLimits {
  /** Maximum number of characters in the rich message text. */
  maxTextLength: number;
  /** Maximum number of blocks (incl. nested blocks, list items, table rows). */
  maxBlocks: number;
  /** Maximum number of levels of nested formatting and blocks. */
  maxNestingDepth: number;
  /** Maximum number of media attachments (photos, videos, audio, etc.). */
  maxMediaAttachments: number;
  /** Maximum number of columns in a single table. */
  maxTableColumns: number;
}

/**
 * The default limits, as documented by Telegram for rich messages.
 */
export const RICH_MESSAGE_LIMITS: Readonly<RichMessageLimits> = Object.freeze({
  maxTextLength: 32768,
  maxBlocks: 500,
  maxNestingDepth: 16,
  maxMediaAttachments: 50,
  maxTableColumns: 20,
});

/**
 * How text length is measured.
 *
 * - `"codepoints"` (default): number of Unicode code points. This is what
 *   Telegram means by "UTF-8 characters".
 * - `"utf16"`: number of UTF-16 code units (JavaScript's `string.length`).
 * - `"utf8bytes"`: number of bytes in the UTF-8 encoding.
 */
export type TextLengthMode = "codepoints" | "utf16" | "utf8bytes";

/** Options accepted by {@linkcode checkRichBlocks} and friends. */
export interface CheckOptions {
  /** Override any of the default limits. */
  limits?: Partial<RichMessageLimits>;
  /** How to measure text length. Defaults to `"codepoints"`. */
  textLengthMode?: TextLengthMode;
}

/** Measured statistics of a list of rich blocks. */
export interface RichMessageStats {
  /** Total length of all text, incl. custom emoji alt text and formulas. */
  textLength: number;
  /** Total number of blocks, incl. nested blocks, list items and table rows. */
  blockCount: number;
  /** Deepest level of nesting of formatting and blocks encountered. */
  maxNestingDepth: number;
  /** Total number of media attachments. */
  mediaCount: number;
  /** Largest number of columns found in any single table. */
  maxTableColumns: number;
}

/** A single exceeded limit. */
export interface RichMessageViolation {
  /** Which limit was exceeded. */
  limit: keyof RichMessageLimits;
  /** The measured value. */
  actual: number;
  /** The maximum allowed value. */
  max: number;
  /** A human readable description. */
  message: string;
}

/** The result of {@linkcode checkRichBlocks}. */
export interface RichMessageCheckResult {
  /** `true` if no limit was exceeded. */
  ok: boolean;
  /** The measured statistics. */
  stats: RichMessageStats;
  /** All exceeded limits (empty if `ok` is `true`). */
  violations: RichMessageViolation[];
}

/** Error thrown by {@linkcode assertRichBlocks}. */
export class RichMessageLimitError extends Error {
  /** Always `"RichMessageLimitError"`. */
  override readonly name = "RichMessageLimitError";
  /** The full check result that caused this error. */
  readonly result: RichMessageCheckResult;

  /** Creates a new error from a failed check result. */
  constructor(result: RichMessageCheckResult) {
    super(
      "Rich message exceeds Telegram limits: " +
        result.violations.map((v) => v.message).join("; "),
    );
    this.result = result;
  }
}

const utf8Encoder = new TextEncoder();

/**
 * Measures the length of a string according to the given mode.
 *
 * @param text The string to measure.
 * @param mode The measurement mode. Defaults to `"codepoints"`.
 * @returns The measured length.
 */
export function measureTextLength(
  text: string,
  mode: TextLengthMode = "codepoints",
): number {
  switch (mode) {
    case "utf16":
      return text.length;
    case "utf8bytes":
      return utf8Encoder.encode(text).length;
    case "codepoints": {
      let n = 0;
      for (const _ of text) n++;
      return n;
    }
  }
}

/** Mutable accumulator used while walking the block tree. */
interface Accumulator {
  textLength: number;
  blockCount: number;
  maxNestingDepth: number;
  mediaCount: number;
  maxTableColumns: number;
  mode: TextLengthMode;
}

function bump(acc: Accumulator, depth: number): void {
  if (depth > acc.maxNestingDepth) acc.maxNestingDepth = depth;
}

function addText(acc: Accumulator, text: string): void {
  acc.textLength += measureTextLength(text, acc.mode);
}

/**
 * Walks a {@linkcode RichText} value.
 *
 * `depth` is the nesting depth of the *container* of this text. Plain strings
 * and arrays do not add a level; every formatting entity (bold, italic, url,
 * …) adds one.
 */
function walkRichText(
  text: RichText | undefined,
  depth: number,
  acc: Accumulator,
): void {
  if (text === undefined) return;
  if (typeof text === "string") {
    addText(acc, text);
    return;
  }
  if (Array.isArray(text)) {
    for (const part of text) walkRichText(part, depth, acc);
    return;
  }
  const level = depth + 1;
  bump(acc, level);
  switch (text.type) {
    case "custom_emoji":
      addText(acc, text.alternative_text);
      return;
    case "mathematical_expression":
      addText(acc, text.expression);
      return;
    case "anchor":
      // Anchors have no user visible text.
      return;
    default:
      walkRichText(text.text, level, acc);
      return;
  }
}

/** Computes the number of columns of a table, honouring col/rowspans. */
function tableColumnCount(cells: RichBlockTableCell[][]): number {
  // occupied[r] holds the set of columns already taken in row r by
  // rowspans from earlier rows.
  const occupied = new Map<number, Set<number>>();
  const occ = (r: number): Set<number> => {
    let s = occupied.get(r);
    if (s === undefined) {
      s = new Set();
      occupied.set(r, s);
    }
    return s;
  };
  let width = 0;
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    const taken = occ(r);
    let col = 0;
    for (const cell of row) {
      while (taken.has(col)) col++;
      const colspan = Math.max(1, cell.colspan ?? 1);
      const rowspan = Math.max(1, cell.rowspan ?? 1);
      for (let dr = 0; dr < rowspan; dr++) {
        const target = dr === 0 ? taken : occ(r + dr);
        for (let dc = 0; dc < colspan; dc++) target.add(col + dc);
      }
      col += colspan;
    }
    for (const c of taken) if (c + 1 > width) width = c + 1;
    if (col > width) width = col;
  }
  return width;
}

/**
 * Walks a list of blocks. `depth` is the nesting depth at which these blocks
 * live (0 for the top level).
 */
function walkBlocks(
  blocks: readonly InputRichBlock[],
  depth: number,
  acc: Accumulator,
): void {
  for (const block of blocks) walkBlock(block, depth, acc);
}

function walkBlock(block: InputRichBlock, depth: number, acc: Accumulator) {
  const level = depth + 1;
  acc.blockCount++;
  bump(acc, level);

  switch (block.type) {
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
    case "thinking":
      walkRichText(block.text, level, acc);
      return;

    case "divider":
    case "anchor":
      return;

    case "mathematical_expression":
      addText(acc, block.expression);
      return;

    case "pullquote":
      walkRichText(block.text, level, acc);
      walkRichText(block.credit, level, acc);
      return;

    case "blockquote":
      walkRichText(block.credit, level, acc);
      walkBlocks(block.blocks, level, acc);
      return;

    case "details":
      walkRichText(block.summary, level, acc);
      walkBlocks(block.blocks, level, acc);
      return;

    case "list":
      for (const item of block.items) {
        // List items count as blocks and as a nesting level.
        acc.blockCount++;
        const itemLevel = level + 1;
        bump(acc, itemLevel);
        walkBlocks(item.blocks, itemLevel, acc);
      }
      return;

    case "collage":
    case "slideshow":
      walkRichText(block.caption?.text, level, acc);
      walkRichText(block.caption?.credit, level, acc);
      walkBlocks(block.blocks, level, acc);
      return;

    case "table": {
      walkRichText(block.caption, level, acc);
      const cols = tableColumnCount(block.cells);
      if (cols > acc.maxTableColumns) acc.maxTableColumns = cols;
      for (const row of block.cells) {
        // Table rows count as blocks and as a nesting level.
        acc.blockCount++;
        const rowLevel = level + 1;
        bump(acc, rowLevel);
        for (const cell of row) walkRichText(cell.text, rowLevel, acc);
      }
      return;
    }

    case "map":
      // Maps are not media attachments (photos, videos, audio files).
      walkRichText(block.caption?.text, level, acc);
      walkRichText(block.caption?.credit, level, acc);
      return;

    case "photo":
    case "video":
    case "animation":
    case "audio":
    case "voice_note":
      acc.mediaCount++;
      walkRichText(block.caption?.text, level, acc);
      walkRichText(block.caption?.credit, level, acc);
      return;
  }
}

/**
 * Measures a list of rich blocks without judging it against any limits.
 *
 * @param blocks The blocks to measure.
 * @param options Measurement options.
 * @returns The measured statistics.
 */
export function measureRichBlocks(
  blocks: readonly InputRichBlock[],
  options: Pick<CheckOptions, "textLengthMode"> = {},
): RichMessageStats {
  const acc: Accumulator = {
    textLength: 0,
    blockCount: 0,
    maxNestingDepth: 0,
    mediaCount: 0,
    maxTableColumns: 0,
    mode: options.textLengthMode ?? "codepoints",
  };
  walkBlocks(blocks, 0, acc);
  return {
    textLength: acc.textLength,
    blockCount: acc.blockCount,
    maxNestingDepth: acc.maxNestingDepth,
    mediaCount: acc.mediaCount,
    maxTableColumns: acc.maxTableColumns,
  };
}

/**
 * Checks whether a list of rich blocks adheres to the Telegram rich message
 * limits.
 *
 * @param blocks The blocks to check.
 * @param options Check options, e.g. to override limits.
 * @returns The check result, containing measured stats and any violations.
 */
export function checkRichBlocks(
  blocks: readonly InputRichBlock[],
  options: CheckOptions = {},
): RichMessageCheckResult {
  const limits: RichMessageLimits = {
    ...RICH_MESSAGE_LIMITS,
    ...options.limits,
  };
  const stats = measureRichBlocks(blocks, options);
  const violations: RichMessageViolation[] = [];

  const check = (
    limit: keyof RichMessageLimits,
    actual: number,
    what: string,
  ) => {
    const max = limits[limit];
    if (actual > max) {
      violations.push({
        limit,
        actual,
        max,
        message: `${what}: ${actual} exceeds the maximum of ${max}`,
      });
    }
  };

  check("maxTextLength", stats.textLength, "text length");
  check("maxBlocks", stats.blockCount, "block count");
  check("maxNestingDepth", stats.maxNestingDepth, "nesting depth");
  check("maxMediaAttachments", stats.mediaCount, "media attachments");
  check("maxTableColumns", stats.maxTableColumns, "table columns");

  return { ok: violations.length === 0, stats, violations };
}

/**
 * Returns `true` if the blocks adhere to the Telegram rich message limits.
 *
 * @param blocks The blocks to check.
 * @param options Check options, e.g. to override limits.
 */
export function isWithinRichMessageLimits(
  blocks: readonly InputRichBlock[],
  options: CheckOptions = {},
): boolean {
  return checkRichBlocks(blocks, options).ok;
}

/**
 * Throws a {@linkcode RichMessageLimitError} if the blocks exceed the
 * Telegram rich message limits.
 *
 * @param blocks The blocks to check.
 * @param options Check options, e.g. to override limits.
 */
export function assertRichBlocks(
  blocks: readonly InputRichBlock[],
  options: CheckOptions = {},
): void {
  const result = checkRichBlocks(blocks, options);
  if (!result.ok) throw new RichMessageLimitError(result);
}
