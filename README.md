# hexsweep

**Find the hardcoded colors that should be design tokens.** After a token
migration, components still have raw `background: #3f82f0` buried in them instead
of `var(--primary-blue)` — and you don't find out until dark mode or a rebrand
breaks. `hexsweep` scans your source and flags every raw color literal that
escaped, with zero config and zero dependencies.

```bash
npx hexsweep src/
#   src/components/Button.tsx  (2)
#     14:18  #3f82f0  [hex6]  background
#     27:10  rgb(255, 0, 0)  [rgb]  color
#
#   ✖ 2 hardcoded colors in 1 file (23 files clean)
```

Exits non-zero when it finds colors, so it drops straight into CI. Also on PyPI
(`pipx run hexsweep`) — the two builds produce **byte-for-byte identical** output.

## Why not grep or stylelint?

`grep '#[0-9a-f]{6}'` is what people fall back to, and it's noisy: it hits
`#header` id-selectors, `url(#gradient)` references, colors in comments, and it
can't see `rgb()`/`hsl()`, 3/4/8-digit hex, or tell a leftover from a token
definition.

**stylelint** can do it, but needs Node + a config + postcss/custom-syntax, it
can't see hex inside TSX/CSS-in-JS string literals, and — critically — its
`color-no-hex` flags your `tokens.css` (the one file that's *supposed* to hold
raw colors) exactly as loudly as a stray hex in a component. The request to
exempt token definitions has sat unimplemented for years.

`hexsweep` sits in between. It's a one-shot, zero-config scanner that is:

- **comment-aware** — colors in `//`, `/* */`, `<!-- -->` are skipped (but
  strings are kept, so it *does* catch CSS-in-JS like `` styled.div`color:#3f82f0` ``);
- **definition-aware** — `--primary: #3f82f0`, `$brand: …`, `@brand: …` are
  allowed by default; only *usages* are flagged (use `--strict` to flag
  definitions too);
- **structural** — `#fff {` id-selectors and `url(#a1b2c3)` are not colors;
- **precise** — matches hex (3/4/6/8) + `rgb()/rgba()/hsl()/hsla()`, never a
  5- or 7-digit run, with an `--allow` list for the colors you keep on purpose.

## Usage

```bash
hexsweep                          # scan the current directory
hexsweep src/ styles/             # scan specific paths
hexsweep --allow "#000,#fff" src  # allowlist colors that are OK to hardcode
hexsweep --strict                 # also flag token definitions (--x/$x/@x)
hexsweep --ext css,scss,vue       # override the scanned extensions
hexsweep --json                   # machine output (byte-identical both builds)
```

`node_modules`, `.git`, `dist`, `build`, `coverage` (and more) are skipped by
default; add others with `--exclude`. The default extensions are css, scss,
sass, less, vue, svelte, jsx, tsx, js, ts, html, htm, astro.

Exit codes: `0` clean · `1` hardcoded colors found · `2` error.

### In CI

```yaml
- run: npx hexsweep src/   # fails the build on a hardcoded color
```

The `--json` shape is sorted by `(file, line, column)` so it's deterministic
regardless of filesystem order:

```json
{
  "version": 1,
  "summary": { "filesScanned": 24, "filesWithFindings": 1, "findingCount": 2 },
  "findings": [
    { "file": "src/components/Button.tsx", "line": 14, "column": 18,
      "literal": "#3f82f0", "category": "hex6", "property": "background", "isDefinition": false }
  ]
}
```

## How it works

It's a line scanner, not a CSS/JS parser — that's what keeps it zero-dependency
and lets the Node and Python builds stay byte-identical. It blanks comment spans
(keeping string contents and every column position intact), then matches color
literals with explicit-ASCII regexes, and applies the id-selector / url() /
definition / allowlist gates. Columns are counted in UTF-8 bytes and files are
visited in a fixed byte-sorted order, so output never depends on the OS or
filesystem.

## Scope

MVP matches `#hex` and `rgb()/hsl()` functional notation. Named colors (`red`),
modern `oklch()/lab()`, autofix, and a config file are intentionally left out —
the goal is a high-signal, zero-config CI gate, not a parser.

## Install

```bash
npm i -g hexsweep    # or npx hexsweep
pip install hexsweep # Python build, identical behaviour
```

Node ≥ 18 or Python ≥ 3.8. No dependencies.

## License

MIT
