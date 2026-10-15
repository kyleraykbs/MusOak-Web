"""One Firefox session: the waits, the network table, what is playing, and what
the page complained about.

Two rules the whole suite rests on:

* no test synchronises with a sleep. Every wait is a predicate with a deadline
  and a message that says what was expected and what was there instead, so a
  failure reads like a sentence rather than a timeout;
* an error collector that captures nothing must not look like success. The
  suite has a self-check (tests/test_browser_selfcheck.py) that provokes a
  console error and a JavaScript error and asserts both were seen.
"""

from __future__ import annotations

import json
import os
import time

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

#: Firefox prefs the suite depends on, with the reason each one is here.
PREFERENCES = {
    # A browser that refuses play() because nobody has clicked would fail every
    # playback assertion for a reason that has nothing to do with the app.
    "media.autoplay.default": 0,
    "media.autoplay.blocking_policy": 0,
    # Silent to the machine it runs on: the suite measures a clock, not a
    # speaker, and a box with no sound card must still advance it.
    "media.volume_scale": "0.0",
    # The service worker is part of what is being tested.
    "dom.serviceWorkers.enabled": True,
    # Firefox's console output on stdout, which the driver log captures: the
    # fallback for a session whose BiDi is not available.
    "devtools.console.stdout.content": True,
    # No network reachability chatter, no safe browsing lookups, no telemetry:
    # a test run should not depend on, or disturb, the internet.
    "network.captive-portal-service.enabled": False,
    "browser.safebrowsing.malware.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore",
}


#: One helper the readers share, so every selector may be a CSS selector or an
#: XPath. XPath is sometimes the only honest way to name a control ("the
#: dialog's own Sign in", not the card's); it is recognised by an explicit
#: `xpath:` prefix or by starting with `/`, because a suite author who writes
#: `//button` and gets "not a valid selector" has been failed by the harness.
FIND_JS = """
const __xpath = (sel) => sel.slice(0, 6) === 'xpath:' ? sel.slice(6) : (sel.slice(0, 1) === '/' ? sel : null);
const __find = (sel) => {
  const path = __xpath(sel);
  if (path !== null) {
    const result = document.evaluate(path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out = [];
    for (let i = 0; i < result.snapshotLength; i += 1) out.push(result.snapshotItem(i));
    return out;
  }
  return [...document.querySelectorAll(sel)];
};
"""


def xpath_of(selector):
    """The XPath inside a selector spelled either way."""
    if selector.startswith("xpath:"):
        return selector[len("xpath:"):]
    return selector


def by(selector):
    """A Selenium locator for a CSS selector or an XPath (either spelling)."""
    if selector.startswith("xpath:"):
        return By.XPATH, selector[len("xpath:"):]
    if selector.startswith("/"):
        return By.XPATH, selector
    return By.CSS_SELECTOR, selector


class WaitTimeout(AssertionError):
    """A wait ran out. An AssertionError, because that is what it is."""


class Ui:
    """One browser session, which the suite treats as one person."""

    def __init__(self, driver, base_url, artifacts_dir, name="ui", driver_log=None):
        self.driver = driver
        self.base = base_url.rstrip("/")
        self.artifacts = artifacts_dir
        self.name = name
        self._errors = []
        self._log_entries = []
        self._log_path = driver_log
        self._log_read = 0
        self._console_available = False
        self._install_console_capture()

    # --- console ------------------------------------------------------------

    def _install_console_capture(self):
        """Collect console errors through BiDi and JS errors from Firefox's log.

        Selenium 4.40's typed `add_javascript_error_handler` raises
        `KeyError('stackTrace')` on Firefox events that legitimately omit that
        field, inside its websocket callback thread. That is both noisy and a
        way to lose an error. The console handler is safe for console entries;
        JavaScript errors are read from Firefox's own driver log in
        `_read_log`, which is why the two collectors are deliberately split.
        """
        try:
            self.driver.script.add_console_message_handler(self._on_console)
            self._console_available = True
        except Exception:  # noqa: BLE001 - a session without BiDi still logs
            self._console_available = False

    def _on_console(self, entry):
        level = getattr(entry, "level", "") or ""
        text = getattr(entry, "text", "") or str(entry)
        if str(level).lower() in {"error", "severe"}:
            self._errors.append({"kind": "console", "level": str(level), "text": text, "source": "bidi"})

    def console_available(self):
        return self._console_available or bool(self._log_path)

    def _read_log(self):
        """Errors Firefox's own console wrote to the driver log.

        A second collector on purpose. Selenium's typed parse of BiDi's
        `log.entryAdded` raises on an event that carries no stack trace
        (`JavaScriptLogEntry.from_json` wants `stackTrace`), and that raise
        happens in the socket callback thread where nothing can catch it - so an
        entry can be dropped while `errors()` stays empty and a test passes. The
        log is written by Firefox itself, and `devtools.console.stdout.content`
        is on so its console output lands there.
        """
        if not self._log_path or not os.path.exists(self._log_path):
            return
        try:
            with open(self._log_path, errors="replace") as handle:
                handle.seek(self._log_read)
                text = handle.read()
                self._log_read = handle.tell()
        except OSError:
            return
        for line in text.splitlines():
            entry = None
            if "console.error:" in line:
                entry = {
                    "kind": "console", "level": "error", "source": "log",
                    "text": line.split("console.error:", 1)[1].strip(),
                }
            elif "JavaScript error:" in line and "resource://" not in line and "chrome://" not in line:
                # Firefox's browser internals and extensions log their own
                # errors here; only the page's are the page's.
                entry = {
                    "kind": "javascript", "level": "error", "source": "log",
                    "text": line.split("JavaScript error:", 1)[1].strip(),
                }
            if entry and entry not in self._log_entries:
                self._log_entries.append(entry)

    def has_from(self, source):
        """Whether a given collector has seen anything: "bidi" or "log"."""
        self._read_log()
        return any(entry.get("source") == source for entry in [*self._errors, *self._log_entries])

    def errors(self):
        """Every error seen, from either collector, without duplicates."""
        self._read_log()
        seen = []
        for entry in [*self._errors, *self._log_entries]:
            if entry not in seen:
                seen.append(entry)
        return seen

    def clear_errors(self):
        self._errors.clear()
        self._log_entries.clear()
        self._read_log()

    def assert_no_errors(self, context="the page"):
        if self._errors:
            lines = "\n".join(f"  [{entry['kind']}] {entry['text']}" for entry in self._errors)
            raise AssertionError(f"{context} reported errors:\n{lines}")
        if not self._console_available:
            raise AssertionError(
                "console capture is not available in this session, so 'no errors' cannot be "
                "asserted. Run tests/test_browser_selfcheck.py to see which mechanism is missing."
            )

    # --- navigation and waits ----------------------------------------------

    def goto(self, path="/", wait_shell=True):
        self.driver.get(self.base + path)
        if wait_shell:
            self.wait_shell()
        return self

    def wait(self, check, message, timeout=15.0, interval=0.05):
        """Poll a callable until it returns something truthy, or fail loudly."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                last = check()
            except WebDriverException:
                last = None
            if last:
                return last
            time.sleep(interval)
        raise WaitTimeout(f"{message}\n  after {timeout:.1f}s: {self.describe()}\n{self._dump_last(last)}")

    def wait_js(self, script, message, timeout=15.0):
        """Wait for an expression to become true.

        Coerced to a boolean on the page: an expression that answers with an
        object ("window.__e2e && window.__e2e.player") would otherwise come back
        as something the driver cannot serialise, and the wait would time out
        while the condition was true.
        """
        return self.wait(lambda: self.js("return !!(" + script + ");"), message, timeout)

    def reload(self, timeout=20.0):
        """Reload the page the way a person does: `location.reload()`.

        Not `driver.refresh()`: measured, geckodriver's refresh is a *hard*
        reload - the service worker is not controlling the new document and
        every byte comes off the wire again (298 KB against a warm reload's
        1.8 KB). A caching test written against `refresh()` reports a cache
        defect that does not exist.
        """
        self.driver.execute_script("location.reload();")
        time.sleep(0.15)  # let the navigation start before the next command
        return self.wait_shell(timeout)

    def wait_shell(self, timeout=20.0):
        """The app is up: the tab strip is drawn and the player bar exists."""
        self.wait(
            lambda: self.count("nav .nav-item") >= 5 and self.has(".player-bar"),
            "the app shell (tab strip and player bar) did not appear",
            timeout,
        )
        return self

    def wait_css(self, css, message=None, timeout=15.0):
        return self.wait(lambda: self.has(css), message or f"{css} never appeared", timeout)

    def wait_gone(self, css, message=None, timeout=15.0):
        return self.wait(lambda: not self.has(css), message or f"{css} never went away", timeout)

    def wait_text(self, css, text=None, message=None, timeout=15.0):
        if text is None:
            return self.wait(lambda: self.text(css), message or f"{css} stayed empty", timeout)
        return self.wait(
            lambda: text in (self.text(css) or ""),
            message or f"{css} never contained {text!r} (it said {self.text(css)!r})",
            timeout,
        )

    def wait_quiet(self, quiet_for=0.6, timeout=20.0):
        """Wait until the page has stopped asking the network for anything.

        The app's boot (config, session, restore playback, warm the queue ahead)
        is a burst of requests with no single end, and acting in the middle of
        it races work the app is already doing. Quiet is the only honest signal,
        and it is a measurement, not a sleep: the count has to *stay* still.
        """
        deadline = time.monotonic() + timeout
        last_count = -1
        quiet_since = None
        while time.monotonic() < deadline:
            count = self.mark()
            if count == last_count:
                quiet_since = quiet_since or time.monotonic()
                if time.monotonic() - quiet_since >= quiet_for:
                    return count
            else:
                quiet_since = None
            last_count = count
            time.sleep(0.05)
        raise WaitTimeout(
            f"the page never went quiet for {quiet_for}s (still at {last_count} requests)\n  {self.describe()}"
        )

    def wait_player(self, check, message, timeout=20.0):
        """Wait on a condition of the audio element, expressed over its fields."""
        return self.wait(lambda: check(self.player()), message, timeout)

    # --- reads --------------------------------------------------------------

    def js(self, script, *args):
        return self.driver.execute_script(script, *args)

    def js_async(self, script, *args):
        """Run a script that finishes asynchronously, and wait for it.

        `execute_script` answers a returned promise with an opaque object rather
        than waiting for it, so anything that has to *finish* - a module import,
        a fetch - goes through the async form. A rejection comes back as a
        WebDriverException carrying the page's own message, which is the
        difference between "the module never loaded" and knowing why.
        """
        # An async function body, so a script may use `await`; `arguments` inside it
        # are the same arguments the caller passed.
        wrapped = (
            "const done = arguments[arguments.length - 1];"
            "const args = Array.prototype.slice.call(arguments, 0, arguments.length - 1);"
            "const run = async function () {" + script + "};"
            "Promise.resolve(run.apply(null, args))"
            ".then((value) => done({ ok: true, value: value === undefined ? null : value }))"
            ".catch((error) => done({ ok: false, error: String((error && error.message) || error) }));"
        )
        result = self.driver.execute_async_script(wrapped, *args)
        if not result or not result.get("ok"):
            raise AssertionError(f"the page's script failed: {(result or {}).get('error')}\n  script: {script[:200]}")
        return result["value"]

    def import_module(self, path):
        """Load one of the app's modules on the page, and say why if it fails."""
        return self.js_async(
            "return import(arguments[0]).then((module) => ({"
            "  keys: Object.keys(module),"
            "  has: Object.prototype.hasOwnProperty.call(module, arguments[1])"
            "}));",
            path,
            path.rsplit("/", 1)[-1].replace(".js", ""),
        )

    def has(self, selector):
        return self.js(FIND_JS + "return __find(arguments[0]).length > 0;", selector)

    def count(self, selector):
        return self.js(FIND_JS + "return __find(arguments[0]).length;", selector)

    def text(self, selector):
        return self.js(
            FIND_JS + "const el = __find(arguments[0])[0];"
            "return el ? (el.textContent || '').trim() : '';",
            selector,
        )

    def texts(self, selector):
        return self.js(
            FIND_JS + "return __find(arguments[0]).map((el) => (el.textContent || '').trim());",
            selector,
        )

    def attr(self, selector, name):
        return self.js(
            FIND_JS + "const el = __find(arguments[0])[0];"
            "return el ? el.getAttribute(arguments[1]) : null;",
            selector,
            name,
        )

    def describe(self):
        try:
            return f"at {self.driver.current_url}"
        except WebDriverException:
            return "at an unknown url"

    def _dump_last(self, last):
        return f"  last reading: {last!r}"

    # --- actions ------------------------------------------------------------

    def click(self, selector, timeout=15.0):
        element = self.wait(lambda: self._find_clickable(selector), f"{selector} was never clickable", timeout)
        element.click()
        return self

    def _find_clickable(self, selector):
        locator = by(selector)
        try:
            element = self.driver.find_element(*locator)
        except WebDriverException:
            return None
        if element.is_displayed() and element.is_enabled():
            return element
        return None

    def click_text(self, text, css="button", timeout=15.0):
        """Click a control by the words on it, which is what a person reads."""
        return self._click_xpath(f"//{css}[normalize-space(.)={json.dumps(text)}]", text, timeout)

    def _click_xpath(self, xpath, text, timeout):
        path = xpath_of(xpath)
        element = self.wait(
            lambda: next(
                (el for el in self.driver.find_elements(By.XPATH, path) if el.is_displayed() and el.is_enabled()),
                None,
            ),
            f"no visible {text!r} control appeared",
            timeout,
        )
        element.click()
        return self

    def click_xpath(self, xpath, label=None, timeout=15.0):
        """Click by an explicit XPath, when two controls share the same words."""
        return self._click_xpath(xpath, label or xpath, timeout)

    def wait_xpath(self, xpath, label=None, timeout=15.0):
        path = xpath_of(xpath)
        return self.wait(
            lambda: next(
                (el for el in self.driver.find_elements(By.XPATH, path) if el.is_displayed()),
                None,
            ),
            f"{label or xpath} never appeared",
            timeout,
        )

    def click_tab(self, title, timeout=15.0):
        """Click a tab in the strip by its label, which is what a person reads."""
        self._click_xpath(
            f"//nav//button[contains(@class,'nav-item')][.//span[normalize-space(.)={json.dumps(title)}]]",
            title,
            timeout,
        )
        return self

    def type(self, selector, value, timeout=15.0):
        element = self.wait(lambda: self._find_clickable(selector), f"{selector} was never typeable", timeout)
        element.clear()
        element.send_keys(value)
        return self

    def send_file(self, selector, path, timeout=15.0):
        """Hand a file to an <input type=file>, hidden or not.

        The upload view keeps its input hidden and opens it from a button, and a
        real browser lets a script set the file on an input it cannot see, so
        the suite uses the input the page itself uses.
        """
        element = self.wait(
            lambda: self._present(selector),
            f"{selector} never appeared",
            timeout,
        )
        self.js(
            FIND_JS + "const el = __find(arguments[0])[0];"
            "if (el) { el.style.display = ''; el.style.opacity = '1'; el.style.position = 'static'; }",
            selector,
        )
        element.send_keys(path)
        return self

    def _present(self, selector):
        locator = by(selector)
        try:
            return self.driver.find_element(*locator)
        except WebDriverException:
            return None

    def key(self, sequence, target="body"):
        from selenium.webdriver.common.keys import Keys

        element = self.driver.find_element(By.CSS_SELECTOR, target)
        element.send_keys(getattr(Keys, sequence.upper(), sequence))
        return self

    # --- the player ---------------------------------------------------------

    def player(self):
        """What the browser is actually playing.

        Read from the media element itself rather than from the bar's label: a
        bar that says "playing" while the element sits at zero is the bug this
        suite exists to catch. The element in hand is the one the app names
        `data-e2e=audio`; the spare it hands over to and from is named
        `audio-spare`, and both are listed so a mismatch is visible rather than
        mysterious.
        """
        return self.js(
            "const read = (el) => el ? {src: el.currentSrc || el.src || '',"
            "  currentTime: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : 0,"
            "  paused: el.paused, ended: el.ended, readyState: el.readyState,"
            "  muted: el.muted, volume: el.volume, name: el.dataset ? el.dataset.e2e || '' : ''} : null;"
            "const all = [...document.querySelectorAll('audio')];"
            "const withSrc = all.filter((el) => el.src);"
            "const live = withSrc.find((el) => !el.paused);"
            "const furthest = withSrc.slice().sort((a, b) => b.currentTime - a.currentTime)[0];"
            "const hand = all.find((el) => el.dataset && el.dataset.e2e === 'audio');"
            "const state = read(live || furthest || hand || all[0] || null);"
            "if (state) state.elements = all.map(read);"
            "return state;"
        )

    def now_playing(self):
        return self.text(".player-bar .title")

    def play_button_says(self):
        """The transport button's own label: "Play" or "Pause".

        Named by its class, not by `button[title]`: the bar's first titled
        button is the source pill, and reading that would answer "Choose where
        this song comes from" to a question about playback.
        """
        return self.attr(".player-bar button.play", "title")

    def transport(self):
        """The bar's transport state as the buttons describe it."""
        return self.js(
            "const bar = document.querySelector('.player-bar');"
            "if (!bar) return null;"
            "const byTitle = (t) => bar.querySelector(`button[title=\"${t}\"]`);"
            "return {playing: !!byTitle('Pause'), paused: !!byTitle('Play'),"
            "        disabledSeek: (() => { const s = bar.querySelector('input[type=range]'); return s ? s.disabled : null; })()};"
        )

    # --- the network --------------------------------------------------------

    def mark(self):
        """A point in the resource timeline to measure from.

        **A mark is an index into the current document's timeline and does not
        survive a navigation.** After a reload the new document's table starts
        at 0, so a mark taken before it means "past the end"; `resources()`
        refuses that rather than answering "no requests", which is how a test
        about a reload ends up asserting nothing at all.
        """
        return self.js("return performance.getEntriesByType('resource').length;")

    def resources(self, since=0):
        """Resource Timing entries, as a list of dicts, from `since` on."""
        entries = self.js(
            "return performance.getEntriesByType('resource').map((e) => ({"
            "  name: e.name, type: e.initiatorType, start: e.startTime, duration: e.duration,"
            "  transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize,"
            "  status: e.responseStatus || 0"
            "}));"
        )
        if since > len(entries):
            raise AssertionError(
                f"resources(since={since}) but this document has only {len(entries)} entries: a mark "
                "does not survive a navigation, and slicing past the end would look like 'no requests'. "
                "Count the new document from 0."
            )
        return entries[since:]

    def requests_matching(self, pattern, since=0):
        import re

        rx = re.compile(pattern)
        return [entry for entry in self.resources(since) if rx.search(entry["name"])]

    def transferred(self, since=0):
        return sum(entry["transfer"] or 0 for entry in self.resources(since))

    def statuses(self, since=0):
        counted = {}
        for entry in self.resources(since):
            counted[entry["status"]] = counted.get(entry["status"], 0) + 1
        return counted

    def storage(self):
        """What this session remembers: the token and member id it signs with."""
        return self.js("return JSON.parse(localStorage.getItem('musoak-web') || 'null');")

    def token(self):
        stored = self.storage() or {}
        for session in (stored.get("sessions") or {}).values():
            if session.get("token"):
                return session["token"]
        return ""

    def member_id(self):
        stored = self.storage() or {}
        for session in (stored.get("sessions") or {}).values():
            if session.get("memberId"):
                return session["memberId"]
        return ""

    # --- artifacts ----------------------------------------------------------

    def screenshot(self, name):
        os.makedirs(self.artifacts, exist_ok=True)
        path = os.path.join(self.artifacts, f"{self.name}-{name}.png")
        try:
            self.driver.save_screenshot(path)
        except WebDriverException:
            return None
        return path

    def dump(self, name):
        """Everything a person needs to understand a failure, written down."""
        os.makedirs(self.artifacts, exist_ok=True)
        written = []
        try:
            written.append(self.screenshot(name))
        except Exception:  # noqa: BLE001
            pass
        try:
            with open(os.path.join(self.artifacts, f"{self.name}-{name}.html"), "w", encoding="utf-8") as handle:
                handle.write(self.driver.page_source)
        except Exception:  # noqa: BLE001
            pass
        report = {
            "url": self.describe(),
            "console": self._errors,
            "player": self.player(),
            "now_playing": self.now_playing(),
            "resources": self.resources(),
        }
        path = os.path.join(self.artifacts, f"{self.name}-{name}.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        written.append(path)
        return [entry for entry in written if entry]


def open_ui(base_url, artifacts, name="ui", headless=True, downloads=None):
    """A Firefox session with the prefs the suite needs, and a driver log kept."""
    options = Options()
    if headless:
        options.add_argument("-headless")
    for name_, value in PREFERENCES.items():
        options.set_preference(name_, value)
    if downloads:
        options.set_preference("browser.download.dir", downloads)
        options.set_preference("browser.download.folderList", 2)
    # BiDi is how console errors are collected; a session without it degrades to
    # the driver log, and the self-check makes that visible instead of quiet.
    options.set_capability("webSocketUrl", True)

    os.makedirs(artifacts, exist_ok=True)
    driver_log = os.path.join(artifacts, f"{name}-geckodriver.log")
    service = Service(log_output=driver_log, service_args=["--log", "debug"])
    driver = webdriver.Firefox(service=service, options=options)
    driver.set_window_size(1440, 1000)
    return Ui(driver, base_url, artifacts, name=name, driver_log=driver_log)