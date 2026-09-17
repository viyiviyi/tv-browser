# tv-browser — a browser for your TV

[简体中文](README.md) | **English**

A WebView browser for Android TV / TV boxes / projectors: **up, down, left, right, OK and Back on the remote control** are all it takes to browse the web.

It injects the spatial navigation script from [bili-keynav](https://github.com/viyiviyi/bili-keynav) into the page,
so everything on a web page (cards, buttons, links, overlays) can be selected with the D-pad — the OK key means click, the Back button goes back one layer at a time —
except that the site you're browsing this time isn't some particular site, it's the whole internet.

On the TV launcher it appears as **电视浏览器** (literally "TV Browser") — the APK's label is Chinese.

> **How it relates to the neighbouring project**: the navigation engine (the spatial navigation algorithm + the controller) comes from `bili-keynav`,
> and this repository only adds the remote-control bridge layer `src-web/web-bridge.js` and the home screen.
> The built `app/src/main/assets/keynav-web.js` is already committed to the repository,
> so **cloning this repository on its own is enough to build a working APK**; only when you want to change the navigation
> logic itself do you need `bili-keynav` sitting next to it at `../bili-keynav` (see "Changing the web scripts").

## Home screen

```
┌──────────────────────────────────────────────────────────┐
│   Favorites                                              │
│   ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌──────┐            │
│   │icon│ │icon│ │icon│ │icon│ │icon│ │ more │            │
│   └────┘ └────┘ └────┘ └────┘ └────┘ └──────┘            │
│   Bilibili Baidu Weibo Zhihu Taobao  expand              │
│                                                          │
│            ┌──────────────────────────────┐              │
│            │  🔍  Search or enter a URL   │              │
│            └──────────────────────────────┘              │
│               Baidu   Bing   Sogou   Google              │
│                                                          │
│   Recent sites                                           │
│   ┌────┐ ┌────┐ ┌────┐ ┌────┐                            │
│   │icon│ │icon│ │icon│ │icon│                            │
│   └────┘ └────┘ └────┘ └────┘                            │
│   Bilibili Zhihu Douban GitHub                           │
│                                                          │
│            Long press OK: Favorite / Remove              │
└──────────────────────────────────────────────────────────┘
```

A few layout rules:

- **Favorites on top, search box in the middle, recent sites at the bottom**, each shown as an icon plus a name.
- **When favorites take more than one row**, only one row is shown and the last slot becomes "More"; tapping it expands everything, and the button turns into "Collapse" at the same time.
- **Recent sites always take exactly one row**, and how many fit is decided by the screen width (not a hard-coded count):
  when working out the number of columns, **one icon's width is given up as a margin on each side**, and whatever fits in the remaining width is what you get, with the whole row centred.
- Cell size follows the screen: TV logical resolutions differ wildly (1080p is usually 960×540, but 1920×1080 happens too),
  and hard-coded pixels end up crammed together or looking stingy on half the machines. Same for the font size.
- The icon size has its own master switch: `ICON_SCALE` in `home.js` (currently `0.75`).
  It affects the icons, the spacing and how many fit in a row — at 960×540 that's 77px and 9 per row;
  at 1920×1080 it's 126px and 11 per row. Too big or too small, change that one number.
- **Long pressing the OK key pops up a menu**: under "Recent sites" it offers "Favorite this site / Remove from recent sites",
  and under "Favorites" it offers "Move" / "Delete". Picking **Move** enters **move mode**:
  the D-pad shifts that item around (← ↑ earlier, → ↓ later), and the OK key or the Back button finishes,
  with the new order written back to the native side. Move mode expands the favorites automatically
  (otherwise you'd be shuffling something you can't see), and the item being moved is highlighted.

To take a look at the home screen before deciding whether to install:

```powershell
$env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node tools\preview.mjs
# → dist/preview-960x540.png, preview-960x540-expanded.png, preview-1920x1080.png
#   it also prints how big the icons actually are, how many fit in a row, and whether anything overflows
```

## What it does

| Requirement | Implementation |
| --- | --- |
| Six-key remote control | `Activity.dispatchKeyEvent` intercepts everything → hands it to the injected script's `window.__kbTV.key(action)`: the D-pad moves the selection box directly, OK clicks the selected item directly |
| No URL typing on the home screen | A search box; if what you type is keywords it goes to a search engine, if it's a URL (shapes like `example.com`, `192.168.1.1:8080`) it opens straight away |
| Swappable search engines | The row under the search box on the home screen: Baidu (default) / Bing / Sogou / Google; the choice is stored on the native side |
| Site icons | Fetches the site's own `/favicon.ico` online (retrying `/favicon.png` on failure); if neither can be fetched it falls back to **first letter + brand colour block**, and common sites come with a Chinese name and brand colour configured, so there's never an empty square |
| Favorites | 12 common sites preloaded; ones the user adds go through the "long press" below |
| More than one row of favorites | Collapses into a "More" button; tapping it expands everything |
| Recent sites | Only one row, with the number of columns computed from the screen width |
| Favorite / delete / move | **Select a site under "Recent sites" and long press the OK key** → a menu pops up: "Favorite this site" / "Remove from recent sites"; long pressing inside "Favorites" gives "Move" / "Delete", and picking "Move" lets you reorder with the D-pad |
| Typing | Uses the TV/box's own soft keyboard directly. Focusing the input box, popping the keyboard, picking characters with the keyboard's D-pad — all of it is left to WebView and the IME, and the app and the script stay out of it entirely |
| Links open in a new tab | When a page opens a `target=_blank` / `window.open` link, the script tells Android to open a new WebView tab; **the Back button = go back to that previous page**, and the page it came from is restored in place (no reload) |
| The home screen can't be pushed out | The home screen is the bottom layer of the tab stack and is never reclaimed; any http navigation inside it opens as a new tab |
| One press of OK opens it | The OK key is handed to the page as a click; if the page somehow doesn't hit it, the app uses the centre of the selection box reported by the page to fire one real click (fallback) |
| Clickable only if it really clicks | The OK key doesn't dispatch a `click` on "the selected element"; it takes the coordinates of the selected item's centre, finds the element that is genuinely topmost at those coordinates, and dispatches a whole set of pointer/mouse events with coordinates, just like a mouse. Some things have their click handling bound to an element further inside, or simply need the event coordinates, and "clicking the element" won't click them |
| Opening is opening | After `onPageStarted` the script probes and re-injects at 0/40/90/160/260/420/700/1200/2000/3000/4500ms, without waiting for `onPageFinished` (which comes very late on big sites); it also does one more on `doUpdateVisitedHistory` (the moment the new document has just been created) |
| No more permanent "loading" | The loading hint is shrunk down to the bottom of the screen and taken away as soon as the home screen paints (`onPageCommitVisible`) or the script is ready, and it is shown for 6 seconds at most |
| Selected means hover | Every time the selected item changes, the script dispatches pointer/mouse enter events; at the same time it reports the centre point to the native side, which fires one real mouse hover event — that's what makes card zoom, floating layers and other **CSS `:hover`** effects appear with it |
| Fools sites into treating the page as a PC | The UA is swapped for Windows Chrome 122, plus `navigator.platform = 'Win32'`, `maxTouchPoints = 0`, and `userAgentData` is removed |
| Desktop pages fill the TV | Injects `viewport width=1440`, combined with `useWideViewPort + loadWithOverviewMode` scaling; **the local home screen is the exception**, it lays out to the screen width (otherwise the grid column count would be scrambled by the overall scaling) |
| Can watch video | The player container selectors gained the generic `<video>`, so a video window can be selected with the D-pad too: OK = play/pause, double press = fullscreen; in fullscreen the D-pad goes back to the player |
| Overlays can be closed | The Bilibili-specific overlay-closing logic in the engine is a no-op on other sites, so the bridge layer has its own generic fallback: only an overlay that covers more than half the screen and has a findable "close/cancel" button gets closed, and if none is found it does nothing |
| Works on a touchscreen too | **A long press with your finger = a mouse hover.** Touchscreens have no hover at all, and a fair number of desktop pages hide their controls in CSS `:hover` (the "play now" overlay, dropdown menus, the little buttons on a card) — a long press parks the "mouse" where your finger is and brings those out |
| Stays on the layer you're on | The D-pad first works out **which layer** the selected item is on: if it's inside a floating layer (a dropdown, a floating panel), this press only moves within that layer and won't leak down to the content underneath — even when that content is geometrically closer. The layer has to genuinely cover something else and still have somewhere to go; it would rather miss a layer than guess wrong (guessing wrong would trap you inside one) |

Key behaviour:

| Remote control | What happens in the page |
| --- | --- |
| ↑ ↓ ← → | Selects the card, button or link neighbouring in that direction (same row/column preferred, and the selection scrolls into the viewport automatically); **in fullscreen video** it goes back to the player: ← → rewind/fast-forward, ↑ ↓ volume |
| OK | Clicks the selected item; when the selection is a video window (or video is fullscreen) = play/pause |
| OK (double press) | Enters fullscreen; double press again in fullscreen leaves it |
| **Long press OK** (500ms) | Dispatches `kb-longpress` on the selected item: **the home screen pops up its menu** (favorite/delete under "Recent sites", move/delete under "Favorites"); ordinary sites have nobody listening for that event, so nothing happens |
| Back (short press) | ① close the home screen's menu → ② leave fullscreen → ③ close the overlay → ④ leave the input box → ⑤ deselect (remembering the position) → ⑥ go back one page within this tab → ⑦ only when there is no previous page, close the tab → ⑧ when only the home screen is left, show "press Back again to exit" |
| Back (double press / long press) | Closes the current tab directly; when only the home screen is left, exits the app directly |
| Holding a direction | Keeps moving (key repeat) |
| Volume/menu/number and other keys | Never intercepted, handed to the TV system |

> The Back button **goes back a page first, and only then closes the tab** (the browser habit), not the TV video app style of "Back closes the page".
>
> Deselecting **remembers the position**: the next D-pad press carries on from where it was, instead of restarting from the top of the page.
>
> Many infrared remotes **can't send a long press on Back** (they send one press-down and no repeat events), so there's a separate gesture:
> **two Back presses less than 500ms apart (`BrowserWebView.DOUBLE_BACK_MS`) count as a "double press of Back"**,
> which closes the tab directly. The first press still does what it should first (leave fullscreen / deselect / go back a page), and only the second closes the tab.
> Switching tabs clears that timer, so you never get "a double press closes the page underneath as well".

## Touch screens

Phones, tablets, or a TV with a touch panel — plug it in and it works. Tapping, scrolling and pinch-zoom
are all stock WebView behaviour; the only thing added here is the missing piece: **hover**.

A touchscreen has no "the mouse is resting on top of it" (a tap fires click and moves on), and quite a lot of
desktop pages hide their key controls in CSS `:hover`: the "play now" overlay, dropdown menus, buttons that appear
only on hover, tooltips. The remote side solves this with "selected item → one real mouse hover"; here it is a long press:

| Finger | What happens |
| --- | --- |
| Hold still for 400ms (`BrowserWebView.TOUCH_HOVER_MS`) | Parks the "mouse" where your finger is, and the page's `:hover` takes effect |
| Lift the finger | The hover **stays** — because what you usually want next is to tap the thing that just appeared |
| Move the finger (past the system touch slop) | Cancelled; scrolling and dragging are untouched |
| The next press | Clears the previous hover first, so nothing is left behind |

> 400ms is deliberate: a little earlier than the system long-press threshold (500ms), so the hover is dispatched before the text-selection handles come up.
>
> The default long-press behaviour (the context menu) is suppressed by the injected script — a long press
> in this app means hover, and shouldn't pop up some other menu at the same time.
>
> The remote-control selection box isn't used on a touchscreen, but the navigation script still runs
> (it's what opens links as new tabs and so on), and the two don't get in each other's way.

> The OK key **only takes effect on key-up** (it doesn't click on key-down): to tell "short press = open" from "long press = pop up a menu",
> the action can't be performed at the instant of key-down — that way the page would already be open before the user has even finished holding it down.
> The cost is that a single click lags by one press duration (around 100ms).
>
> When the cursor is inside an input box, the D-pad/OK fall back to key events handed to the input box, and the script doesn't grab them.
>
> A single click and a double press share one key, so a single click waits out a decision window (300ms by default): only when no second press
> arrives within the window does "play/pause" take effect, and a double press only does fullscreen, without also pausing along the way.

## Installing on the TV

The APK is at `dist/tv-browser-1.1.0-release.apk`. Three ways to install it, pick any one:

1. **USB stick**: copy it to a USB stick, plug it into the TV → open it with the TV's own file manager to install (the least hassle).
2. **adb over the network** (first turn on "Developer options → Network debugging / ADB debugging" on the TV):
   ```powershell
   tools-cache\android-sdk\platform-tools\adb.exe connect 192.168.x.x:5555
   tools-cache\android-sdk\platform-tools\adb.exe install -r dist\tv-browser-1.1.0-release.apk
   ```
3. **App market tools**: things like "Dangbei Market → Remote push" on the TV, pushing the APK straight over.

The minimum is Android 5.0 (API 21), targetSdk 34, and it doesn't declare that it needs a touchscreen, so a remote-only TV will still show it in the app list.

> Login state (cookies) is kept inside the WebView and isn't shared with other browsers.
>
> At most 5 tabs are kept at once: beyond that the oldest one is reclaimed, so the TV box's memory doesn't give out — but the home screen is always kept.

## Building it yourself

No need to install Android Studio; the scripts pull JDK / Gradle / SDK from domestic mirrors:

```powershell
powershell -File tools\setup-toolchain.ps1   # run once: JDK17 + Gradle 8.7 + Android SDK 34
powershell -File tools\build.ps1             # build → dist\tv-browser-1.1.0-release.apk
powershell -File tools\build.ps1 -Test       # runs the unit tests along the way
powershell -File tools\build.ps1 -Clean      # clean rebuild
```

If there is already a project next to it that has this environment prepared (the script looks for `../bili-tv/tools-cache` by default,
500MB+ of JDK / Gradle / Android SDK), `setup-toolchain.ps1` creates a directory junction pointing straight at it and shares it
instead of downloading it all a second time; if it can't find one it downloads its own.

`setup-toolchain.ps1` goes through mirrors for everything, because this machine can't reach Google directly:

| Thing | Source |
| --- | --- |
| JDK 17 | `repo.huaweicloud.com/openjdk` |
| Gradle 8.7 | `mirrors.cloud.tencent.com/gradle` |
| Android SDK (platforms;android-34 / build-tools;34.0.0 / platform-tools) | `mirrors.cloud.tencent.com/AndroidSDK` |
| AGP and other dependencies | `maven.aliyun.com` (written in `settings.gradle`) |

The signing uses a self-signed certificate generated with `keytool` the first time the script runs (`tools-cache/tvbrowser.keystore`,
passphrase `tvbrowser2024`). For a release, swap in your own certificate.

The icons and the TV banner are generated by `node tools\gen-icons.mjs` (needs playwright), and the results are already committed under `res/`.

## Changing the web scripts

The navigation logic isn't in this repository, it's in `bili-keynav`'s `src/*.js` (`core.js` is the spatial navigation algorithm, `app.js` is the controller),
and it needs to be placed next to this repository at `../bili-keynav`. This repository only adds the remote-control bridge layer `src-web/web-bridge.js`,
and `tools/build-nav.mjs` concatenates the three into `app/src/main/assets/keynav-web.js`:

```powershell
node tools\build-nav.mjs                      # app/src/main/assets/keynav-web.js
powershell -File tools\build.ps1              # repackage (build.ps1 runs the step above automatically)
```

> `app/src/main/assets/keynav-web.js` is a **committed build artifact**: when you only change the home screen or the native code,
> you can run `tools\build.ps1` and get an APK without installing `bili-keynav` at all.
> Only `build-nav.mjs` needs it, and it reports a clear error when it's missing.

`build-nav.mjs` makes **two targeted text replacements** in `app.js` (if a replacement doesn't match it errors out right away — better to fail the build than to ship a quietly broken script):

| Replacement | Why |
| --- | --- |
| Append `, video` to the end of `PLAYER_SELECTOR` | The original only knows Bilibili's own player; a browser visits arbitrary sites, and adding the generic `<video>` is what makes "OK = play/pause, double press = fullscreen" work |
| `videoOf()` understands that "the container itself is a `<video>`" | Once `video` is added to the selector the container may **be** that element, and `querySelector` doesn't match itself; without the fix play/pause would silently stop working |

The entry points the bridge exposes to Android:

```js
window.__kbTV.key('up' | 'down' | 'left' | 'right' | 'ok' | 'longok' | 'back')
//  true  = the page already handled it
//  false = the page didn't want it, so Android goes and closes the tab / goes back a page / exits the app
```

The other direction (page → native) goes through `window.kbHost`:

```js
kbHost.ready()                                  // the script is hooked up, the remote control can be handed over
kbHost.newTab(url)                              // please open a new tab (_blank / window.open / tapping a site on the home screen)
kbHost.hover(x, y)                              // centre of the selected item: native adds a real hover so CSS :hover takes effect
kbHost.select(x, y, w, h, label)                // selection box: native uses it as a fallback click when OK didn't hit anything
// the ones below can only be called from the local home screen; outside pages can't touch the user's favorites
kbHost.favorite(url) / unfavorite(url) / forget(url) / setEngine(id)
kbHost.saveFavorites(json)                      // the home screen reordered the favorites, here is the whole list back
```

Going the other way there are also two **cancellable DOM events** — if the page catches them the key belongs to the page, and if nobody catches them the normal navigation runs:

| Event | When it fires | What the home screen does with it |
| --- | --- | --- |
| `kb-longpress` | On a long press of OK, dispatched on the **currently selected item** | Pops up the favorite/delete and move-position menus |
| `kb-key` | On every D-pad press and OK, dispatched on `document` | In move mode, turns the D-pad from "change the selection" into "shift this item" |

The home screen (`assets/home.html` + `home.js` + `home.css`) is fed its data by the native side through
`window.tvHome.setData({favorites, recent, engine})`; it itself only handles display and interaction —
the Chinese name, brand colour and icon are all derived from the domain inside `home.js`, and the native side only stores URLs.

## Tests

```powershell
# the navigation algorithm layer (needs ../bili-keynav)
cd ..\bili-keynav
node test\core.test.mjs                                        # 23 items: navigation algorithm

# this repository's own layer
cd ..\tv-browser
powershell -File tools\build.ps1 -Test                          # 75 items: JVM unit tests
$env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node test\bridge.mjs  # 46 items: the remote-control bridge contract in Chromium
$env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node test\home.mjs    # 86 items: home screen behaviour and layout in Chromium
```

(The last two need playwright; `NODE_PATH` points at wherever the global `node_modules` lives, change it for your own setup.)

The JVM unit tests come in four layers:

| Test class | Items | Coverage |
| --- | --- | --- |
| `RemoteKeyTest` | 8 | remote key codes / key text → action names (including cross-checking the KeyEvent numeric values) |
| `KeyPolicyTest` | 10 | who handles key-down / key-up / long press |
| `SiteStoreTest` | 23 | address normalisation (`//`, `#fragment`, the slash on the root path), dedup/limits/ordering for favorites and recent sites |
| `BrowserWebViewTest` | 34 | **runs a real Activity / WebView / tab stack on the JVM with Robolectric** |

`BrowserWebViewTest` is the most valuable layer, because what it checks is exactly the glue code that "you can only see once it's installed on a TV":
whether the UA is Windows Chrome, whether multi-window is on (which decides whether `_blank` can become a tab),
whether startup really loads the local home screen, whether http navigation inside the home screen opens a new tab (instead of pushing the home screen out),
whether `file://` is blocked towards outside web pages, whether remote key presses turn into `__kbTV.key('down')` sent into the page,
**whether short press and long press on OK can be told apart**, whether keys get swallowed when the bridge isn't ready,
**whether the Back button goes back a page before closing the tab, whether long press and double press close the tab directly,
and whether the "double press" timer is cleared after navigating**, whether the home screen gets reclaimed as the oldest tab,
and whether visited sites end up in "recent sites".
None of this needs a real device, nor an emulator (Robolectric's android-all package also comes from the Aliyun mirror,
configured in `testOptions` in `app/build.gradle`).

`test/bridge.mjs` covers "the contract on the page side": whether key presses get eaten, whether a long press turns into `kb-longpress`,
whether the OK key hits an element, the Back button's layers (page overlay → popup layer → **deselect first and remember the position** → hand over to native,
and whether the D-pad carries on from where it was after deselecting),
whether links open as new tabs, whether the selected item's hover coordinates are reported to native,
whether the viewport is handled separately as "1440 for outside sites / device-width for the local home screen", and whether repeated injection stacks up two sets.

`test/home.mjs` covers the home screen: how many items fit in one row changes with the screen width, **the margin on each side is never less than one icon's width**,
favorites folding out a "More" past one row and expanding/collapsing, recent sites taking only one line,
**the home screen fitting on one screen at both 960×540 and 1920×1080**, the layout order being favorites → search → recent,
what the long-press menu should contain, which path search / URL entry / engine switching each take,
falling back to the first letter when the favicon can't be fetched, and bad or empty data not bringing the page down.

## Project layout

```
app/src/main/java/com/dsh/tvbrowser/
  MainActivity.java     fullscreen Activity, tab stack (the home screen is never reclaimed), status hints, fullscreen video, exit confirmation
  BrowserWebView.java   WebView setup (UA/multi-window/viewport), URL interception, script injection and readiness probing,
                        key dispatch, the short/long press state machine for the OK key, hover events, fallback clicks
  RemoteKey.java        remote key codes / key text → action names (pure logic, unit-testable)
  KeyPolicy.java        who handles key-down/key-up/long press (pure logic, unit-testable)
  SiteStore.java        favorites / recent sites / search engine choice (URL normalisation is pure logic, unit-testable)
  BrowserBridge.java    the narrow page → native interface window.kbHost
app/src/main/assets/
  home.html/.css/.js    the local home screen: search box + favorites + recent sites
  keynav-web.js         built from ../bili-keynav + src-web/web-bridge.js, don't edit it by hand
  early.js              PC fingerprint spoofing
src-web/
  web-bridge.js         the remote-control bridge layer (this project's own)
tools/
  setup-toolchain.ps1   one-off build environment setup (reuses bili-tv's)
  build.ps1             build + collect artifacts
  build-nav.mjs         concatenates the navigation engine and the bridge layer into keynav-web.js
  preview.mjs           renders the home screen into preview images
  gen-icons.mjs         generates the TV banner/icons (needs playwright)
app/src/test/java/com/dsh/tvbrowser/
  RemoteKeyTest.java        remote key code / key text mapping
  KeyPolicyTest.java        key dispatch policy
  SiteStoreTest.java        address normalisation and storage
  BrowserWebViewTest.java   Robolectric: real Activity/WebView/tabs
test/
  bridge.mjs            browser-side tests for the remote-control bridge
  home.mjs              browser-side tests for the home screen
```

## Known limitations

- **The home screen doesn't remember the session**: every launch goes back to the home screen and doesn't carry on from last time. On a TV, "search the moment it opens" is more real than "restore that pile of tabs from last time".
- **Getting back to the home screen takes several Back presses**: the Back button goes back one page within this tab first, and only closes the tab when there's nothing left to go back to; the home screen is at the bottom of the stack, so pressing back all the way gets you there. To get back to the home screen faster, you can double press Back (the same as a long press, closing the current tab directly).
- **No address bar**: type the URL in the home screen's search box, or get there from favorites/recent sites.
- **Text is small on some sites**: outside sites lay out at a 1440px desktop width and are then scaled to the screen as a whole, and after that scaling the body text comes out smaller.
  To change the scaling, edit `PAGE_WIDTH` in `src-web/web-bridge.js`.
- **Sites with certificate problems won't open**: "ignore certificate errors" is not implemented, and loading fails outright. That's deliberate.
- **DRM video**: limited by the Widevine level, old boxes may only get 480P/720P; ordinary video is unaffected.
- **The home screen's favicon is fetched online**: with no network, or when a site has no favicon, what's shown is the first-letter colour block (not a fault).
