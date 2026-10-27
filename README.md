# Camunda 8.5 documentation archive

A simple static copy of the [Camunda 8.5 documentation](https://unsupported.docs.camunda.io/8.5/docs/components/). Every article links to its original page. Navigation, full-text search, images, downloadable examples, and videos hosted with the documentation work locally.

**Website:** <https://mishankov.github.io/camunda-85-docs/>

**Repository:** <https://github.com/mishankov/camunda-85-docs>

Search ranks exact phrases first, shows the surrounding passage, and highlights matching text in bold.

## Open the website

Open **[site/index.html](site/index.html)** in your browser. No build step, server, account, or API key is required. Search also works when opened directly from disk.

To serve the website over HTTP:

```sh
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000>. Deploy the contents of `site/` to any static web host; relative links support hosting under a subdirectory.

## GitHub Pages deployment

Pushes to `main` run `.github/workflows/pages.yml`. It verifies local links, source attribution, scraper behavior, search, themes, and keyboard navigation, then publishes the committed `site/` directory to GitHub Pages. Pull requests run the same checks without publishing. The workflow can also be run manually from the Actions tab.

Publishing uses GitHub's built-in token with Pages and OIDC permissions; no deployment secret is required. The publishing source in repository **Settings → Pages** is **GitHub Actions**. The scraper is deliberately not run during deployment: the archived website is reproducible without relying on the availability of the unsupported upstream site.

After changing the generator or interface, regenerate `site/` locally, review the result, and commit both source and generated changes before pushing.

## Keyboard navigation

- **⌘K** on macOS or **Ctrl+K** opens search. **/** also opens search outside editable fields.
- Type a query to search article titles and full text. All search runs in your browser.
- **↓** moves from the search field to the first result. **Tab** moves through results; **Enter** opens the focused result. Enter in the field opens the first match.
- **Esc** or **Close** closes search. The query is preserved, and focus returns to the control that opened it.
- **Shift+D** cycles **System theme → Light theme → Dark theme**. The monitor, sun, and moon buttons in the header provide the same choices. Use **Tab** to focus a button and **Enter** or **Space** to activate it. The shortcut is inactive while typing, inside a dialog, or when the theme buttons are disabled.
- **Tab**, then **Enter**, activates the “Skip to content” link. Native section disclosures support Enter and Space.

Top-level documentation sections are in the header. The sidebar shows the current section's original category hierarchy and ordering, with the active article's ancestors expanded. On mobile, the header section links scroll horizontally and the contents tree opens with Enter, Space, or a click. The index uses the same nested trees.

Shortcuts ignore held keys and IME composition, respect disabled controls and open dialogs, and support the physical K position with non-English keyboard layouts. Search buttons expose the same actions as the shortcuts and declare accessibility shortcut metadata.

The theme follows your system appearance by default. The header buttons can override it with light or dark mode; their tooltips identify each theme and the selected button stays pressed. Your selection is saved in this browser and applied before the page is drawn; choosing **System theme** follows subsequent system appearance changes.

## Refresh the archive

Python 3.9 or newer is required. Install the two Python dependencies in a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/scrape.py
```

With [uv](https://docs.astral.sh/uv/), the equivalent setup is:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python scripts/scrape.py
```

The scraper starts from the supplied components page, discovers the published version-specific routes in the source application bundle, and follows links throughout `/8.5/docs/`. It stays within version 8.5. It stores downloads in `.cache/downloads/`, so an interrupted run can be restarted without downloading successful requests again. It retries transient failures and uses six concurrent workers by default.

```sh
.venv/bin/python scripts/scrape.py --refresh     # Re-download source material
.venv/bin/python scripts/scrape.py --workers 3  # Reduce concurrency
.venv/bin/python scripts/scrape.py --output /tmp/camunda-archive
```

The generator uses the source HTML, expands tabbed examples into labelled sections, keeps heading anchors, rewrites links and asset paths, and generates a local full-text index. It merges the partially expanded source sidebars from every archived page into complete navigation trees, preserving categories that do not match URL directories (such as BPMN Events). Generated API schemas and snippets without source sidebars are grouped by directory within the closest matching category. The trees are also saved to `site/navigation.json`; supplemental pages are recorded in the archive report. Original analytics, cookie dialogs, and hosted search services are not included. The generated website has no runtime dependencies.

## Coverage and source availability

See **[site/archive-report.json](site/archive-report.json)** for the build date, complete document list, counts, recovered resources, and source URLs that could not be downloaded. Some API links already return 404 on the original website; these remain links to the source and are listed in the report. The scraper exits with status 1 if any source resource is unavailable, after generating the website, so automation can detect an incomplete source crawl.

Moved identity guides resolve to their published destinations. Incorrectly unversioned image/video links and download links ending in an extra slash are repaired. When a WordPress thumbnail is missing, the original image is downloaded instead.

External websites and embedded third-party videos require an internet connection. Content loaded exclusively by the original site's JavaScript is outside this HTML archive; the **Original page** link provides access to the source. Copyright and licensing remain with Camunda and the respective content owners; the documentation's license and legal-notice pages are included.

The upstream documentation license is reproduced in [LICENSE-DOCUMENTATION.txt](LICENSE-DOCUMENTATION.txt) and [site/LICENSE.txt](site/LICENSE.txt). See [NOTICE.txt](NOTICE.txt) for attribution and a description of the presentation changes. This is an independent archive.

## Verify changes

```sh
.venv/bin/python scripts/verify.py
npm ci
npm run test:scraper
npm test
```

The structural check verifies every local link and asset reference, each article's exact original-page URL, and the conversion of tabbed examples. Browser tests use Playwright with installed Google Chrome to exercise search and keyboard navigation, IME/repeat/disabled/dialog handling, non-English layouts, direct-file usage, expanded examples, and a mobile viewport. Test screenshots are written to `test-results/`.

Source files:

- `scripts/scrape.py`: resumable download and static-site generator.
- `web/site.css`, `web/site.js`, and `web/theme.js`: standalone presentation, search interface, and saved color theme.
- `site/`: ready-to-open website.
- `tests/browser.test.mjs`: browser verification.

After editing `web/`, run the scraper again to copy the updated interface into `site/`.
