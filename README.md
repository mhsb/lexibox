# Dictionary Notebook

A static, offline-capable web app (PWA): a lightweight reader for MDict `.mdx` dictionaries
plus a Leitner-box notebook. No build step, no dependencies, no server.

## Publish on GitHub Pages
1. Put your dictionary at `dict/dict.mdx` (or change the path in `js/config.js`).
2. Push the folder to a repository, then Settings -> Pages -> deploy from the branch root.
3. Open the site on the phone and choose "Install app" / "Add to Home screen".
4. When you replace the bundled dictionary, change `BUNDLED_DICT_VERSION` in `js/config.js`
   so phones fetch the new file. When you change any app file, bump the `CACHE` name in `sw.js` (files also refresh in the background).

Users can also pick their own `.mdx` file in Settings. It is stored on the phone (IndexedDB),
indexed once, and works offline afterwards.

## Using it
A short tutorial opens on first launch (Settings -> "Show the tutorial" reopens it).
- Search; tap a definition paragraph to pick it, use "+ ¶" to extend to following paragraphs,
  or long-press to select your own text. Then "Add" and optionally type or paste the context sentence.
- Review: Leitner boxes with intervals 1, 2, 4, 8, 16 days (editable in Settings).
  "Remembered" moves up a box, "Forgot" returns to box 1.
- Settings -> backup: full JSON (entries and progress) and an AnkiDroid file.

## AnkiDroid import
Download the Anki file (`.txt`), open it with AnkiDroid (Import). It uses Anki's text-file
headers: tab separated, HTML on, note type Basic, deck name from Settings, GUID in column 1
(re-importing updates cards instead of duplicating them). Leitner progress is not transferred;
Anki schedules by itself. The JSON keeps the real progress.

## Limits
- Supported: MDX v1/v2, zlib, LZO or stored blocks, UTF-8/UTF-16/GBK/Big5, key-index encryption.
- Not supported: MDX v3, registration-locked (record-encrypted) files, `.mdd` media.
- Dictionary CSS/images live in `.mdd` files, so entries are shown with the app's own styling.

## Tests (Node, plus Playwright for the browser test)
    node tests/test-mdict.js
    node tests/test-leitner.js
    node tests/e2e.js

## Credits
Developed by Hosein Sheibah - https://sheibah.ir
