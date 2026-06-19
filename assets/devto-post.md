You did the design-token migration. You celebrated. Then three months later someone changed the brand color, dark mode shipped, and a dozen buttons stayed stubbornly the old blue — because they still had `background: #3f82f0` hardcoded instead of `var(--primary)`, and nobody noticed.

This is the boring, recurring way token systems rot: the migration is "done," but raw colors are still buried in components, and you don't find out until the day they break.

So I built **hexsweep** — a zero-dependency CLI that scans your source and flags the raw color literals that escaped:

```
$ npx hexsweep src/

  src/components/Button.tsx  (2)
    14:18  #3f82f0  [hex6]  background
    27:10  rgb(255, 0, 0)  [rgb]  color

  ✖ 2 hardcoded colors in 1 file (23 files clean)
```

It exits non-zero when it finds something, so it drops straight into CI as a gate. `pip install hexsweep` gets you the same tool in Python — the two builds print byte-for-byte identical output.

## "Just grep for it" — no

The reflex is `grep '#[0-9a-f]{6}'`. It's noisy enough that nobody keeps it in CI:

- it flags `#header` id-selectors and `url(#gradient)` references (not colors);
- it flags colors sitting in comments;
- it misses `rgb()`/`hsl()`, 3/4/8-digit hex, and CSS-in-JS;
- and it has no idea that `--primary: #3f82f0` is *correct* and `color: #3f82f0` is the bug.

## "Use stylelint" — closer, but it yells at the wrong file

stylelint's `color-no-hex` can do this for plain CSS, but it needs a config + postcss/custom-syntax, it can't see hex inside TSX/CSS-in-JS string literals, and — the part that makes people turn it off — it flags your `tokens.css` exactly as loudly as a stray hex in a component. The request to **exempt token definitions** has sat open and unimplemented for years. So the one file that's *supposed* to contain raw colors is the loudest thing in your report.

hexsweep's whole point is that distinction:

- **`--primary: #3f82f0`** (a definition — custom property, `$scss`, or `@less` var) → **allowed by default**. That's where colors are supposed to live.
- **`color: #3f82f0`** (a usage) → **flagged**.

Run `--strict` if you want zero raw hex anywhere, tokens included.

## The fun part: a linter with no parser, that two languages agree on byte-for-byte

I wanted a Node build *and* a Python build with identical output, and I wanted zero dependencies — which rules out a real CSS/JS parser. So hexsweep is a **line scanner** with a few careful tricks:

- It **blanks comment spans** (`//`, `/* */`, `<!-- -->`) to spaces with a small state machine — but **keeps string contents**, because CSS-in-JS colors live in strings (`` styled.div`color:#3f82f0` `` *should* be caught).
- An **id-selector / `url()` gate** disambiguates `#fff {` (a selector) from `color: #fff` (a value) by position.
- The hex regex enumerates only legal lengths (3/4/6/8) so `#1234567` isn't half-matched.

Getting Node and Python to agree to the byte was the real work — and the bugs are *exactly* the cross-language ones you'd expect: Python's `\d`/`\w` match Unicode digits while JS's don't (so every regex uses explicit `[0-9A-Fa-f]`); `os.path.join('.', x)` keeps a `./` that Node's `path.join` strips; an emoji inside a comment blanks to a different number of spaces if you iterate UTF-16 units vs code points (so the comment stripper iterates code points); and columns are counted in **UTF-8 bytes** to dodge the UTF-16-vs-code-point off-by-one. A differential test runs both builds over the same trees and gets zero diffs.

## What it deliberately doesn't do

- **No named colors** (`red`, `tan`) by default — too noisy, they collide with identifiers and class names. The validated pain is raw hex.
- **No autofix** — it has no `#3f82f0 → --primary` map, and a report that rewrites your files is a report you can't trust in CI.
- **No config file, no `oklch()/lab()`** — the goal is a high-signal, zero-config gate, not a parser.

## Install

```bash
npx hexsweep src/      # Node, zero deps
pip install hexsweep   # Python, zero deps, identical output
```

MIT licensed, both builds open source:

- npm: https://www.npmjs.com/package/hexsweep
- PyPI: https://pypi.org/project/hexsweep/
- GitHub: https://github.com/jjdoor/hexsweep (Node) · https://github.com/jjdoor/hexsweep-py (Python)

Run `npx hexsweep` on a project you migrated to tokens a while ago. I'd bet there's at least one `#hex` still hiding in there — what did you find?
