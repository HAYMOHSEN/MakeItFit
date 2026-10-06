# Make It Fit — fix for the shared app identity

Repository: **HAYMOHSEN/MakeItFit** — app URL: https://haymohsen.github.io/MakeItFit/

## What changed (nothing else in the repository changes)

- `manifest.webmanifest`: `"id": "./"` → `"id": "/MakeItFit/"`
  (identity was `https://haymohsen.github.io/`, shared with your other apps; it is now `https://haymohsen.github.io/MakeItFit/`)
- `sw.js`: `const VERSION = 'makeitfit-1.0.0';` → `const VERSION = 'makeitfit-1.2.0';`
- `sw.js`: `keys.filter((k) => k !== VERSION)` → `keys.filter((k) => k.startsWith('makeitfit-') && k !== VERSION)`
- The activate handler now deletes only Make It Fit's own old caches (names starting with "makeitfit-") instead of every cache on the site, so it no longer wipes the offline copies of your other apps.

The cache-version bump makes Edge fetch the new manifest instead of the copy it cached; users see no difference apart from a quick re-download of the app files on their next launch.

## Steps

1. On GitHub open the repository → **Add file → Upload files** → drop the file(s) from this folder (they overwrite the old ones with the same names) → **Commit changes**. You can instead open each file, click the pencil icon and paste the new content.
2. Wait about a minute, then open https://haymohsen.github.io/MakeItFit/manifest.webmanifest in a browser and check that it shows `"id": "/MakeItFit/"`.
3. Go to pwabuilder.com → enter `https://haymohsen.github.io/MakeItFit/` → **Package for stores → Windows**. Use the same Package ID, Publisher ID and Publisher display name as the previous package and the app name exactly as reserved in Partner Center. Expand the full settings (the "Classic app version" field is hidden by default) and type **App version `1.2.0`** and **Classic app version `1.1.9`** — both higher than the first submission's packages, with the classic number below the app version. Generate and download the package.
4. Partner Center → this app → **Update** (new submission) → **Packages** → upload both the `.msixbundle` and the `.classic.appxbundle` → Submit. Listing, price and trial stay as they are. If Partner Center reports a package "with the same full name", a version number was left at its default — regenerate with the numbers above and replace the uploaded packages.
5. On your own PC uninstall the old copy (Settings → Apps, and `edge://apps`) before installing the updated one to test. Customers keep their data — it is stored per website, not per app identity.
