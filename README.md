# tg-richmsg-limits

A small, dependency-free (types only) Deno/TypeScript library that checks
whether an array of Telegram `InputRichBlock`s adheres to the
[Telegram Bot API rich message limits](https://core.telegram.org/bots/api#inputrichmessage):

| Limit                                                                                     | Default |
| ----------------------------------------------------------------------------------------- | ------: |
| Characters in the rich message text (incl. custom emoji alt text and formula source)      |   32768 |
| Blocks (incl. nested blocks, list items, table rows, quotation blocks and details blocks) |     500 |
| Levels of nested formatting and blocks                                                    |      16 |
| Media attachments (photos, videos, animations, audio, voice notes)                        |      50 |
| Columns in a single table                                                                 |      20 |

It does **not** try to validate whether the message renders correctly; it only
checks these limits.

Types come from [grammY](https://grammy.dev) (`grammy/types`).

## Usage

```ts
import type { InputRichBlock } from "grammy/types";
import {
  assertRichBlocks,
  checkRichBlocks,
  isWithinRichMessageLimits,
  measureRichBlocks,
} from "./mod.ts";

const blocks: InputRichBlock[] = [
  { type: "heading", size: 1, text: "Hello" },
  { type: "paragraph", text: ["plain, ", { type: "bold", text: "bold" }] },
];

// Full result with stats + violations
const result = checkRichBlocks(blocks);
// {
//   ok: true,
//   stats: { textLength: 16, blockCount: 2, maxNestingDepth: 2, mediaCount: 0, maxTableColumns: 0 },
//   violations: [],
// }

// Boolean shorthand
isWithinRichMessageLimits(blocks); // true

// Throwing variant (throws RichMessageLimitError)
assertRichBlocks(blocks);

// Just measure, without judging
measureRichBlocks(blocks);
```

### Options

```ts
checkRichBlocks(blocks, {
  // Override any of the defaults (merged with RICH_MESSAGE_LIMITS)
  limits: { maxTextLength: 4096 },
  // "codepoints" (default) | "utf16" | "utf8bytes"
  textLengthMode: "codepoints",
});
```

## How things are counted

- **Text length**: every string inside a `RichText` (recursively, incl. nested
  formatting and arrays), `custom_emoji.alternative_text`, inline and block
  `mathematical_expression.expression`, block captions and credits, blockquote
  and pullquote credits, details summaries, table captions and table cell text.
  Anchor names, URLs, usernames, etc. are not counted. Length is measured in
  Unicode code points by default (what Telegram calls "UTF-8 characters"); pass
  `textLengthMode` to use UTF-16 units or UTF-8 bytes.
- **Blocks**: every `InputRichBlock` at any depth, plus every list item and
  every table row.
- **Nesting depth**: every block adds one level, every list item and table row
  adds one level, and every formatting entity (`bold`, `url`, `spoiler`, …) adds
  one level. Plain strings and `RichText[]` arrays do not add levels. A
  top-level paragraph with plain text has depth 1.
- **Media**: `photo`, `video`, `animation`, `audio` and `voice_note` blocks at
  any depth (including inside collages, slideshows, quotes, lists, …). `map`
  blocks are not counted as media.
- **Table columns**: computed per table honouring `colspan` and `rowspan`; the
  reported value is the widest table.

## Development

```sh
deno task check   # fmt --check, lint, typecheck, test
deno test
```

## Using the JSR build of grammY

This repo pins `grammy/types` to `npm:grammy` in `deno.json`. If you prefer the
JSR build, change the import map entry to:

```json
"grammy/types": "jsr:@grammyjs/grammy@^1.45.1/types"
```

## License

MIT
