#!/usr/bin/env python3
"""
Static wiring check for the web tracker.

There is no build step and no test runner, so this catches the mistakes that
are actually likely in a plain HTML/CSS/JS app:

  * app.js reaching for an element id that index.html does not define
  * a data-action / data-change attribute that no handler branch implements
  * a handler branch for an action nothing in the markup ever emits
  * a CSS class used in markup or JS that style.css never defines
  * unbalanced braces in the JS and CSS

Run from the repo root:

    python tools/check_wiring.py
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
        return handle.read()


def strip_interpolations(text):
    """Remove `${ ... }` template-literal expressions, honouring nested braces."""
    out = []
    i = 0
    length = len(text)
    while i < length:
        if text.startswith("${", i):
            depth = 1
            i += 2
            while i < length and depth > 0:
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                i += 1
            out.append(" ")
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def strip_js_comments_and_strings(source):
    """Rough strip so brace counting is not fooled by braces inside text."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"(?m)^\s*//.*$", "", source)
    return source


def main():
    html = read("index.html")
    js = read("app.js")
    css = read("style.css")
    sw = read("sw.js")

    failures = []
    warnings = []

    # ---- 1. Element ids ----------------------------------------------------
    html_ids = set(re.findall(r'\bid="([^"]+)"', html))
    # Direct lookups plus the thin wrappers around them (setText/setValue/valueOf).
    js_ids = set(re.findall(r'getElementById\(\s*"([^"]+)"\s*\)', js))
    js_ids |= set(re.findall(r'\b(?:setText|setValue|valueOf)\(\s*"([^"]+)"', js))

    # Ids that app.js creates at runtime rather than reading from the markup.
    runtime_id_prefixes = ("pillStat_", "pillPct_", "modalVal_", "modalStatus_")
    runtime_ids = {
        "modalCardImg", "modalTotalCopiesBadge", "modalConditionSelect", "modalLocationInput",
        "syncUrlInput",
    }

    missing = sorted(
        i for i in js_ids - html_ids
        if i not in runtime_ids and not i.startswith(runtime_id_prefixes)
    )
    if missing:
        failures.append(f"app.js reads element ids that index.html never defines: {missing}")

    # Ids in the markup that nothing references (harmless, but usually a typo)
    referenced = js_ids | set(re.findall(r'\bfor="([^"]+)"', html)) | set(re.findall(r'aria-controls="([^"]+)"', html))
    unused = sorted(i for i in html_ids - referenced)
    if unused:
        warnings.append(f"ids defined in index.html but never referenced: {unused}")

    # ---- 2. data-action / data-change round trip ---------------------------
    emitted_actions = set(re.findall(r'data-action="([a-z-]+)"', js)) | set(re.findall(r'data-action="([a-z-]+)"', html))
    emitted_changes = set(re.findall(r'data-change="([a-z-]+)"', js)) | set(re.findall(r'data-change="([a-z-]+)"', html))

    # Handler branches: the case labels inside runAction / handleDelegatedChange
    handled = set(re.findall(r'case "([a-z-]+)":', js))

    unhandled = sorted((emitted_actions | emitted_changes) - handled)
    if unhandled:
        failures.append(f"markup emits data-action/data-change values with no handler branch: {unhandled}")

    # Exclude the sort/filter case labels, which are values not actions.
    action_like = {a for a in handled if "-" in a or a in {"qty", "condition", "location", "serial"}}
    orphan_handlers = sorted(action_like - emitted_actions - emitted_changes)
    if orphan_handlers:
        warnings.append(f"handler branches for actions nothing emits: {orphan_handlers}")

    # ---- 3. CSS classes ----------------------------------------------------
    defined_classes = set(re.findall(r"\.([a-zA-Z][\w-]*)", css))

    # Remove `${ ... }` interpolations from the JS *before* pulling class
    # attributes out, otherwise a quote inside an interpolation truncates the
    # attribute match and leaks expression fragments into the class list.
    js_no_interp = strip_interpolations(js)

    used_classes = set()
    dynamic_prefixes = set()
    for chunk in re.findall(r'class="([^"]*)"', html) + re.findall(r'class="([^"]*)"', js_no_interp):
        for token in chunk.split():
            if not token:
                continue
            if token.endswith("-"):
                # e.g. `tag-rarity-${rarity}` -> a family of classes
                dynamic_prefixes.add(token)
                continue
            used_classes.add(token)
    # classList.toggle("x", ...) / classList.add("x")
    used_classes.update(re.findall(r'classList\.(?:add|toggle|remove)\(\s*"([\w-]+)"', js))

    undefined = sorted(c for c in used_classes - defined_classes if c)
    if undefined:
        failures.append(f"classes used in markup/JS but not defined in style.css: {undefined}")

    for prefix in sorted(dynamic_prefixes):
        if not any(c.startswith(prefix) and c != prefix for c in defined_classes):
            failures.append(f"dynamic class family '{prefix}*' has no matching rule in style.css")

    # ---- 4. Brace balance --------------------------------------------------
    gs = read(os.path.join("google-apps-script", "Code.gs"))

    # The website and the Apps Script must agree on the finish names, or a
    # quantity silently stops syncing.
    js_variant_keys = set(re.findall(r'key:\s*"(\w+)"', js))
    gs_variant_keys = set(re.findall(r"var VARIANT_KEYS = \[([^\]]*)\]", gs)[0].replace("'", "").replace(" ", "").split(",")) \
        if re.findall(r"var VARIANT_KEYS = \[([^\]]*)\]", gs) else set()
    missing_in_gs = sorted(js_variant_keys - gs_variant_keys)
    if missing_in_gs:
        failures.append(f"finishes in app.js that Code.gs will not sync: {missing_in_gs}")

    for name, source in (("app.js", js), ("sw.js", sw), ("Code.gs", gs)):
        clean = strip_js_comments_and_strings(source)
        if clean.count("{") != clean.count("}"):
            failures.append(f"{name}: unbalanced braces ({clean.count('{')} open, {clean.count('}')} close)")
        if clean.count("(") != clean.count(")"):
            warnings.append(f"{name}: paren count differs ({clean.count('(')} vs {clean.count(')')}) - check manually")

    if css.count("{") != css.count("}"):
        failures.append(f"style.css: unbalanced braces ({css.count('{')} open, {css.count('}')} close)")

    # ---- 5. Referenced files exist ----------------------------------------
    for path in re.findall(r'(?:src|href)="([^"#:]+)"', html):
        if path.startswith(("http", "//", "mailto")):
            continue
        if not os.path.exists(os.path.join(ROOT, path)):
            failures.append(f"index.html references a file that does not exist: {path}")

    for asset in re.findall(r'"((?:icons/|\./)?[\w./-]+\.(?:js|css|png|svg|webmanifest|html))"', sw):
        if asset in ("./",):
            continue
        if not os.path.exists(os.path.join(ROOT, asset)):
            failures.append(f"sw.js precaches a file that does not exist: {asset}")

    # ---- Report ------------------------------------------------------------
    print("=" * 70)
    print("WIRING CHECK")
    print("=" * 70)
    print(f"  index.html ids      : {len(html_ids)}")
    print(f"  ids read by app.js  : {len(js_ids)}")
    print(f"  delegated actions   : {len(emitted_actions | emitted_changes)}")
    print(f"  css classes defined : {len(defined_classes)}")
    print(f"  css classes used    : {len(used_classes)}")

    if warnings:
        print("\nWARNINGS")
        for item in warnings:
            print(f"  ! {item}")

    if failures:
        print("\nFAILURES")
        for item in failures:
            print(f"  X {item}")
        print("\nRESULT: FAILED")
        return 1

    print("\nRESULT: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
