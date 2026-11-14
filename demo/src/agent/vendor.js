// Loads a vendored library on first use with a classic <script src> (no modules, no fetch: works from file://).
const pending = new Map();

export function loadScript(src, { ready = () => false, timeoutMs = 15000 } = {}) {
  if (ready()) return Promise.resolve();
  if (pending.has(src)) return pending.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    // on a timeout the element goes too, so a retry cannot run the library twice
    const timer = setTimeout(() => { pending.delete(src); el.remove(); reject(new Error(`Timed out loading ${src}`)); }, timeoutMs);
    el.src = src;
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); pending.delete(src); el.remove(); reject(new Error(`Couldn’t load ${src}`)); };
    document.head.append(el);
  });
  pending.set(src, p);
  return p;
}

// A stylesheet next to the library (driver.css). Resolves on load or error: the page still works unstyled.
export function loadStyle(href) {
  if (document.querySelector(`link[data-vendor="${href}"]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = href;
    el.dataset.vendor = href;
    el.onload = () => resolve();
    el.onerror = () => resolve();
    // Before every inline <style>, so the project's overrides (phase3-agent.css) win at equal specificity.
    document.head.prepend(el);
  });
}
