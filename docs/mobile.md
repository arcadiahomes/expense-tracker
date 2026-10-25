# Mobile, offline and voice: how it works and its limits

## Installing the app

Arcadia Home is an installable web app (PWA).

- **Android (Chrome, Edge, Samsung Internet):** open the site, then use **Install app** / **Add to Home screen** from the browser menu. It opens full screen with shortcuts for Voice, Attendance and Materials (long-press the icon).
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**. iOS uses the Apple touch icon and web-app metadata, not the manifest's shortcuts.
- **Desktop (Chrome, Edge):** the install icon in the address bar.

Files: `src/app/manifest.ts`, `public/icons/*`, `src/app/apple-icon.png`, `public/sw.js`, `public/offline.html`.
The icons are generated from `src/assets/arcadia-mark.png` (226×221). A larger or vector master would make the 512 px icons sharper.

## What works offline, and what doesn't

| | Offline |
|---|---|
| Opening a page | Shows the offline page. Pages are never cached, because they hold financial data. |
| Voice entry, already open | Typed or spoken entries can be read on the device (rule-based reader) and **kept as unsynced drafts**. |
| Any other form (expenses, bills, payments, attendance, uploads) | Not saved. The form says it couldn't reach the server; nothing is shown as saved. |
| Speech recognition | Needs a connection in most browsers (see below). |

A banner shows whenever the browser reports being offline. Saves still handle failure when the browser *thinks* it's online but the network is dead.

### Unsynced voice drafts

- **Saved as a draft:** when a voice save can't reach the server (offline, or the connection drops mid-save), the reviewed entries are kept in this browser's storage. The draft records the time they were captured and the save key.
- **Clearly labelled:** each draft shows **"Unsynced, on this device only"** and its capture time. Nothing is reported as saved until the server confirms it.
- **Sent safely:** drafts are sent automatically when the page is open and the connection returns, or with **Sync now**. One sync runs at a time across tabs (Web Locks, where available).
- **No double saves:** a sync reuses the original save key. If the first attempt actually reached the server, the server returns that save instead of saving twice ("nothing was added twice").
- **The capture time travels with it:** each entry's date is fixed when captured, and the capture time is stored on the server (`voice_batches.captured_at`).
- **Nothing is lost on conflict.** A draft is removed only when the server confirms the save, or when the user discards it (with a confirmation). Refused syncs stay on the device:
  - *Needs review*: likely duplicates to confirm, a site that's no longer available, or invalid data. **Open and review** shows the entries with the server's message.
  - *Conflict*: the save key was already used for different entries (it was saved, then the draft was edited). **Save as new** gives it a new key; the server still flags likely duplicates.
- **Limits:**
  - Drafts live in `localStorage`, unencrypted, in this browser profile only. They're keyed to the signed-in user and organization, so another account on a shared phone neither sees nor sends them. But anyone with the device can still read browser storage.
  - Clearing site data or private browsing deletes drafts. Storage can be full; the app then says so and keeps the entries on screen.
  - Only voice entry has offline drafts.

## Caching and privacy

- Every page and API response is sent with `Cache-Control: private, no-store`, so CDNs, proxies and the browser's HTTP cache don't keep financial data (`next.config.ts` → `headers`).
- The service worker caches only public, content-hashed build assets (`/_next/static`), icons and the offline page. It doesn't intercept server actions, RSC requests, API routes, receipts or reports. It never serves a cached page; the e2e tests check what it cached.
- Receipt files are only reachable through short-lived signed links (see CLAUDE.md, *Receipts*).

## Slow networks and repeated taps

- Buttons disable while their request runs, and a guard ignores a second tap (or Enter) that lands before the button re-renders. This covers every form that writes:
  - voice save, expenses, bill upload and bill payments (`useSubmitGuard`);
  - material purchases, usage and voids, attendance, labour payments, workers, suppliers, budgets, receipts, sites and accounts (`useSubmit` in `components/form-bits.tsx`, which also adds the slow notice and the "can't confirm" message).
- After about 4 seconds a "Still saving… keep this screen open" notice appears.
- A request that fails without an answer is reported as "we can't confirm this was saved; check before trying again", never as saved.
- Voice saves are idempotent on the server. Bill payments are guarded on the client, and the bill row lock stops a payment exceeding the balance. Two deliberate separate payments are still allowed.

## Active site

The site picker in the top bar (desktop) or the header chip (phone) sets the **active site**. Voice entry, new expenses, Labour and Materials open on it. It's stored in a cookie (`active_site`) and checked against the user's access on every request.

## Speech recognition: browser and language limits

Voice entry uses the browser's built-in Web Speech API. The app never receives audio, only text.

| Browser | Speech | Notes |
|---|---|---|
| Chrome (Android, desktop) | Yes | Audio is sent to Google's speech service; needs a connection. |
| Edge (desktop) | Yes | Uses Microsoft's speech service; needs a connection. |
| Safari (iOS 14.5+, macOS) | Yes, with limits | Uses Apple's dictation service. Language support follows Apple dictation; Malayalam may not be offered. It can be less reliable in a home-screen (installed) app than in the Safari tab. |
| Firefox | No | Shows "can't turn speech into text"; **Type it** works. |
| In-app browsers (WhatsApp, Instagram, …) and many WebViews | Usually no | Open the link in Chrome or Safari. |

Other limits:

- **Needs HTTPS** (a secure context) and microphone permission. A blocked microphone shows how to re-enable it, with typing as the fallback.
- **One recognition language at a time:** Malayalam (`ml-IN`) or English (`en-IN`).
  - For mixed Malayalam-English speech, choose Malayalam. English words usually come back in Malayalam script (സിമന്റ്, ലേബർ), and the parser knows common construction loanwords.
  - Words outside its vocabulary may be missed or need correcting.
- **Numbers** can come back as digits ("8000") or words ("എണ്ണായിരം", "eight thousand"). The parser handles common forms, including Indian lakh/crore and Malayalam compound numbers. Unusual phrasing should be checked.
- **Names** of workers and suppliers are often misheard, especially in Malayalam script. A name the parser doesn't recognise is shown as new before saving.
- Browsers end recognition **after a pause** or a time limit. The app starts it again by itself until you tap Stop, or until a phrase comes back with nothing in it. On phones it listens one phrase at a time (`continuous` is off), because Chrome on Android repeats earlier words in `continuous` mode. Results are rebuilt from the whole result list on every event, and words not yet marked final still count, because Android often ends without marking the last words final. On phones the words show in the Stop bar as they're heard.
- **Installed app (home screen):** before the first recording the app asks for the microphone itself (`getUserMedia`, and the stream is closed straight away), because installed apps often don't show the prompt for speech recognition. If the microphone is allowed and speech is still refused (iPhone home-screen apps), the app says so and suggests Safari/Chrome or the keyboard's dictation key.
- Background noise lowers accuracy. **Every entry is shown for review**, and nothing is guessed: unsaid payment modes, unclear amounts and unknown categories must be filled in by hand.

## How this was tested

`npm run e2e` (Playwright) builds the app and runs it against the **test** database:

- **Engines and screens:**
  - Desktop Chromium (1440×900) and desktop Firefox (1280×800).
  - Mobile Chromium emulating a Pixel 7.
  - A 375×667 small-phone screen (Chromium).
- **What's checked:**
  - Nothing overflows sideways, and only one main navigation is exposed.
  - The More sheet works by keyboard and Escape, and the skip link works.
  - The new site becomes the visible active site.
  - Private cache headers are set on every page.
  - The manifest, icons, service worker and offline page are served correctly.
  - The mic is at least 96 px.
  - A double tap on Confirm saves once (the stored total is checked).
  - Offline drafts are labelled unsynced and synced on reconnect, with no premature "saved".
  - The service worker caches only static files.
  - axe-core finds no serious or critical WCAG 2.1 AA violations on sign-in, dashboard, voice, labour and materials.

**Not covered:**

- WebKit/Safari: Playwright's WebKit needs system packages that aren't available on the Fedora dev machine. Run `npx playwright install-deps webkit` on Ubuntu or CI and add a WebKit project.
- Real phones (only emulation was used).
- Actual speech recognition (the tests use the typed path, because headless browsers have no microphone).

Check iOS Safari and a real Android phone by hand before release.
