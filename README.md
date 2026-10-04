# Make It Fit

Shrink photos and PDFs to any size limit — offline, private, and still good quality.
This folder is the complete app. It is a web app that installs like a normal Windows app
through the Microsoft Store (GitHub Pages + PWABuilder, the same route as Rfoof).

## Publish in 6 steps

1. **GitHub:** create a new public repository named `MakeItFit` under your account and upload
   everything in this folder (keep the folders `engine`, `js`, `lib`, `icons`, `screenshots`).
2. **Pages:** Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`.
   After 1–2 minutes open `https://haymohsen.github.io/MakeItFit/` (the name is case-sensitive).
3. **Test in Edge:** open the address, press the install icon in the address bar, then turn off
   Wi-Fi and open the app again — it must still work. Drop a PDF and a photo and shrink them.
4. **Partner Center:** reserve the name (try "Make It Fit"; alternatives are listed in the feature
   doc). On *Product identity* copy the Package/Identity/Name, Publisher and Publisher display name.
5. **PWABuilder:** go to pwabuilder.com, enter the Pages address, *Package for stores* → Windows,
   paste the three identity values, download the package, and upload the `.msixbundle` in your
   Partner Center submission.
6. **Listing:** use the text in the feature doc, the screenshots in `screenshots/`, the privacy
   policy address `https://haymohsen.github.io/MakeItFit/privacy.html` and support email
   `haymohsen@gmail.com`. Category: Utilities & tools. Set the one-time price and submit.

## Updating the app later

Change the files on GitHub and change `VERSION` in `app.js` and in `sw.js` (first line of the
`VERSION` constant). Installed copies pick up the new files the next time they start; no new
Store submission is needed unless the icons or name change.

## Folder map

- `index.html`, `styles.css`, `app.js` — the screens.
- `engine/` — the processing engine (runs in a background thread): `image-engine.js` (photos),
  `pdf-engine.js` (PDF smart shrinking), `worker.js` (job router, combine photos into a PDF).
- `js/pdf-tools.js` — previews, protected-PDF checks and "scan mode" (pages → images).
- `js/zip.js` — ZIP writer used by "Save all" when a folder can't be chosen.
- `lib/` — open-source libraries: pdf-lib (MIT) and pdf.js (Apache 2.0) with their licenses.
- `sw.js` — offline support. `manifest.webmanifest` — app identity, icons, "Open with" file types.
- `privacy.html` — privacy policy. `icons/` — app icons. `screenshots/` — Store screenshots.

## Licenses

pdf-lib: MIT (lib/pdf-lib.LICENSE.md). pdf.js: Apache License 2.0 (lib/pdfjs/LICENSE, plus the
licenses in lib/pdfjs/wasm for the JPEG 2000 and JBIG2 decoders). Both allow use in a paid app.
