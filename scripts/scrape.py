#!/usr/bin/env python3
"""Archive the published Camunda 8.5 HTML as an independent static site."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://unsupported.docs.camunda.io"
PREFIX = "/8.5/"
START = ORIGIN + PREFIX + "docs/components/"
MOVED_PAGES = {
    "/8.5/docs/self-managed/setup/guides/connect-to-an-oidc-provider/": "/8.5/docs/self-managed/identity/configuration/connect-to-an-oidc-provider/",
    "/8.5/docs/self-managed/setup/guides/using-existing-keycloak/": "/8.5/docs/self-managed/identity/configuration/connect-to-an-existing-keycloak/",
}
FILE_EXTENSIONS = {".html", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".mp4", ".webm", ".zip", ".gz", ".jar", ".bpmn", ".dmn", ".xml", ".json", ".yaml", ".yml", ".graphql", ".graphqls", ".txt", ".csv", ".md", ".js", ".css"}
SECTIONS = {
    "components": "Using Camunda 8",
    "guides": "Guides",
    "self-managed": "Self-Managed",
    "apis-tools": "APIs & tools",
    "reference": "Reference",
    "tags": "Topics",
}
SECTION_PAGES = {
    "guides": ORIGIN + PREFIX + "docs/guides/",
    "components": START,
    "self-managed": ORIGIN + PREFIX + "docs/self-managed/about-self-managed/",
    "apis-tools": ORIGIN + PREFIX + "docs/apis-tools/working-with-apis-tools/",
    "reference": ORIGIN + PREFIX + "docs/reference/",
    "tags": ORIGIN + PREFIX + "docs/tags/",
}


def esc(value):
    return html.escape(str(value), quote=True)


def sanitize_examples(source):
    """Do not redistribute credential-shaped Slack URLs from upstream examples."""
    return re.sub(
        r'https://hooks\.slack\.com/services/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+',
        'https://hooks.slack.com/services/WORKSPACE/CHANNEL/WEBHOOK_TOKEN',
        source,
    )


def canonical_page(value, base=START):
    url = urlsplit(urljoin(base, value))
    if url.netloc not in (urlsplit(ORIGIN).netloc, "docs.camunda.io"):
        return None
    path = url.path
    if path == PREFIX.rstrip("/"):
        path += "/"
    if path.rstrip("/") == PREFIX + "docs":
        path = PREFIX
    if path != PREFIX and not path.startswith(PREFIX + "docs/"):
        return None
    # Downloadable files are assets, never documentation routes.
    if path != PREFIX and Path(path.rstrip("/")).suffix.lower() in FILE_EXTENSIONS:
        return None
    path = posixpath.normpath(path) + "/"
    path = MOVED_PAGES.get(path, path)
    return ORIGIN + path


def page_file(url):
    path = unquote(urlsplit(url).path)[len(PREFIX):].strip("/")
    if ".." in Path(path).parts:
        raise ValueError("Unsafe page path")
    return Path(path) / "index.html"


def relative(target, current):
    return Path(os.path.relpath(target, current.parent)).as_posix()


def section_for(url):
    parts = urlsplit(url).path.split("/")
    return parts[3] if len(parts) > 3 and parts[2] == "docs" else "overview"


class Archive:
    def __init__(self, output, cache, workers, refresh=False):
        self.output = output
        self.cache = cache
        self.workers = workers
        self.refresh = refresh
        self.pages = {}
        self.failures = {}
        self.asset_files = {}
        self.asset_errors = {}
        self.asset_recoveries = {}
        self.source_routes = set()
        self.attempted_urls = set()
        self.navigation_trees = {}
        self.navigation_fallbacks = {}
        cache.mkdir(parents=True, exist_ok=True)

    def fetch(self, url):
        key = hashlib.sha256(url.encode()).hexdigest()
        cached = self.cache / key
        if cached.exists() and not self.refresh:
            return cached.read_bytes()
        for attempt in range(4):
            try:
                request = Request(url, headers={"User-Agent": "Camunda85StaticArchive/1.0 (personal documentation mirror)", "Accept-Encoding": "identity"})
                with urlopen(request, timeout=45) as response:
                    data = response.read()
                temporary = cached.with_suffix(".tmp")
                temporary.write_bytes(data)
                temporary.replace(cached)
                return data
            except (HTTPError, URLError, TimeoutError, OSError) as error:
                if isinstance(error, HTTPError) and error.code in (400, 401, 403, 404, 410):
                    raise
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)

    def discover(self):
        soup = BeautifulSoup(self.fetch(START), "html5lib")
        urls = {START}
        for script in soup.select("script[src]"):
            source = urljoin(START, script["src"])
            if "/assets/js/main." not in source:
                continue
            bundle = self.fetch(source).decode()
            for path in re.findall(r'path:\s*"(/8\.5/[^"?#]*)"', bundle):
                page = canonical_page(path)
                if page:
                    urls.add(page)
        print(f"Discovered {len(urls)} published routes", flush=True)
        self.source_routes = urls
        return urls

    def read_page(self, url):
        soup = BeautifulSoup(sanitize_examples(self.fetch(url).decode('utf-8')), "html5lib")
        content = soup.select_one(".theme-doc-markdown") or soup.find("main")
        if content is None:
            raise ValueError("No documentation content found")
        heading = content.find("h1")
        title = heading.get_text(" ", strip=True) if heading else soup.title.get_text().split(" | ")[0]
        links = {page for anchor in soup.select("a[href]") if (page := canonical_page(anchor["href"], url))}
        pagination = []
        for anchor in soup.select(".pagination-nav a[href]"):
            pagination.append({"url": urljoin(url, anchor["href"]), "title": anchor.get_text(" ", strip=True)})
        navigation = self.read_navigation(soup, url)
        # Docusaurus copy widgets need React; code and native links stay intact.
        for element in content.select("script, style, .buttonGroup_M5wJ, .hash-link, .theme-edit-this-page"):
            element.decompose()
        # Expand tabbed examples into labelled sections, including inactive panels.
        for tablist in content.select('[role="tablist"]'):
            if tablist.parent is None:
                continue
            labels = [tab.get_text(" ", strip=True) for tab in tablist.select('[role="tab"]')]
            panels = tablist.parent.select('[role="tabpanel"]')
            for label, panel in zip(labels, panels):
                heading = soup.new_tag("h4", attrs={"class": "example-label"})
                heading.string = label
                panel.insert_before(heading)
            tablist.decompose()
        for element in content.select('[role="tabpanel"]'):
            for attr in ("hidden", "style", "role", "aria-labelledby", "tabindex"):
                element.attrs.pop(attr, None)
        for button in content.find_all("button"):
            button.decompose()
        for element in content.find_all(True):
            for attr in list(element.attrs):
                if attr.startswith("on"):
                    del element[attr]
        for image in content.select("img:not([alt])"):
            name = Path(urlsplit(image.get("src", "")).path).stem
            name = re.sub(r'-[a-f0-9]{20,}$', '', name)
            image["alt"] = image.get("title") or re.sub(r'[-_]+', ' ', name).strip() or "Documentation illustration"
        return {"url": url, "title": title, "section": section_for(url), "content": str(content),
                "text": content.get_text(" ", strip=True), "pagination": pagination, "links": links,
                "navigation": navigation}

    @staticmethod
    def read_navigation(soup, base):
        """Read actual sidebar categories; their hierarchy often differs from URLs."""
        def read_list(menu):
            nodes = []
            for item in menu.find_all("li", recursive=False):
                category = "theme-doc-sidebar-item-category" in item.get("class", [])
                header = item.find("div", recursive=False) if category else item
                anchor = header.find("a", class_="menu__link") if header else None
                if anchor is None:
                    continue
                target = canonical_page(anchor.get("href", ""), base)
                children = item.find("ul", recursive=False)
                nodes.append({"label": anchor.get_text(" ", strip=True), "url": target,
                              "category": category, "children": read_list(children) if children else []})
            return nodes
        menu = soup.select_one(".theme-doc-sidebar-menu")
        return read_list(menu) if menu else []

    @staticmethod
    def merge_navigation(target, incoming):
        """Combine partially expanded snapshots without changing source order."""
        def identity(node):
            return (node["category"], node["label"] if node["category"] else node["url"])
        by_key = {identity(node): node for node in target}
        for source in incoming:
            key = identity(source)
            if key not in by_key:
                node = {**source, "children": []}
                target.append(node)
                by_key[key] = node
            node = by_key[key]
            Archive.merge_navigation(node["children"], source["children"])

    @staticmethod
    def navigation_urls(nodes):
        urls = set()
        for node in nodes:
            if node["url"]:
                urls.add(node["url"])
            urls.update(Archive.navigation_urls(node["children"]))
        return urls

    def prepare_navigation(self):
        self.navigation_trees = {section: [] for section in SECTIONS}
        self.navigation_fallbacks = {}
        for page in sorted(self.pages.values(), key=lambda page: page["url"]):
            if page["section"] in self.navigation_trees:
                self.merge_navigation(self.navigation_trees[page["section"]], page.get("navigation", []))
        for section, tree in self.navigation_trees.items():
            represented = self.navigation_urls(tree)
            missing = sorted((page for page in self.pages.values() if page["section"] == section and page["url"] not in represented), key=lambda page: page["title"].casefold())
            if missing:
                self.add_supplemental_navigation(tree, missing, section)
                if section != "tags":
                    self.navigation_fallbacks[section] = [page["url"] for page in missing]

    @staticmethod
    def add_supplemental_navigation(tree, pages, section):
        """Group generated API schemas/snippets which have no source sidebar."""
        root_path = PREFIX + "docs/" + section + "/"
        categories = []

        def collect(nodes, depth=0):
            for node in nodes:
                if node["category"] and node["url"]:
                    path = urlsplit(node["url"]).path
                    slug = re.sub(r'[^a-z0-9]+', '-', node["label"].lower()).strip('-')
                    base = path if path.rstrip('/').split('/')[-1] == slug else path.rstrip('/').rsplit('/', 1)[0] + '/'
                    if base.startswith(root_path) and base != root_path:
                        categories.append((base, depth, node))
                collect(node["children"], depth + 1)
        collect(tree)
        for page in pages:
            path = urlsplit(page["url"]).path
            matches = [(base, depth, node) for base, depth, node in categories if path.startswith(base)]
            if matches:
                base, _, parent = max(matches, key=lambda candidate: (len(candidate[0]), candidate[1]))
                nodes = parent["children"]
            elif section == "tags" or not tree:
                base, nodes = root_path, tree
            else:
                parent = next((node for node in tree if node["label"] == "Additional pages"), None)
                if parent is None:
                    parent = {"label": "Additional pages", "url": None, "category": True, "children": []}
                    tree.append(parent)
                base, nodes = root_path, parent["children"]
            for directory in path.removeprefix(base).strip('/').split('/')[:-1]:
                label = {"react-components": "Embedded examples", "assets": "Examples"}.get(directory, directory.replace('-', ' ').capitalize())
                child = next((node for node in nodes if node["category"] and node["label"] == label), None)
                if child is None:
                    child = {"label": label, "url": None, "category": True, "children": []}
                    nodes.append(child)
                nodes = child["children"]
            nodes.append({"label": page["title"], "url": page["url"], "category": False, "children": []})

    def render_navigation(self, nodes, current, current_url=None):
        def page_link(url, label):
            selected = ' aria-current="page"' if url == current_url else ""
            return f'<a href="{esc(relative(page_file(url), current))}"{selected}>{esc(label)}</a>'

        output = []
        for node in nodes:
            url = node["url"]
            if not node["category"]:
                if url in self.pages:
                    output.append(page_link(url, node["label"]))
                continue
            children = self.render_navigation(node["children"], current, current_url)
            child_urls = self.navigation_urls(node["children"])
            if url in self.pages and url not in child_urls:
                children = page_link(url, self.pages[url]["title"]) + children
            if not children:
                continue
            urls = (child_urls | {url}) & self.pages.keys()
            opened = current_url in urls
            output.append(f'<details class="nav-group"{" open" if opened else ""}><summary title="Expand or collapse (Enter / Space)">{esc(node["label"])}</summary><div>{children}</div></details>')
        return "".join(output)

    def crawl(self, seeds, limit=None):
        pending = set(seeds)
        attempted = set()
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            while pending:
                batch = sorted(pending - attempted)
                if limit:
                    batch = batch[:max(0, limit - len(attempted))]
                if not batch:
                    break
                attempted.update(batch)
                pending.clear()
                futures = {executor.submit(self.read_page, url): url for url in batch}
                for future in as_completed(futures):
                    url = futures[future]
                    try:
                        page = future.result()
                        self.pages[url] = page
                        pending.update(page["links"] - attempted)
                    except Exception as error:
                        self.failures[url] = str(error)
                        print(f"PAGE ERROR {url}: {error}", flush=True)
                    if len(self.pages) % 50 == 0:
                        print(f"Read {len(self.pages)} pages ({len(attempted)} scheduled)", flush=True)
        self.attempted_urls = attempted

    def asset_url(self, value, base):
        if not value or value.startswith(("data:", "blob:", "#")):
            return None
        url = urlsplit(urljoin(base, value))
        if url.scheme not in ("https", "http"):
            return None
        # Several published download links mistakenly append / to filenames.
        if url.netloc == urlsplit(ORIGIN).netloc and Path(url.path.rstrip("/")).suffix:
            url = url._replace(path=url.path.rstrip("/"))
        if url.netloc == urlsplit(ORIGIN).netloc and url.path.startswith(("/img/", "/videos/", "/assets/")):
            url = url._replace(path=PREFIX.rstrip("/") + url.path)
        return urlunsplit((url.scheme, url.netloc, url.path, url.query, ""))

    def collect_assets(self):
        urls = set()
        for page in self.pages.values():
            soup = BeautifulSoup(page["content"], "html5lib")
            for element, attr in self.asset_attributes(soup, page["url"]):
                if url := self.asset_url(element.get(attr), page["url"]):
                    urls.add(url)
            for element in soup.select("[srcset]"):
                if "data:" not in element["srcset"]:
                    for candidate in element["srcset"].split(","):
                        if url := self.asset_url(candidate.strip().split()[0], page["url"]):
                            urls.add(url)
        print(f"Downloading {len(urls)} images and attachments", flush=True)
        directory = self.output / "assets/media"
        directory.mkdir(parents=True, exist_ok=True)

        def download(url):
            suffix = Path(urlsplit(url).path).suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
                suffix = ".bin"
            filename = Path("assets/media") / (hashlib.sha256(url.encode()).hexdigest()[:24] + suffix)
            try:
                data = self.fetch(url)
            except HTTPError as error:
                # WordPress removed two generated thumbnails; originals still exist.
                fallback = re.sub(r'-\d+x\d+(\.(?:png|jpe?g))$', r'\1', url)
                if error.code == 404 and urlsplit(url).netloc == "camunda.com" and fallback != url:
                    data = self.fetch(fallback)
                    self.asset_recoveries[url] = fallback
                else:
                    raise
            (self.output / filename).write_bytes(data)
            return filename

        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(download, url): url for url in sorted(urls)}
            for number, future in enumerate(as_completed(futures), 1):
                url = futures[future]
                try:
                    self.asset_files[url] = future.result()
                except Exception as error:
                    self.asset_errors[url] = str(error)
                    print(f"ASSET ERROR {url}: {error}", flush=True)
                if number % 100 == 0:
                    print(f"Downloaded {number}/{len(urls)} assets", flush=True)

    @staticmethod
    def asset_attributes(soup, base):
        for element in soup.select("img[src], source[src], video[src], audio[src], track[src], embed[src]"):
            yield element, "src"
        for element in soup.select("video[poster]"):
            yield element, "poster"
        for element in soup.select("object[data]"):
            yield element, "data"
        for element in soup.select("a[href]"):
            url = urlsplit(urljoin(base, element["href"]))
            if url.netloc == urlsplit(ORIGIN).netloc and Path(url.path).suffix and not canonical_page(element["href"], base):
                yield element, "href"

    def rewrite_content(self, page):
        current = page_file(page["url"])
        soup = BeautifulSoup(page["content"], "html5lib")
        for element, attr in self.asset_attributes(soup, page["url"]):
            value = element[attr]
            url = self.asset_url(value, page["url"])
            if url in self.asset_files:
                fragment = urlsplit(value).fragment
                element[attr] = relative(self.asset_files[url], current) + ("#" + fragment if fragment else "")
            elif url:
                element[attr] = urljoin(page["url"], value)
        for element in soup.select("[srcset]"):
            if "data:" in element["srcset"]:
                continue
            candidates = []
            for candidate in element["srcset"].split(","):
                parts = candidate.strip().split()
                if not parts:
                    continue
                url = self.asset_url(parts[0], page["url"])
                parts[0] = relative(self.asset_files[url], current) if url in self.asset_files else urljoin(page["url"], parts[0])
                candidates.append(" ".join(parts))
            element["srcset"] = ", ".join(candidates)
        for element in soup.select("a[href]"):
            value = element["href"]
            if value.startswith("#"):
                continue
            target = canonical_page(value, page["url"])
            if target in self.pages:
                fragment = urlsplit(value).fragment
                element["href"] = relative(page_file(target), current) + ("#" + fragment if fragment else "")
            elif target:
                element["href"] = urljoin(page["url"], value)
            elif value.startswith("/"):
                element["href"] = urljoin(page["url"], value)
        for element in soup.select("iframe[src]"):
            element["src"] = urljoin(page["url"], element["src"])
            element["loading"] = "lazy"
            element["title"] = element.get("title", "Embedded content (requires internet)")
        # Content uses heading IDs for cross-page references; retain them verbatim.
        headings = []
        for heading in soup.select("h2[id], h3[id]"):
            headings.append(f'<a class="toc-{heading.name}" href="#{esc(heading["id"])}">{esc(heading.get_text(" ", strip=True))}</a>')
        return soup.body.decode_contents(), "".join(headings)

    def navigation(self, current, current_url=None):
        return self.render_navigation(self.navigation_trees.get(section_for(current_url), []), current, current_url)

    def primary_navigation(self, current, current_url):
        links = []
        for section, url in SECTION_PAGES.items():
            if url not in self.pages:
                continue
            selected = ' aria-current="location"' if current_url and section_for(current_url) == section else ""
            links.append(f'<a href="{esc(relative(page_file(url), current))}"{selected}>{esc(SECTIONS[section])}</a>')
        return '<nav class="primary-nav" aria-label="Documentation sections">' + "".join(links) + '</nav>'

    def layout(self, title, current, body, current_url=None, toc=""):
        assets = relative(Path("assets"), current)
        home = relative(Path("index.html"), current)
        section = section_for(current_url) if current_url else None
        sidebar = f'<aside class="sidebar" aria-label="Documentation"><details class="section-menu" open><summary title="Expand or collapse contents (Enter / Space)">{esc(SECTIONS.get(section, "Documentation"))} <span>Contents</span></summary><nav aria-label="{esc(SECTIONS.get(section, "Documentation"))}">{self.navigation(current, current_url)}</nav></details></aside>' if current_url else ""
        return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Offline archive of the Camunda 8.5 documentation. {esc(title)}">
<title>{esc(title)} · Camunda 8.5 archive</title><script src="{assets}/theme.js"></script><link rel="stylesheet" href="{assets}/site.css">
<script defer src="{assets}/site.js" data-root="{esc(relative(Path('.'), current))}/"></script></head>
<body><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><a class="brand" href="{home}">Camunda <strong>8.5</strong></a>
{self.primary_navigation(current, current_url)}
<div class="header-tools"><button class="search-button" type="button" aria-haspopup="dialog" aria-controls="search-dialog" aria-keyshortcuts="Meta+K Control+K /" title="Search documentation (⌘K / Ctrl+K or /)"><span>Search documentation</span><kbd class="search-shortcut">⌘ K</kbd></button>
<div id="theme-choice" class="theme-picker" role="group" aria-label="Color theme" aria-keyshortcuts="Shift+D" title="Color theme (Shift+D)">
<button type="button" data-theme-choice="system" aria-label="System theme" title="System theme (Shift+D to cycle)" aria-pressed="true"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/></svg></button>
<button type="button" data-theme-choice="light" aria-label="Light theme" title="Light theme (Shift+D to cycle)" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg></button>
<button type="button" data-theme-choice="dark" aria-label="Dark theme" title="Dark theme (Shift+D to cycle)" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5 8.5 8.5 0 1 0 20.5 13.2Z"/></svg></button>
</div></div></header>
<div class="archive-notice">Archived documentation · Version 8.5 is no longer maintained. <a href="https://docs.camunda.io/">Current Camunda docs ↗</a></div>
<div class="layout{' layout-index' if not current_url else ''}">{sidebar}
<main id="main" tabindex="-1">{body}<footer>Documentation © Camunda. Independent archive; presentation modified. <a href="{esc(relative(Path('LICENSE.txt'), current))}">License</a><a href="{esc(relative(Path('archive-report.json'), current))}">Archive details</a></footer></main>
<aside class="page-toc" aria-label="On this page">{'<h2>On this page</h2>' + toc if toc else ''}</aside></div>
<dialog id="search-dialog" aria-labelledby="search-title"><div class="search-heading"><h2 id="search-title">Search documentation</h2><button id="close-search" type="button" aria-keyshortcuts="Escape" title="Close search (Esc)">Close <kbd>Esc</kbd></button></div>
<label class="sr-only" for="search-input">Search all Camunda 8.5 documentation</label><input id="search-input" type="search" placeholder="Search a topic, component, or phrase…" autocomplete="off" spellcheck="false">
<p id="search-status" role="status">Type to search all archived pages.</p><div id="search-results"></div></dialog></body></html>'''

    def build(self):
        self.output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'LICENSE-DOCUMENTATION.txt', self.output / 'LICENSE.txt')
        (self.output / '.nojekyll').touch()
        self.prepare_navigation()
        for filename in ("theme.js", "site.css", "site.js"):
            target = self.output / "assets" / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "web" / filename, target)
        search = []
        for url, page in sorted(self.pages.items()):
            current = page_file(url)
            if current == Path("index.html"):
                # The archive index replaces the source marketing landing page.
                continue
            content, toc = self.rewrite_content(page)
            source = f'<div class="article-meta"><span>{esc(SECTIONS.get(page["section"], "Documentation"))} / 8.5</span><a class="original-link" href="{esc(url)}" target="_blank" rel="noopener noreferrer">Original page <span aria-hidden="true">↗</span></a></div>'
            pagination = []
            for link in page["pagination"]:
                target = canonical_page(link["url"])
                if target in self.pages:
                    pagination.append(f'<a href="{esc(relative(page_file(target), current))}">{esc(link["title"])}</a>')
            body = source + f'<article class="markdown">{content}</article><nav class="pagination" aria-label="Adjacent pages">{"".join(pagination)}</nav>'
            destination = self.output / current
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(self.layout(page["title"], current, body, url, toc), encoding="utf-8")
            search.append({"title": page["title"], "url": current.as_posix(), "section": SECTIONS.get(page["section"], "Documentation"), "text": page["text"]})
        index_body = f'''<div class="article-meta"><span>Documentation archive</span><a class="original-link" href="{START}" target="_blank" rel="noopener noreferrer">Original page ↗</a></div>
<h1>Camunda 8.5 documentation</h1><p class="index-description">Archived documentation for Camunda 8.5. Browse by section or search the full text locally.</p><nav class="section-list" aria-label="Documentation sections">'''
        descriptions = {
            "guides": "Tutorials and examples for building and running processes.",
            "components": "Modeler, Zeebe, Operate, Tasklist, Optimize, and Connectors.",
            "self-managed": "Install, configure, and operate your own Camunda cluster.",
            "apis-tools": "APIs, client libraries, command-line tools, and integrations.",
            "reference": "Supported environments, releases, and technical reference.",
            "tags": "Browse documentation grouped by topic.",
        }
        for key, url in SECTION_PAGES.items():
            if url not in self.pages:
                continue
            index_body += f'<div class="section-entry"><a href="{esc(page_file(url).as_posix())}">{esc(SECTIONS[key])}</a><p>{esc(descriptions[key])}</p></div>'
        index_body += '</nav><div class="directory"><h2>All pages</h2>'
        for key, label in SECTIONS.items():
            pages = sorted((p for p in self.pages.values() if p["section"] == key), key=lambda p: p["title"].casefold())
            if pages:
                index_body += f'<details id="section-{key}"><summary>{esc(label)}</summary><div class="directory-tree">'
                index_body += self.render_navigation(self.navigation_trees[key], Path("index.html"))
                index_body += '</div></details>'
        index_body += '</div>'
        (self.output / "index.html").write_text(self.layout("Documentation", Path("index.html"), index_body), encoding="utf-8")
        # A script instead of fetch(JSON) also supports opening index.html via file://.
        data = json.dumps(search, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        (self.output / "assets/search-index.js").write_text("window.CAMUNDA_SEARCH=" + data + ";", encoding="utf-8")
        report = {
            "source": START, "version": "8.5", "built_at": datetime.now(timezone.utc).isoformat(),
            "pages": len(search), "assets": len(self.asset_files),
            "published_routes": len(self.source_routes), "attempted_page_urls": len(self.attempted_urls),
            "missing_published_routes": sorted(self.source_routes - self.pages.keys()),
            "page_errors": self.failures, "asset_errors": self.asset_errors,
            "recovered_assets": self.asset_recoveries, "moved_pages": MOVED_PAGES,
            "navigation_fallbacks": self.navigation_fallbacks,
            "documents": [{"source": p["url"], "file": page_file(p["url"]).as_posix(), "title": p["title"]} for p in sorted(self.pages.values(), key=lambda p: p["url"]) if page_file(p["url"]) != Path("index.html")],
            "notes": ["External websites and embedded videos require internet.", "The archive preserves the published HTML, including all server-rendered tab panels; content fetched only by the original application may require the original page.", "Errors below record resources unavailable on the source site; their links remain pointed at the original URLs."],
        }
        (self.output / "archive-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (self.output / "navigation.json").write_text(json.dumps(self.navigation_trees, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Built {len(search)} documentation pages in {self.output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "site")
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache/downloads")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--refresh", action="store_true", help="Re-download cached source material")
    parser.add_argument("--limit", type=int, help="Limit the crawl for a development build")
    args = parser.parse_args()
    if not 1 <= args.workers <= 12:
        parser.error("--workers must be between 1 and 12")
    archive = Archive(args.output.resolve(), args.cache.resolve(), args.workers, args.refresh)
    archive.crawl(archive.discover(), args.limit)
    if START not in archive.pages:
        print("The starting page could not be archived.", file=sys.stderr)
        return 1
    archive.collect_assets()
    archive.build()
    return 1 if archive.failures or archive.asset_errors else 0


if __name__ == "__main__":
    sys.exit(main())
