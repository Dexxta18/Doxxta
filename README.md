# Doxxta

A full PDF reader and editor for Windows, macOS and Linux (and the browser): the Acrobat Reader experience plus the tools Acrobat keeps behind its Pro subscription, such as editing text, organizing pages, redaction, passwords, OCR, compression, export to Office formats, compare and forms.

Everything happens on your device. Files are never uploaded anywhere.

Doxxta was called Quillmark in its first releases. It still reads the comments and page marks (watermarks, headers and footers…) that Quillmark saved in PDFs, and the desktop app brings over Quillmark's settings, signatures and recent files the first time it runs.

## Quick start

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # production build in dist/
npm run preview    # serve the build at http://localhost:4173
```

`dist/` is a static site: host it on any static host (Netlify, Vercel, GitHub Pages, S3, nginx…). No server code is needed.

## Desktop app

Doxxta installs like any other program. It opens PDFs from your file manager ("Open with", or as your default PDF app), saves straight back to the file, and works without an internet connection. The installers are on the repository's **Releases** page (the version number is in each file's name).

| System | File | Install |
|---|---|---|
| Windows 10 and 11 (64-bit) | `Doxxta-Setup-<version>.exe` | Run it and follow the steps. It installs for your user account (no administrator rights needed) and adds Start menu and desktop shortcuts. Remove it from Settings → Apps. |
| macOS 11 or later | `Doxxta-<version>-arm64.dmg` (Apple Silicon: M1 and later) or `Doxxta-<version>-x64.dmg` (Intel) | Open the disk image and drag Doxxta to Applications. |
| Linux (x86-64) | `Doxxta-<version>-x86_64.AppImage` | Make it executable (`chmod +x Doxxta-*.AppImage`) and run it. |

The installers aren't code-signed yet, so the first launch shows a warning:

- **Windows:** "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** "Apple could not verify Doxxta". Click **Done**, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, then open Doxxta again. If macOS says the app is damaged instead, run `xattr -dr com.apple.quarantine /Applications/Doxxta.app` in Terminal.

### Building the installers

```bash
npm run desktop       # run the desktop app from source
npm run dist:win      # Windows installer, in release/
npm run dist:mac      # macOS disk images (on a Mac)
npm run dist:linux    # Linux AppImage
```

Build each installer on its own system: the macOS app can only be built on a Mac, and building the Windows installer elsewhere also needs [Wine](https://www.winehq.org/). The easiest way to get them all is GitHub: on the repository, open **Actions → Installers → Run workflow**. GitHub builds the desktop installers and the phone apps and publishes them on the repository's **Releases** page, named after the version in `package.json` (pushing a version tag such as `v0.4.0` does the same). Untick "Publish a release" to only get them as downloads on the finished run's page.

Signing removes the first-launch warnings. It needs a code-signing certificate for Windows (set `WIN_CSC_LINK` to the `.pfx` file and `WIN_CSC_KEY_PASSWORD` to its password) and an Apple Developer ID for macOS (`CSC_LINK` and `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization). Without them, Windows builds are unsigned and Mac builds are ad-hoc signed.

## Phone apps

Doxxta for Android and iPhone is the same app in a native shell ([Capacitor](https://capacitorjs.com/)), laid out for phones: the tools and side panels open as full-screen sheets, a bar along the bottom has Tools, Pages, the page number, Search and More, two fingers zoom the pages, and Edit text's formatting toolbar sits above the keyboard. PDFs from other apps open in Doxxta ("Open with" on Android, "Open in" or the share sheet's app row on iPhone); Save, Save as, exports and Print go through the phone's share sheet, to save the file (Files, Drive…), send it or print it.

| Phone | File | Install |
|---|---|---|
| Android 7 or later | `Doxxta-<version>.apk` | Open the file on the phone and allow installing apps from your browser or file manager when Android asks. |
| iPhone, iOS 16.4 or later | `Doxxta-<version>-unsigned.ipa` | Apple only installs apps signed with an Apple ID. With a free one: install [Sideloadly](https://sideloadly.io/) (Windows or Mac), connect the iPhone, drop the `.ipa` on it and sign in; turn on Developer Mode on the iPhone (Settings → Privacy & Security) and trust your Apple ID (Settings → General → VPN & Device Management). Apps signed with a free Apple ID stop opening after 7 days: install again to renew. An Apple Developer Program membership ($99 a year) removes the limit and allows TestFlight and the App Store. |

```bash
npm run mobile:sync   # builds the web app and copies it into android/ and ios/
npx cap open android  # Android Studio: run on a phone or an emulator, or Build → Generate Signed Bundle / APK
npx cap open ios      # Xcode (on a Mac): pick your Apple ID under Signing & Capabilities and run on your iPhone
npm run mobile:icons  # redraws the app icons and launch screens from the logo
```

The **Installers** workflow builds the Android app (`./gradlew assembleRelease`) and the iPhone app (unsigned, with `xcodebuild`) along with the desktop installers. Android apps can only be updated by apps signed with the same key: the workflow signs with the key in the repository's secrets `ANDROID_KEYSTORE_BASE64` (the keystore file, base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, and without them with a throwaway key. Keep a copy of the keystore: without it, a new version can only be installed after removing the old one. **Actions → Phone app check** runs the Android app in an emulator and keeps its screenshots (`tests/mobile/android-smoke.mjs`).

## Features

**Reading**
- Fast rendering with pdf.js; thumbnails, bookmarks, attachments, layers, document info and full-text search panels
- Zoom presets, marquee zoom, rotate view; single page, continuous, two-page, cover page, horizontal and wrapped layouts
- Read mode, full screen, and presentation mode (keyboard, click, swipe; black/white screen)
- Page colors: night (inverted), sepia, high contrast; light/dark/system app theme
- Read Out Loud (page or selection) with voice and speed controls
- Opens password-protected files; respects and shows document restrictions
- Open from disk, drag & drop, a URL, or recent files; multiple documents in tabs

**Comment**
- Highlight, underline, strikethrough, squiggly, area highlight, sticky notes, text boxes, callouts
- Pen, highlighter pen, eraser; rectangles, ellipses, lines, arrows, polygons, polylines, clouds
- Stamps (standard, "Sign here", dynamic with name and date, and your own image or text stamps), snapshot tool
- Replies, review status, filtering and sorting in the comments panel
- Import/export comments as XFDF; comment summary report
- Comments from other apps are imported and stay editable; everything is saved as standard PDF annotations with appearance streams, so other readers show it

**Fill & Sign**
- Fill any form (including calculated fields via the form-scripting sandbox)
- Add text, checkmarks, crosses, dots, circles, lines and dates anywhere
- Signatures and initials: type (six script fonts), draw, or upload an image; saved on the device for reuse

**Edit PDF**
- Edit existing text in place, keeping its formatting: text you don't change stays exactly as it was, and changed words are written in the document's own font at the same size, color, spacing and alignment (left, right, centered or justified). The old glyphs are removed from the page, not covered, and the new text is placed where the old was in the page's text order, so copying, search and CV-screening software read it in sequence
- Fonts are recognized from the names PDFs give them (family, weight from Thin to Black, italics, condensed), so the editor shows text in its own font and weight. When the font embedded in the file lacks a letter, the word is written in the closest font available: the same font installed on the computer (desktop app, when its license allows embedding), the same family from the app's font library, a font made to stand in for it (Carlito for Calibri, Liberation for Arial, Times New Roman and Courier New, Gelasio for Georgia…), or one of the same kind and weight. Light text stays light, bold stays bold
- Word-style formatting while editing text: font (the document's, the app's library of 68 open font families, and in the desktop app the computer's fonts), size, bold, italics, underline, strikethrough, font color, highlight color, alignment and clear formatting, from a toolbar or Word's shortcuts (Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Shift+> and <, Ctrl+] and [, Ctrl+L/E/R/J, Ctrl+Space). With nothing selected, formatting applies to what you type next; Ctrl+Z undoes inside the editor
- Add text and images, add/edit/remove links
- Watermark (text, image or PDF page), header & footer, page numbers, Bates numbering, background (color, image or PDF page); each can be replaced or removed later
- Crop pages

**Organize pages**
- Drag to reorder, rotate, delete, duplicate, insert blank pages or pages from other files, extract
- Split by pages per file, number of files (up to one per page), file size, top-level bookmarks or page ranges (as a zip, separate files, or new tabs)
- Files whose page list is damaged (counting fewer pages than they have, which hides pages in many viewers) are repaired when opened
- Combine files; create PDFs from images, text files, the clipboard or the camera
- Undo/redo

**Prepare a form**
- Text, checkbox, radio, dropdown, list box, button, signature and date fields, with properties such as required, read-only, date formats and button actions
- Import/export form data as XFDF, FDF, JSON or CSV; clear form

**Protect**
- Password protection with 256-bit AES (also AES-128 and legacy RC4), open and permissions passwords, printing/editing/copying restrictions
- Remove security; re-saving a protected file keeps its protection
- Redaction: mark text or areas, search and redact text or patterns (emails, phone numbers, card numbers, SSNs, dates…). Applying redaction removes the underlying text, image pixels and vector graphics
- Remove hidden information (metadata, attachments, scripts, hidden layers, thumbnails); flatten comments and forms

**Optimize & convert**
- Reduce file size (three presets plus custom image resolution/quality)
- Recognize text (OCR) in 20 languages, making scans searchable and selectable
- Export to Word (.docx), Excel (.xlsx), PowerPoint (.pptx), images (PNG, JPEG, WebP), HTML, Markdown and plain text. Word documents keep the page's fonts (open stand-ins such as Liberation Sans become Arial), sizes, bold, italics and colors, line and paragraph spacing, indents, alignment, right-aligned text such as dates (as tab stops), bulleted and numbered lists, and tables (with lines only where the page has them)

**Review tools**
- Compare files: text differences and visual (pixel) differences side by side
- Measure distance, perimeter and area with scales, presets and calibration
- Print with page ranges, scaling, orientation, quality and grayscale; document properties; keyboard shortcuts for everything (press `?`)

## Privacy

Doxxta is a static web app. PDFs are read and written in the browser; nothing is sent to a server. The only network requests after the app has loaded are ones you start:

- **OCR in languages other than English** downloads that language's data the first time (English is bundled).
- **Open from URL** fetches the address you enter.

Preferences, saved signatures and custom stamps are stored in the browser's local storage; the recent files list is stored in IndexedDB. The desktop app keeps the same data in its own settings folder, along with the list of files you have opened (so recent files can reopen them) and its window size.

## Browser support

Current Chrome, Edge, Firefox and Safari. In Chrome and Edge, **Save** writes back to the file you opened (File System Access API); other browsers download the saved file instead. The desktop app always saves back to the file.

## How it works

- **Stack:** Vite, React 19, TypeScript, Zustand for state.
- **Rendering:** [pdf.js](https://mozilla.github.io/pdf.js/) renders pages, text layers and form widgets.
- **Writing:** [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (the maintained `@cantoo` fork, which supports encryption) builds the saved file.
- **OCR:** [tesseract.js](https://tesseract.projectnaptha.com/), running in a web worker.
- **Office export:** `docx` and `pptxgenjs`; spreadsheets are written directly as Office Open XML.

The desktop app is [Electron](https://www.electronjs.org/). `desktop/main.cjs` serves the same build from a private `app://quillmark` address (named after the app's former name, which its stored settings belong to) with a strict content security policy, and shows the system's Open and Save dialogs. The page has no access to Node.js: `desktop/preload.cjs` gives it a few functions, and it can only read and write files the user chose (in a dialog, with "Open with", or by dropping them on the window). `src/lib/desktop.ts` presents those functions to the app as the browser's File System Access API, so the same code opens and saves files in both versions.

While a document is open, changes are kept as data: comments, form values, text edits and redaction marks are records in the store, and page operations are recorded against page ids. Undo/redo works on that state. **Save** (`src/core/save.ts`) builds a new PDF from the original bytes: it applies page operations, rewrites page content streams for text edits and redaction (`src/lib/contentStream.ts` parses and re-serializes them), writes annotations and form fields with appearance streams (`src/annotations/writer.ts`), and finally encrypts if the document is protected (`src/lib/security.ts`).

```
src/
  annotations/   annotation model, rendering, writing to PDF, XFDF
  components/    shell (menus, toolbars, panels), dialogs, modes (organize, compare, presentation), UI kit
  core/          commands, shortcuts, opening and saving documents, permissions
  lib/           pdf.js / pdf-lib helpers, content streams, fonts, text layout, encryption
  ops/           document operations: organize, combine, redact, compress, OCR, export, compare, forms…
  state/         app store, settings, undo history
  viewer/        page view, annotation overlay, text editing layer, thumbnails
desktop/         Electron main process, preload bridge, app icon
android/, ios/   the phone apps' native projects (Capacitor); capacitor.config.ts
scripts/         copies pdf.js/tesseract assets into public/vendor; generates test PDFs; desktop build
tests/e2e/       browser tests
tests/desktop/   desktop app tests
```

## Tests

The browser tests drive the app in headless Chromium with Playwright, then read the saved files back to check what was actually written.

```bash
npx playwright install chromium   # once
npm run test:e2e                  # 9 suites against the dev server (109 checks)
npm run test:e2e -- security      # one suite: organize, forms, editing, export, signing, security, redaction, openurl, phone
npm run test:smoke                # builds, then tests the production build through the UI (incl. OCR)
```

```bash
npm run test:desktop              # desktop app: Open with, saving to disk, dialogs, OCR, Edit text, unsaved-changes prompt
```

The desktop tests replace the system dialogs with answers chosen by the test. They need a display (on a Linux server, run them under `xvfb-run`); set `DOXXTA_APP` to a packaged app (e.g. `release/linux-unpacked/doxxta`) to test an installer's build.

Test PDFs are generated into `test-fixtures/` on the first run, except `tests/assets/cv.pdf`, a résumé made in an office suite for the Edit text checks (`node tests/assets/make-cv.mjs` rebuilds it with LibreOffice); screenshots go to `test-output/shots/`. To use a Chromium you already have, set `CHROMIUM_PATH`.

## AI features (next)

The app is ready for AI features (summaries, chat with a document, smart redaction, form auto-fill, translation) using an OpenAI API key. The building blocks are in place: `src/ops/pageText.ts` and `src/lib/textLayout.ts` extract page text in reading order, OCR covers scans, and every editing operation is a function in `src/ops/` that an assistant can call.

A note on the API key: a key used directly from the browser can be read by anyone who uses that copy of the app. That is fine for a personal build kept to yourself; for anything shared, send requests through a small server that holds the key.

## Known limitations

- **Digital IDs:** signatures are visual (typed, drawn or image). Certificate-based digital signatures and signature validation are not implemented yet.
- **Edit text** works one paragraph at a time, like Acrobat: a paragraph that grows flows onto new lines below it without moving the paragraphs after it, and one that shrinks leaves its space empty. Underlines and highlights already in a PDF are shapes of their own: they stay where they are when the text over them moves.
- **Export to Office** recreates text, tables and images in reading order; multi-column layouts, text boxes and drawings will need touch-ups, as with any PDF converter.
- **Read Out Loud** uses the voices installed on the device; some systems have none.
- Not included: PDF/A and preflight, accessibility tagging, batch actions, cloud storage, and sending documents to others for e-signature (those need a server).
- Very large files are limited by memory.
- The desktop app doesn't update itself yet: install a newer version over the old one.

## License

Doxxta's own code has no license file yet; add one of your choice before sharing it. The app bundles open-source libraries under their own licenses: pdf.js, tesseract.js and idb-keyval (Apache-2.0); pdf-lib, fontkit, React, Zustand, docx, PptxGenJS, fflate and html-entities (MIT); jsdiff (BSD-3-Clause); Lucide icons (ISC); the Inter and signature fonts from Fontsource (SIL Open Font License 1.1, except Homemade Apple, Apache-2.0); the Carlito, Caladea and Liberation fonts used by Edit text (SIL Open Font License 1.1, license files in `public/fonts`); and the font library in `public/fonts/library`, from Google Fonts (each family's license is in its folder: SIL Open Font License 1.1, Apache-2.0 or the Ubuntu Font Licence). `scripts/fonts/build_library.py` rebuilds it (it needs fontTools).
