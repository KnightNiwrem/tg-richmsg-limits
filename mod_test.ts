import nodeAssert from "node:assert/strict";
import type {
  InputRichBlock,
  RichBlockTableCell,
  RichText,
} from "grammy/types";
import {
  assertRichBlocks,
  checkRichBlocks,
  isWithinRichMessageLimits,
  measureRichBlocks,
  measureTextLength,
  RICH_MESSAGE_LIMITS,
  RichMessageLimitError,
} from "./mod.ts";

// ---------------------------------------------------------------------------
// Assertion helpers (built on node:assert so no network is needed)
// ---------------------------------------------------------------------------

function assert(condition: unknown, message?: string): asserts condition {
  nodeAssert.ok(condition, message);
}

function assertFalse(condition: unknown, message?: string): void {
  nodeAssert.equal(condition, false, message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  nodeAssert.deepEqual(actual, expected, message);
}

function assertThrows<E extends Error>(
  fn: () => unknown,
  // deno-lint-ignore no-explicit-any
  ErrorClass: new (...args: any[]) => E,
  msgIncludes?: string,
): E {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof ErrorClass, "expected function to throw");
  if (msgIncludes !== undefined) {
    assert(
      caught.message.includes(msgIncludes),
      `expected error message to include "${msgIncludes}"`,
    );
  }
  return caught;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function p(text: RichText): InputRichBlock {
  return { type: "paragraph", text };
}

function photo(caption?: string): InputRichBlock {
  return {
    type: "photo",
    photo: { type: "photo", media: "https://example.com/p.jpg" },
    caption: caption === undefined ? undefined : { text: caption },
  };
}

function cell(text?: RichText, extra: Partial<RichBlockTableCell> = {}) {
  return { text, align: "left", valign: "top", ...extra } as RichBlockTableCell;
}

/** Wraps `inner` in `n` nested bold entities. */
function nestBold(inner: RichText, n: number): RichText {
  let t = inner;
  for (let i = 0; i < n; i++) t = { type: "bold", text: t };
  return t;
}

/** Wraps `inner` in `n` nested blockquotes. */
function nestQuotes(inner: InputRichBlock, n: number): InputRichBlock {
  let b = inner;
  for (let i = 0; i < n; i++) b = { type: "blockquote", blocks: [b] };
  return b;
}

// ---------------------------------------------------------------------------
// measureTextLength
// ---------------------------------------------------------------------------

Deno.test("measureTextLength counts code points by default", () => {
  assertEquals(measureTextLength("abc"), 3);
  assertEquals(measureTextLength("héllo"), 5);
  // U+1F600 is one code point, two UTF-16 units, four UTF-8 bytes.
  assertEquals(measureTextLength("😀"), 1);
  assertEquals(measureTextLength("😀", "codepoints"), 1);
  assertEquals(measureTextLength("😀", "utf16"), 2);
  assertEquals(measureTextLength("😀", "utf8bytes"), 4);
  assertEquals(measureTextLength(""), 0);
});

// ---------------------------------------------------------------------------
// Text length
// ---------------------------------------------------------------------------

Deno.test("text length sums plain strings across blocks", () => {
  const stats = measureRichBlocks([p("hello"), p("world!")]);
  assertEquals(stats.textLength, 11);
});

Deno.test("text length includes nested formatting, arrays and entities", () => {
  const stats = measureRichBlocks([
    p([
      "a",
      { type: "bold", text: ["b", { type: "italic", text: "c" }] },
      { type: "url", text: "d", url: "https://example.com" },
    ]),
  ]);
  assertEquals(stats.textLength, 4);
});

Deno.test("text length includes custom emoji alternative text", () => {
  const stats = measureRichBlocks([
    p([{ type: "custom_emoji", custom_emoji_id: "1", alternative_text: "👍" }]),
  ]);
  assertEquals(stats.textLength, 1);
});

Deno.test("text length includes formula source (inline and block)", () => {
  const stats = measureRichBlocks([
    p([{ type: "mathematical_expression", expression: "x^2" }]),
    { type: "mathematical_expression", expression: "E=mc^2" },
  ]);
  assertEquals(stats.textLength, 3 + 6);
});

Deno.test("text length includes captions, credits, summaries and cells", () => {
  const blocks: InputRichBlock[] = [
    photo("cap"), // 3
    { type: "pullquote", text: "quote", credit: "me" }, // 7
    { type: "blockquote", blocks: [p("q")], credit: "you" }, // 4
    { type: "details", summary: "sum", blocks: [p("body")] }, // 7
    { type: "table", caption: "tc", cells: [[cell("a"), cell("bc")]] }, // 5
    {
      type: "collage",
      blocks: [photo()],
      caption: { text: "cc", credit: "cr" }, // 4
    },
    {
      type: "map",
      location: { latitude: 0, longitude: 0 },
      zoom: 13,
      width: 100,
      height: 100,
      caption: { text: "map" }, // 3
    },
  ];
  assertEquals(measureRichBlocks(blocks).textLength, 3 + 7 + 4 + 7 + 5 + 4 + 3);
});

Deno.test("text length ignores anchors, urls and other non-text fields", () => {
  const stats = measureRichBlocks([
    { type: "anchor", name: "top" },
    p([
      { type: "anchor", name: "a" },
      { type: "anchor_link", text: "x", anchor_name: "a" },
      { type: "url", text: "y", url: "https://very-long-url.example.com/" },
    ]),
  ]);
  assertEquals(stats.textLength, 2);
});

Deno.test("text length limit: exactly at the limit is ok, one over fails", () => {
  const max = RICH_MESSAGE_LIMITS.maxTextLength;
  assert(checkRichBlocks([p("a".repeat(max))]).ok);
  const r = checkRichBlocks([p("a".repeat(max + 1))]);
  assertFalse(r.ok);
  assertEquals(r.violations.length, 1);
  assertEquals(r.violations[0].limit, "maxTextLength");
  assertEquals(r.violations[0].actual, max + 1);
  assertEquals(r.violations[0].max, max);
});

Deno.test("text length limit uses code points, not UTF-16 units", () => {
  const max = RICH_MESSAGE_LIMITS.maxTextLength;
  const emoji = "😀".repeat(max); // max code points, 2*max UTF-16 units
  assert(checkRichBlocks([p(emoji)]).ok);
  assertFalse(checkRichBlocks([p(emoji)], { textLengthMode: "utf16" }).ok);
});

// ---------------------------------------------------------------------------
// Block count
// ---------------------------------------------------------------------------

Deno.test("block count counts top-level and nested blocks", () => {
  const blocks: InputRichBlock[] = [
    p("a"), // 1
    { type: "blockquote", blocks: [p("b"), p("c")] }, // 3
    { type: "details", summary: "s", blocks: [p("d")] }, // 2
    { type: "collage", blocks: [photo(), photo()] }, // 3
    { type: "slideshow", blocks: [photo()] }, // 2
    { type: "divider" }, // 1
  ];
  assertEquals(measureRichBlocks(blocks).blockCount, 12);
});

Deno.test("block count counts list items and their contents", () => {
  const blocks: InputRichBlock[] = [
    {
      type: "list", // 1
      items: [
        { blocks: [p("a")] }, // item + 1
        { blocks: [p("b"), p("c")] }, // item + 2
        {
          blocks: [
            { type: "list", items: [{ blocks: [p("d")] }] }, // 1 + item + 1
          ],
        }, // item
      ],
    },
  ];
  assertEquals(measureRichBlocks(blocks).blockCount, 1 + 2 + 3 + 1 + 3);
});

Deno.test("block count counts table rows", () => {
  const blocks: InputRichBlock[] = [
    {
      type: "table",
      cells: [[cell("a"), cell("b")], [cell("c"), cell("d")], [cell("e")]],
    },
  ];
  assertEquals(measureRichBlocks(blocks).blockCount, 1 + 3);
});

Deno.test("block count limit: 500 ok, 501 fails", () => {
  const max = RICH_MESSAGE_LIMITS.maxBlocks;
  const ok = Array.from({ length: max }, () => p("x"));
  assert(checkRichBlocks(ok).ok);
  const r = checkRichBlocks([...ok, p("y")]);
  assertFalse(r.ok);
  assertEquals(r.violations.map((v) => v.limit), ["maxBlocks"]);
});

Deno.test("block count limit counts nested list items towards the limit", () => {
  const max = RICH_MESSAGE_LIMITS.maxBlocks;
  // 1 list + 250 items + 250 paragraphs = 501
  const items = Array.from({ length: 250 }, () => ({ blocks: [p("x")] }));
  const r = checkRichBlocks([{ type: "list", items }]);
  assertFalse(r.ok);
  assertEquals(r.stats.blockCount, max + 1);
});

// ---------------------------------------------------------------------------
// Nesting depth
// ---------------------------------------------------------------------------

Deno.test("nesting depth: plain paragraph is depth 1", () => {
  assertEquals(measureRichBlocks([p("a")]).maxNestingDepth, 1);
  assertEquals(measureRichBlocks([]).maxNestingDepth, 0);
});

Deno.test("nesting depth: arrays and strings do not add levels", () => {
  assertEquals(measureRichBlocks([p(["a", ["b", ["c"]]])]).maxNestingDepth, 1);
});

Deno.test("nesting depth: each formatting entity adds a level", () => {
  assertEquals(measureRichBlocks([p(nestBold("x", 3))]).maxNestingDepth, 4);
  assertEquals(
    measureRichBlocks([p([{ type: "bold", text: "a" }, "b"])]).maxNestingDepth,
    2,
  );
});

Deno.test("nesting depth: nested blocks add levels", () => {
  assertEquals(measureRichBlocks([nestQuotes(p("x"), 3)]).maxNestingDepth, 4);
  // list (1) -> item (2) -> paragraph (3) -> bold (4)
  assertEquals(
    measureRichBlocks([
      { type: "list", items: [{ blocks: [p(nestBold("x", 1))] }] },
    ]).maxNestingDepth,
    4,
  );
  // table (1) -> row (2) -> italic (3)
  assertEquals(
    measureRichBlocks([
      { type: "table", cells: [[cell({ type: "italic", text: "x" })]] },
    ]).maxNestingDepth,
    3,
  );
});

Deno.test("nesting depth limit: 16 ok, 17 fails", () => {
  const max = RICH_MESSAGE_LIMITS.maxNestingDepth;
  // paragraph (1) + 15 bolds = 16
  assert(checkRichBlocks([p(nestBold("x", max - 1))]).ok);
  const r = checkRichBlocks([p(nestBold("x", max))]);
  assertFalse(r.ok);
  assertEquals(r.violations.map((v) => v.limit), ["maxNestingDepth"]);
  // 8 blockquotes + paragraph + 8 bolds = 17
  const mixed = checkRichBlocks([nestQuotes(p(nestBold("x", 8)), 8)]);
  assertFalse(mixed.ok);
  assertEquals(mixed.stats.maxNestingDepth, max + 1);
});

// ---------------------------------------------------------------------------
// Media attachments
// ---------------------------------------------------------------------------

Deno.test("media count counts photos, videos, animations, audio, voice", () => {
  const blocks: InputRichBlock[] = [
    photo(),
    { type: "video", video: { type: "video", media: "v" } },
    { type: "animation", animation: { type: "animation", media: "a" } },
    { type: "audio", audio: { type: "audio", media: "au" } },
    { type: "voice_note", voice_note: { type: "voice_note", media: "vn" } },
    { type: "collage", blocks: [photo(), photo()] },
    { type: "slideshow", blocks: [photo()] },
    { type: "blockquote", blocks: [photo()] },
    {
      type: "map",
      location: { latitude: 0, longitude: 0 },
      zoom: 13,
      width: 1,
      height: 1,
    },
  ];
  assertEquals(measureRichBlocks(blocks).mediaCount, 9);
});

Deno.test("media limit: 50 ok, 51 fails", () => {
  const max = RICH_MESSAGE_LIMITS.maxMediaAttachments;
  const ok = Array.from({ length: max }, () => photo());
  assert(checkRichBlocks(ok).ok);
  const r = checkRichBlocks([...ok, photo()]);
  assertFalse(r.ok);
  assertEquals(r.violations.map((v) => v.limit), ["maxMediaAttachments"]);
});

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

Deno.test("table columns: widest row wins", () => {
  const stats = measureRichBlocks([
    { type: "table", cells: [[cell("a")], [cell("b"), cell("c"), cell("d")]] },
    { type: "table", cells: [[cell("a"), cell("b")]] },
  ]);
  assertEquals(stats.maxTableColumns, 3);
  assertEquals(measureRichBlocks([p("no table")]).maxTableColumns, 0);
});

Deno.test("table columns: colspan and rowspan are honoured", () => {
  // Row 0: [span 2][1]      -> 3 columns
  // Row 1: [rowspan 2][1][1] -> 3 columns
  // Row 2: (occupied)[1][1][1] -> 4 columns
  const stats = measureRichBlocks([
    {
      type: "table",
      cells: [
        [cell("a", { colspan: 2 }), cell("b")],
        [cell("c", { rowspan: 2 }), cell("d"), cell("e")],
        [cell("f"), cell("g"), cell("h")],
      ],
    },
  ]);
  assertEquals(stats.maxTableColumns, 4);
});

Deno.test("table columns: rowspan-only rows still count occupied cells", () => {
  const stats = measureRichBlocks([
    {
      type: "table",
      cells: [
        [cell("a", { rowspan: 2, colspan: 5 })],
        [], // fully occupied by the rowspan above
      ],
    },
  ]);
  assertEquals(stats.maxTableColumns, 5);
});

Deno.test("table column limit: 20 ok, 21 fails", () => {
  const max = RICH_MESSAGE_LIMITS.maxTableColumns;
  const row = (n: number) => Array.from({ length: n }, (_, i) => cell(`${i}`));
  assert(checkRichBlocks([{ type: "table", cells: [row(max)] }]).ok);
  const r = checkRichBlocks([{ type: "table", cells: [row(max + 1)] }]);
  assertFalse(r.ok);
  assertEquals(r.violations.map((v) => v.limit), ["maxTableColumns"]);
  const spanned = checkRichBlocks([
    { type: "table", cells: [[cell("x", { colspan: max + 1 })]] },
  ]);
  assertFalse(spanned.ok);
});

// ---------------------------------------------------------------------------
// Result shape, options and helpers
// ---------------------------------------------------------------------------

Deno.test("empty input is ok with zeroed stats", () => {
  const r = checkRichBlocks([]);
  assert(r.ok);
  assertEquals(r.violations, []);
  assertEquals(r.stats, {
    textLength: 0,
    blockCount: 0,
    maxNestingDepth: 0,
    mediaCount: 0,
    maxTableColumns: 0,
  });
});

Deno.test("multiple violations are all reported", () => {
  const r = checkRichBlocks([p("a".repeat(10)), photo(), photo()], {
    limits: { maxTextLength: 5, maxMediaAttachments: 1, maxBlocks: 2 },
  });
  assertFalse(r.ok);
  assertEquals(r.violations.map((v) => v.limit).sort(), [
    "maxBlocks",
    "maxMediaAttachments",
    "maxTextLength",
  ]);
  for (const v of r.violations) {
    assert(v.message.includes(String(v.actual)));
    assert(v.message.includes(String(v.max)));
  }
});

Deno.test("limit overrides merge with defaults", () => {
  const r = checkRichBlocks([p("abcdef")], { limits: { maxTextLength: 5 } });
  assertFalse(r.ok);
  assertEquals(r.violations.map((v) => v.limit), ["maxTextLength"]);
  // Other defaults still apply.
  const many = Array.from({ length: 501 }, () => p(""));
  const r2 = checkRichBlocks(many, { limits: { maxTextLength: 5 } });
  assertEquals(r2.violations.map((v) => v.limit), ["maxBlocks"]);
});

Deno.test("isWithinRichMessageLimits mirrors checkRichBlocks().ok", () => {
  assert(isWithinRichMessageLimits([p("ok")]));
  assertFalse(
    isWithinRichMessageLimits([p("ok")], { limits: { maxBlocks: 0 } }),
  );
});

Deno.test("assertRichBlocks throws RichMessageLimitError with details", () => {
  assertRichBlocks([p("fine")]);
  const err = assertThrows(
    () => assertRichBlocks([p("too long")], { limits: { maxTextLength: 3 } }),
    RichMessageLimitError,
    "text length",
  );
  assertEquals(err.name, "RichMessageLimitError");
  assertEquals(err.result.violations[0].limit, "maxTextLength");
});

Deno.test("RICH_MESSAGE_LIMITS matches Telegram's documented values", () => {
  assertEquals(RICH_MESSAGE_LIMITS, {
    maxTextLength: 32768,
    maxBlocks: 500,
    maxNestingDepth: 16,
    maxMediaAttachments: 50,
    maxTableColumns: 20,
  });
  assert(Object.isFrozen(RICH_MESSAGE_LIMITS));
});
