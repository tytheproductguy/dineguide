/* Enough of a browser for app.js to finish evaluating under `node --test`.
 *
 * app.js is a browser module: it reads localStorage while building `state`,
 * grabs #app and a measuring canvas at module scope, and runs boot(). None of
 * that is what the tests are about, but all of it has to survive import.
 *
 * This must be imported BEFORE app.js. Static imports are evaluated in order,
 * so `import './dom-stub.js'` above `import '../app.js'` is the whole trick.
 *
 * Deliberately dumb: every element is the same inert object. The moment a test
 * needs a real DOM, it is testing the wrong layer — that belongs in a browser
 * against the live origin, per CLAUDE.md.
 */

const noop = () => {};

const element = {
  innerHTML: '',
  textContent: '',
  value: '',
  scrollTop: 0,
  className: '',
  dataset: {},
  style: { setProperty: noop, removeProperty: noop },
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop,
  removeEventListener: noop,
  appendChild: noop,
  remove: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  scrollTo: noop,
  focus: noop,
  click: noop,
  // Only ever asked for a 2d context, and only to measure text.
  getContext: () => ({ measureText: () => ({ width: 0 }), font: '' }),
};

/* Node ships some of these already (`navigator` is a getter-only global as of
 * Node 22), so assignment is not enough. */
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

const store = new Map();

define('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
});

define('document', {
  documentElement: element,
  body: element,
  hidden: false,
  getElementById: () => element,
  createElement: () => element,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
});

define('window', globalThis);
define('location', { search: '', pathname: '/', replace: noop, reload: noop });
// Node's own `navigator` is left in place: it has no `serviceWorker`, so app.js
// skips registration entirely. There is no `indexedDB` either, and History.all()
// already catches and returns [] — the right answer for a machine with no scans.
define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
define('cancelAnimationFrame', clearTimeout);
define('getComputedStyle', () => ({ fontFamily: 'serif', getPropertyValue: () => '' }));

export { element };
