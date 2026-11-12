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

## Quick lookup from other apps (Android)
After the app is installed ("Add to Home screen" / "Install app"), select a word or sentence in any
app, tap **Share**, and choose Dictionary Notebook. One to three words are looked up at once; a longer
text opens in the reader (below).
A web app cannot add itself to the Copy / Web search row of the selection menu: that needs a native
Android app (the "Process text" action), which the later Android version can provide.

## Reader
New users: **Try the demo** (on the home page and at the end of the tutorial) opens a short text and a coach walks through tapping a word, resizing the panel, adding a card, the search tab and turning pages.
Tap **Open or paste text** (between the search field and the entry) to read an **EPUB, DOCX,
Markdown, HTML or plain text** file, or share longer text from another app. It fills the home page and is
paginated; headings, bold/italic, lists, quotes and tables are kept. Your place, text size and font are remembered.
- Swipe sideways or tap the empty page edges to turn pages. Swipe down, or tap the **Search & options** tab at the top, to show the search field
  (with Contents, Text size, Open and Clear); swipe up or tap the page to hide it.
- Tap a word: its definition rises from the bottom. Drag the handle to resize the panel, or press the
  arrow to hide it. "Add to notebook" fills the context with the sentence around the word.
- Not supported: images, footnotes, DRM-protected EPUBs, PDF, ODT, DOC, DOCX numbering styles. Files up to 40 MB.
- Word tapping needs a current Chrome/Edge (Android). The book is stored in the browser, one at a time.

## Limits
- Supported: MDX v1/v2, zlib, LZO or stored blocks, UTF-8/UTF-16/GBK/Big5, key-index encryption.
- Not supported: MDX v3, registration-locked (record-encrypted) files.
- **Media (.mdd):** select the `.mdd` file(s) together with the `.mdx` (Settings > Choose dictionary file), or add them
  later with "Add media files". Entries then use the dictionary's own stylesheet, images and pronunciation audio.
  The CSS is sandboxed: it can only restyle the entry text (no positioning, no outside URLs, and the page colours and
  background stay the app's, so dark mode keeps working). Turn it off with "Use the dictionary's own colours, fonts and images".
  Without a `.mdd`, entries use the app's own styling and sound links are hidden.
- To ship media with the site, put the file next to the dictionary and list it in `js/config.js`
  (`BUNDLED_MEDIA: ['dict/dict.mdd']`), then change `BUNDLED_DICT_VERSION`.

## Tests (Node, plus Playwright for the browser test)
    node tests/test-mdict.js
    node tests/test-leitner.js
    node tests/test-media.js
    node tests/e2e.js

## Credits
Developed by Hosein Sheibah - https://sheibah.ir
