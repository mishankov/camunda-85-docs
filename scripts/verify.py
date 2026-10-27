#!/usr/bin/env python3
"""Verify the generated archive without making network requests."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup

SITE = Path(__file__).resolve().parents[1] / "site"
LOCAL_PATHS = set()
EXPECTED_SOURCES = {}


def inspect(path):
    soup = BeautifulSoup(path.read_text(), "html.parser")
    errors = []
    original = soup.select_one(".original-link[href^='https://unsupported.docs.camunda.io/8.5/']")
    if not original:
        errors.append(f"{path.relative_to(SITE)}: original-page link missing")
    elif path in EXPECTED_SOURCES and original["href"] != EXPECTED_SOURCES[path]:
        errors.append(f"{path.relative_to(SITE)}: original-page link points to the wrong article")
    if path in EXPECTED_SOURCES:
        active_sections = soup.select('.primary-nav a[aria-current="location"]')
        if len(active_sections) != 1:
            errors.append(f"{path.relative_to(SITE)}: missing or ambiguous current header section")
        else:
            section = urlsplit(EXPECTED_SOURCES[path]).path.split('/')[3]
            target = Path(os.path.abspath(path.parent / active_sections[0]['href'])).relative_to(SITE)
            if target.parts[:2] != ('docs', section):
                errors.append(f"{path.relative_to(SITE)}: wrong current header section")
        if not soup.select_one('.sidebar a[aria-current="page"]'):
            errors.append(f"{path.relative_to(SITE)}: current article missing from the sidebar")
    for element in soup.select("a[href],script[src],link[href],img[src],source[src],video[src],audio[src]"):
        value = element.get("href", element.get("src", ""))
        url = urlsplit(value)
        if url.scheme or url.netloc or not url.path:
            continue
        target = Path(os.path.abspath(path.parent / unquote(url.path)))
        if not target.is_relative_to(SITE):
            errors.append(f"{path.relative_to(SITE)}: escapes site: {value}")
        elif target not in LOCAL_PATHS:
            errors.append(f"{path.relative_to(SITE)}: missing local target: {value}")
    if soup.select('[role="tab"], [role="tablist"], [role="tabpanel"]'):
        errors.append(f"{path.relative_to(SITE)}: unconverted interactive tabs")
    for element in soup.select("img[src]"):
        url = urlsplit(element["src"])
        if not url.scheme and not element.has_attr("alt"):
            errors.append(f"{path.relative_to(SITE)}: image without alternative text")
    return errors


def main():
    report = json.loads((SITE / "archive-report.json").read_text())
    pages = sorted(SITE.rglob("*.html"))
    LOCAL_PATHS.update(SITE.rglob("*"))
    EXPECTED_SOURCES.update({SITE / document["file"]: document["source"] for document in report["documents"]})
    errors = []
    if report.get("missing_published_routes"):
        errors.extend(f"Missing published route: {url}" for url in report["missing_published_routes"])
    if len(pages) != report["pages"] + 1:
        errors.append("HTML file count differs from the archive report")
    navigation = json.loads((SITE / 'navigation.json').read_text())
    def urls(nodes):
        result = set()
        for node in nodes:
            if node['url']:
                result.add(node['url'])
            result.update(urls(node['children']))
        return result
    for section, tree in navigation.items():
        documents = {document['source'] for document in report['documents'] if urlsplit(document['source']).path.split('/')[3] == section}
        errors.extend(f"Missing from {section} navigation: {url}" for url in sorted(documents - urls(tree)))
    with ThreadPoolExecutor(max_workers=6) as executor:
        for result in executor.map(inspect, pages):
            errors.extend(result)
    for document in report["documents"]:
        path = SITE / document["file"]
        if not path.exists():
            errors.append(f"Missing reported page: {document['file']}")
            continue
    for error in errors[:50]:
        print(error)
    print(f"Checked {len(pages)} HTML files and {report['assets']} local assets: {len(errors)} errors.")
    print(f"Source availability: {len(report['page_errors'])} unreachable page URLs, {len(report['asset_errors'])} unavailable assets (recorded in archive-report.json).")
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
