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

type WalkItem =
  | { kind: "block"; block: InputRichBlock; depth: number }
  | { kind: "rich_text"; text: RichText | undefined; depth: number }
  | { kind: "list_item"; blocks: readonly InputRichBlock[]; depth: number }
  | {
    kind: "table_row";
    cells: readonly RichBlockTableCell[];
    depth: number;
  };

function pushBlocks(
  stack: WalkItem[],
  blocks: readonly InputRichBlock[],
  depth: number,
): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    stack.push({ kind: "block", block: blocks[i], depth });
  }
}

/**
 * Iteratively walks a list of blocks and all nested rich text.
 *
 * `depth` is the nesting depth at which the blocks live (0 for the top
 * level). Plain strings and rich-text arrays do not add a level; every
 * formatting entity, block, list item, and table row adds one.
 */
function walkBlocks(
  blocks: readonly InputRichBlock[],
  depth: number,
  acc: Accumulator,
): void {
  const stack: WalkItem[] = [];
  pushBlocks(stack, blocks, depth);

  while (stack.length > 0) {
    const item = stack.pop()!;

    switch (item.kind) {
      case "rich_text": {
        const { text, depth } = item;
        if (text === undefined) break;
        if (typeof text === "string") {
          addText(acc, text);
          break;
        }
        if (Array.isArray(text)) {
          for (let i = text.length - 1; i >= 0; i--) {
            stack.push({ kind: "rich_text", text: text[i], depth });
          }
          break;
        }

        const level = depth + 1;
        bump(acc, level);
        switch (text.type) {
          case "custom_emoji":
            addText(acc, text.alternative_text);
            break;
          case "mathematical_expression":
            addText(acc, text.expression);
            break;
          case "anchor":
            // Anchors have no user visible text.
            break;
          default:
            stack.push({ kind: "rich_text", text: text.text, depth: level });
            break;
        }
        break;
      }

      case "list_item": {
        // List items count as blocks and as a nesting level.
        acc.blockCount++;
        const level = item.depth + 1;
        bump(acc, level);
        pushBlocks(stack, item.blocks, level);
        break;
      }

      case "table_row": {
        // Table rows count as blocks and as a nesting level.
        acc.blockCount++;
        const level = item.depth + 1;
        bump(acc, level);
        for (let i = item.cells.length - 1; i >= 0; i--) {
          stack.push({
            kind: "rich_text",
            text: item.cells[i].text,
            depth: level,
          });
        }
        break;
      }

      case "block": {
        const { block, depth } = item;
        const level = depth + 1;
        acc.blockCount++;
        bump(acc, level);

        switch (block.type) {
          case "paragraph":
          case "heading":
          case "pre":
          case "footer":
          case "thinking":
            stack.push({ kind: "rich_text", text: block.text, depth: level });
            break;

          case "divider":
          case "anchor":
            break;

          case "mathematical_expression":
            addText(acc, block.expression);
            break;

          case "pullquote":
            stack.push(
              { kind: "rich_text", text: block.credit, depth: level },
              { kind: "rich_text", text: block.text, depth: level },
            );
            break;

          case "blockquote":
            pushBlocks(stack, block.blocks, level);
            stack.push({ kind: "rich_text", text: block.credit, depth: level });
            break;

          case "details":
            pushBlocks(stack, block.blocks, level);
            stack.push({
              kind: "rich_text",
              text: block.summary,
              depth: level,
            });
            break;

          case "list":
            for (let i = block.items.length - 1; i >= 0; i--) {
              stack.push({
                kind: "list_item",
                blocks: block.items[i].blocks,
                depth: level,
              });
            }
            break;

          case "collage":
          case "slideshow":
            pushBlocks(stack, block.blocks, level);
            stack.push(
              {
                kind: "rich_text",
                text: block.caption?.credit,
                depth: level,
              },
              {
                kind: "rich_text",
                text: block.caption?.text,
                depth: level,
              },
            );
            break;

          case "table": {
            const cols = tableColumnCount(block.cells);
            if (cols > acc.maxTableColumns) acc.maxTableColumns = cols;
            for (let i = block.cells.length - 1; i >= 0; i--) {
              stack.push({
                kind: "table_row",
                cells: block.cells[i],
                depth: level,
              });
            }
            stack.push({
              kind: "rich_text",
              text: block.caption,
              depth: level,
            });
            break;
          }

          case "map":
            // Maps are not media attachments (photos, videos, audio files).
            stack.push(
              {
                kind: "rich_text",
                text: block.caption?.credit,
                depth: level,
              },
              {
                kind: "rich_text",
                text: block.caption?.text,
                depth: level,
              },
            );
            break;

          case "photo":
          case "video":
          case "animation":
          case "audio":
          case "voice_note":
            acc.mediaCount++;
            stack.push(
              {
                kind: "rich_text",
                text: block.caption?.credit,
                depth: level,
              },
              {
                kind: "rich_text",
                text: block.caption?.text,
                depth: level,
              },
            );
            break;
        }
        break;
      }
    }
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
