# Vendored libraries

All are loaded on first use with a classic `<script src="vendor/...">` (no modules, no fetch), so the page works from `file://` and offline. Fetched on 2026-11-12 with `npm pack <name>@<version> --ignore-scripts` from registry.npmjs.org; no install scripts were run.

| Library | Version | Licence | Source | Files here |
|---|---|---|---|---|
| driver.js | 1.10.2 (published 2026-10-18) | MIT, Copyright (c) Kamran Ahmed | https://registry.npmjs.org/driver.js/-/driver.js-1.10.2.tgz | `driver.js.iife.js`, `driver.css`, `driver.js.LICENSE` |
| deep-chat | 2.5.1 (published 2026-08-27) | MIT, Copyright (c) 2024 Ovidijus Parsiunas | https://registry.npmjs.org/deep-chat/-/deep-chat-2.5.1.tgz | `deepChat.bundle.js` (converted, below), `deep-chat.LICENSE` |
| three.js | 0.187.0 (published 2026-10-30), fetched 2026-11-14 | MIT, Copyright 2010-2026 Three.js Authors | https://registry.npmjs.org/three/-/three-0.187.0.tgz | `three.classic.js` (converted, below), `three.LICENSE` |

## Integrity

The sha512 of each tarball, computed locally, equals the registry's `dist.integrity`:

- driver.js-1.10.2.tgz: `sha512-L/EMTriJPAmg+5kIFmrjzt3TI+1NblhHOV/UZkfpgU/uxhSflGheynMBxk5oImDSy6seAEkIl6MzNOc0zdoKtg==` (shasum `2c3fb1458d0edc49c50aff4c03cc8f92faf970f6`)
- three-0.187.0.tgz: `sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==`
- deep-chat-2.5.1.tgz: `sha512-ZLyaSx6z5tScVtIEtqLDQ+zfWqbexntiz0hAdY0N+G68QkH7we5K/WFlo1xczxlF/L8VvCw0O2aKL6fVcpHmZA==` (shasum `42a6e11584ac0603d74e208b58464692c90d8e61`)

## sha256 of the files here

| File | sha256 |
|---|---|
| `driver.js.iife.js` (= `package/dist/driver.js.iife.js`, unchanged) | `541520f33f84cc5cf6696b421f705cc9efe2d72656b3b5cd7f72c22e6d7e17c0` |
| `driver.css` (= `package/dist/driver.css`, unchanged) | `ff1934a5a7ef3f50deb9266ba8945b3eb407ee10b97da12feda4b7c10055bf12` |
| `driver.js.LICENSE` (= `package/license`) | `ec3ce3a08736fefd6a03a6d5b52b0705e6919fe06de9d7bd3fb63dcfb492d76d` |
| `deepChat.bundle.js` (converted) | `99e5ed10c6075090d3afbb3124de361a82cc8d652fc7ccf36140e2d791d8cce2` |
| `three.classic.js` (converted) | `8935fd3483ddef119cf5c0df5ad9ba6e229de57f9374547fb1f8675391dab695` |
| `three.LICENSE` (= `package/LICENSE`) | `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc` |
| `deep-chat.LICENSE` (= `package/LICENSE`) | `12d11204300c461fc3ba872703c1f15e8dc8e07fb58a3111d476ae6903db5388` |

Original `package/dist/deepChat.bundle.js` before conversion: sha256 `6844eaf354e19d50dcdd8ee78968d6ae32ccd4b9f15a883902d60e93d69caf84`.

## three.js conversion

three.js ships only ES modules (`build/three.module.js` imports from `build/three.core.js`); its `three.cjs` is now a stub that `require`s the ES module. `tools/vendor-three.mjs` turns the two files into one classic script: each file keeps its own function scope, the module's `import { … } from './three.core.js'` becomes a destructuring of the core's exports, the `export` lines become returned objects, and `window.THREE` is the frozen union (443 names, `THREE.REVISION === '187'`). Nothing else in either file changes. Sources before conversion: `three.core.js` sha256 `613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578`, `three.module.js` sha256 `104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341`.

To redo it: `npm pack three@<version> --ignore-scripts`, check `dist.integrity`, unpack, then `node tools/vendor-three.mjs <unpacked>/package/build <version>`. The examples (OrbitControls and so on) are not vendored; the globe has its own camera controls.

## deep-chat conversion

`dist/deepChat.bundle.js` is an ES module: its last statement is `export{xl as DeepChat};` and its top level declares many one-letter `const`/`class` names. Loaded as a classic script it fails with a syntax error, and even without the export its top-level names would land in the page's global lexical scope. The conversion is mechanical and nothing else in the file changes:

1. drop the trailing `export{xl as DeepChat};`;
2. wrap the whole body in `(function(){"use strict"; ... window.DeepChat=xl;})();` (strict keeps module semantics);
3. prepend a one-line comment naming the source and the change.

To redo it: take `package/dist/deepChat.bundle.js`, replace the final `export{xl as DeepChat};` with `;`, then wrap as above. The bundle registers the `<deep-chat>` custom element on load; `window.DeepChat` is the class.

Updating either library: fetch the new tarball the same way, check `dist.integrity`, redo the conversion, and update this file.
