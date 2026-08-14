# dineguide

A menu scanner that runs as a home-screen web app. Point it at a menu, get every
dish translated and explained, with prices converted to your currency.

## How it works

Static files, no backend. Your OpenAI API key is entered once in the app and kept
in this device's `localStorage`; requests go straight from your phone to
api.openai.com. The key is never in this repository, never in the bundle, and
never on anyone else's server.

That is only appropriate because this is a personal build with one user's own key.
Do not hand this URL to other people expecting them to share your key: they can't,
and shouldn't.

- Photos are downscaled to 1024px in the browser before upload, which keeps both
  roaming data and token spend down. A 12MP photo becomes about 85KB.
- Menus are saved to IndexedDB, so previous scans open instantly and work offline.
- The service worker caches the shell, so the app opens without a signal.
- `sanitize()` in `app.js` corrects structural mistakes the model makes reliably
  enough to matter: the restaurant name used as a section heading, one section per
  dish, a section named after its own dish, and `(v)` markers left on dish names.

## Cost

Roughly 1.5 cents per scan on `gpt-4o`. Set a spend limit on the key at
platform.openai.com if you want a hard ceiling.

## Install on iPhone

Open the URL in Safari, then Share → Add to Home Screen. It launches full screen
with no browser chrome. Camera access needs HTTPS, which GitHub Pages provides.

## Local development

```bash
python3 -m http.server 8080   # serve it
npm test                      # syntax check + smoke tests, no browser needed
```

Append `?debug=1` to expose a `window.DG` handle for driving the app without a
camera. It exposes app state only, never the stored key.

## Privacy

Menu photos are sent to OpenAI to be read. Nothing is sent anywhere else, and
there is no analytics, no accounts, and no server logs.
