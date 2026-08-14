# dineguide — working notes

A menu scanner that runs as a home-screen PWA. Photograph a menu, get every dish
translated and explained, prices converted.

| | |
| --- | --- |
| Live | https://tytheproductguy.github.io/dineguide/ |
| Files | `app.js` (~1800 lines), `app.css`, `sw.js`, `index.html` |

There is no build step and no framework. `app.js` is one ES module that renders
strings into `#app` and re-wires listeners after each render.

## Shipping

**A push to `main` is a deploy.** GitHub Pages serves this repo's root off
`main`, so there is no staging and no release step — merging is publishing.

Before every push:

1. **Bump `VERSION` in `sw.js`.** Stale clients keep the old shell otherwise.
2. `node --check app.js` — the only automated gate that exists.

After pushing, verify against the **commit hash**:

```bash
gh api repos/tytheproductguy/dineguide/pages/builds/latest --jq '.commit,.status'
```

`gh api .../pages` reports the *last completed* build and will happily tell you
an old deploy succeeded. GitHub's CDN also holds files for ~10 minutes, so add a
cache-buster when curling the live URL.

`?fresh=1` tears down every service worker and cache, then reloads clean. It is
inline in `index.html` *before* `app.js`, because a stale bundle is precisely
when `app.js` cannot be trusted to run.

## Architecture, and why

**No backend.** The user's OpenAI key is entered in the app and lives in that
device's `localStorage`; requests go straight to `api.openai.com`, which allows
browser CORS. This inverts the usual "never ship the key in the client" advice
deliberately — that rule is about *distribution*. With one user and their own
key, a hosted proxy would put the key on a third party *and* need auth to stop
strangers spending it. Nothing has to stay running while travelling.

- `gpt-4o`, not mini. Measured on a real menu: better OCR, preserved a
  subsection mini flattened, and 10x fewer tokens. ~1.5c/scan.
- Photos downscale to 1024px in-browser before upload. `detail: 'high'` is
  required; `low` downsamples to 512px and cannot read menu type.
- Scans persist to IndexedDB, so previous menus open offline.
- Service worker: **app code network-first**, fonts/images cache-first. A
  cache-first rule once pinned the app to its first deploy permanently.
- `sanitize()` enforces menu structure in code, not prompting. The model
  repeatedly broke prompt rules: restaurant banner as a section heading, one
  section per dish, a section named after its own dish, `(v)` left on names.
  Pass order matters — markers stripped first, per-dish merge before relabelling.
- **Currency is never inferred.** Menus printing bare numbers yield `null` and
  show unconverted. Guessing from cuisine produced confidently wrong conversions.

## Settled — do not re-litigate

- **Filters sort, they do not hide.** "Fits your filters" on top, then
  "Everything else". A filter with no matches used to empty the screen *and*
  hide the funnel that caused it. Search still hides: a query narrows, a
  preference sorts.
- **Dietary filters persist across scans and launches; price filters never do.**
  A diet describes the person, a price range describes one menu.
- A price constraint is recorded **only if a handle moved off the end**.
  Otherwise "gluten free" silently stored the menu's full range, which then
  carried to the next menu where those numbers meant something else.
- **Toggling a control never re-renders its drawer.** `render()` replaces the
  whole tree, so calling it from a chip or a reset button rebuilds the open
  sheet under the user's finger, replays its entrance animation, drops its
  scroll position, and resets any half-typed field. Toggles mutate their own
  control (`markChips`) and repaint only what genuinely depends on them.
- **Scroll position survives every `render()`.** Nothing re-renders on scroll —
  doing so ate the first scroll gesture entirely.
- **The camera is released whenever the viewfinder is off screen.** Stopping
  every *track* frees the hardware; dropping the video element leaves it live.
- Design offsets (70/74/64px) are measured from the physical screen edge and
  already clear the status bar. Safe-area insets are a `max()` floor, never
  added on top.

## Verifying without a phone

`?debug=1` exposes `window.DG` (state, render, addPages, startScan, …) for
driving the app with no camera and no scan. It exposes state only, never the key.

- A sandbox has **no camera, no API key, and often no service worker**. Anything
  touching `getUserMedia`, a real scan, or SW caching must be stubbed, or
  verified by hand on the live HTTPS origin.
- Detached nodes return zeroed `getBoundingClientRect()`. Re-query after
  `render()` or measurements silently lie.
- Smooth scrolling is rAF-driven and gets throttled while an async test loop
  holds the thread — a scroll that did happen can measure as "did not".
- Asserting on **node identity** across an interaction is the cheap way to catch
  an unwanted rebuild: `before === document.querySelector('.sheet')`.

## Commits

Prose body explaining the problem and why this is the fix, not a changelog of
edits. No AI attribution, no `Co-Authored-By`, no tool footers. Match the
existing history.
