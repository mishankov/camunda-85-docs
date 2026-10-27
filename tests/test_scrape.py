import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

from scripts.scrape import Archive, ORIGIN, START, canonical_page, page_file, sanitize_examples


class ScraperTests(unittest.TestCase):
    def test_slack_webhook_examples_are_replaced_in_text_and_links(self):
        url = 'https://hooks.slack.com/services/' + '/'.join(['T' + '0' * 8, 'B' + '0' * 8, 'example' * 4])
        safe = 'https://hooks.slack.com/services/WORKSPACE/CHANNEL/WEBHOOK_TOKEN'
        source = f'<a href="{url}">{url}</a>'
        self.assertEqual(sanitize_examples(source), f'<a href="{safe}">{safe}</a>')
        self.assertEqual(sanitize_examples(sanitize_examples(source)), sanitize_examples(source))

    def test_version_numbers_are_document_routes(self):
        route = "/8.5/docs/self-managed/optimize-deployment/migration-update/3.12_8.4-to-3.13_8.5/"
        self.assertEqual(canonical_page(route), ORIGIN + route)
        self.assertEqual(page_file(ORIGIN + route), Path("docs/self-managed/optimize-deployment/migration-update/3.12_8.4-to-3.13_8.5/index.html"))
        self.assertEqual(canonical_page("/8.5/docs/"), ORIGIN + "/8.5/")

    def test_scope_and_downloads(self):
        for value in ["https://example.com/8.5/docs/components/", "/8.4/docs/components/", "/8.5/assets/example.bpmn", "/8.5/docs/example.pdf"]:
            self.assertIsNone(canonical_page(value))
        self.assertEqual(canonical_page("https://docs.camunda.io/8.5/docs/components/#intro"), START)

    def test_repairs_unversioned_assets_and_trailing_slashes(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Archive(Path(temp), Path(temp) / "cache", 1)
            self.assertEqual(archive.asset_url("/img/icon.svg", START), ORIGIN + "/8.5/img/icon.svg")
            self.assertEqual(archive.asset_url("/8.5/assets/example.bpmn/", START), ORIGIN + "/8.5/assets/example.bpmn")
            self.assertIsNone(archive.asset_url("data:image/png;base64,abc", START))

    def test_minified_html_keeps_inactive_examples_and_correct_labels(self):
        source = b'''<title>Example</title><main><div class="theme-doc-markdown"><h1>Examples</h1>
        <div class="tabs-container"><ul role="tablist"><li role="tab">Java<li role="tab">Go</ul>
        <div role="tabpanel"><p>Java code</div><div role="tabpanel" hidden><p>Go code</div></div>
        <img src="/img/bpmn-elements/task-user.svg"><a href="/8.5/docs/components/">Components</a></div></main>'''
        with tempfile.TemporaryDirectory() as temp:
            archive = Archive(Path(temp), Path(temp) / "cache", 1)
            archive.fetch = lambda url: source
            page = archive.read_page(START)
            content = BeautifulSoup(page["content"], "html.parser")
            self.assertEqual([h.get_text() for h in content.select(".example-label")], ["Java", "Go"])
            self.assertFalse(content.select("[hidden], [role=tab], [role=tabpanel]"))
            self.assertIn("Java code", page["text"])
            self.assertIn("Go code", page["text"])
            self.assertEqual(content.img["alt"], "task user")

    def test_navigation_merges_source_categories_that_do_not_follow_url_paths(self):
        def snapshot(items):
            return BeautifulSoup(f'''<ul class="theme-doc-sidebar-menu"><li class="theme-doc-sidebar-item-category">
            <div><a class="menu__link" href="/8.5/docs/components/modeler/about-modeler/">Modeler</a></div>
            <ul><li class="theme-doc-sidebar-item-category"><div><a class="menu__link" href="/8.5/docs/components/modeler/bpmn/">BPMN</a></div>
            <ul><li class="theme-doc-sidebar-item-category"><div><a class="menu__link" href="/8.5/docs/components/modeler/bpmn/events/">Events</a></div>{items}</li></ul>
            </li></ul></li></ul>''', "html5lib")
        first = snapshot("")
        expanded = snapshot('''<ul><li><a class="menu__link" href="/8.5/docs/components/modeler/bpmn/none-events/">None events</a></li>
        <li><a class="menu__link" href="/8.5/docs/components/modeler/bpmn/escalation-events/">Escalation events</a></li></ul>''')
        tree = Archive.read_navigation(first, START)
        Archive.merge_navigation(tree, Archive.read_navigation(expanded, START))
        Archive.merge_navigation(tree, Archive.read_navigation(first, START))
        events = tree[0]["children"][0]["children"][0]
        self.assertEqual([node["label"] for node in events["children"]], ["None events", "Escalation events"])
        with tempfile.TemporaryDirectory() as temp:
            archive = Archive(Path(temp), Path(temp) / "cache", 1)
            for node in events["children"]:
                archive.pages[node["url"]] = {"title": node["label"]}
            current = events["children"][1]["url"]
            menu = BeautifulSoup(archive.render_navigation(tree, page_file(current), current), "html.parser")
            active = menu.select_one('a[aria-current="page"]')
            ancestors = [node.find("summary", recursive=False).get_text(" ", strip=True).rsplit(" ", 1)[0] for node in active.parents if node.name == "details"]
            self.assertEqual(ancestors, ["Events", "BPMN", "Modeler"])
            self.assertTrue(all(node.has_attr("open") for node in active.parents if node.name == "details"))

    def test_generated_api_pages_are_grouped_under_the_matching_api(self):
        tree = [{"label": "APIs", "url": None, "category": True, "children": [
            {"label": "Tasklist API (REST)", "url": ORIGIN + "/8.5/docs/apis-tools/tasklist-api-rest/tasklist-api-rest-overview/", "category": True, "children": []}
        ]}]
        page = {"title": "Task response", "url": ORIGIN + "/8.5/docs/apis-tools/tasklist-api-rest/schemas/responses/task-response/"}
        Archive.add_supplemental_navigation(tree, [page], "apis-tools")
        schemas = tree[0]["children"][0]["children"][0]
        self.assertEqual(schemas["label"], "Schemas")
        self.assertEqual(schemas["children"][0]["label"], "Responses")
        self.assertEqual(schemas["children"][0]["children"][0]["url"], page["url"])


if __name__ == "__main__":
    unittest.main()
