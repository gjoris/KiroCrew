"""The keyed-value fixture is the one oracle every copy of the value scanner answers to.

``test/redaction_keyed_value_fixture.py`` generates it from the canonical redactor;
this file pins (1) that the committed JSON equals a fresh generation, so the file
cannot drift from the code, (2) that every row holds on the redactor, on the stream
at six chunk sizes, on the hard URL floor and on the packaging scan's vendored
scanner, and (3) that the scanner is linear in its input by construction. The
chat mirror reads the same file in
``website/src/test/sanitizeCredentials.fixture.test.ts``.
"""

from __future__ import annotations

import json
import time
from test.redaction_keyed_value_fixture import FIXTURE_PATH, TAG, VALUE, build_rows, render

import pytest

ROWS = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
_IDS = [f"{row['key']}-{row['shape']}" for row in ROWS]
_SIZES = (1, 3, 7, 50, 200, 513)


def test_the_committed_fixture_is_a_fresh_generation() -> None:
    """Regenerate with ``python -m test.redaction_keyed_value_fixture``."""
    assert FIXTURE_PATH.read_text(encoding="utf-8") == render()
    assert len(build_rows()) == len(ROWS) > 150


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_redactor_answers_the_row(row: dict) -> None:
    from kiro_crew.security import credential_matches, redact_credentials

    once, warnings = redact_credentials(row["text"])
    assert once == row["expected"], row["shape"]
    assert len(warnings) == row["warnings"], row["shape"]
    assert redact_credentials(once) == (once, []), row["shape"]
    assert (next(credential_matches(row["text"]), None) is not None) is row["live"], row["shape"]


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_stream_equals_the_batch_pass_at_every_chunk_size(row: dict) -> None:
    from kiro_crew.security import StreamRedactor

    text, expected = row["text"], row["expected"]
    for size in _SIZES:
        redactor = StreamRedactor()
        out = "".join(redactor.feed(text[i : i + size]) for i in range(0, len(text), size))
        assert out + redactor.flush() == expected, (row["shape"], size)


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_hard_floor_reads_the_row_as_the_redactor_does(row: dict) -> None:
    from kiro_crew.security import hard_credential_hit

    assert hard_credential_hit(row["text"]) is row["live"], row["shape"]
    assert hard_credential_hit(row["expected"]) is False, row["shape"]


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_packaging_scans_vendored_scanner_reads_the_row_as_the_redactor_does(
    row: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiro_crew.apps.builtins.aws_control.crew.packaging.pipeline import scan as pkg_scan

    # The labelled matcher alone (the canonical detector and redactor masked off),
    # line by line as the scan runs it; access-key-id spellings have no labelled
    # entry in the packaging scan, which reads secrets and session tokens.
    if "access_key_id" in row["key"].lower() or row["key"] == "AccessKeyId":
        pytest.skip("the packaging scan's labelled entry covers secrets and session tokens")
    matcher = dict(pkg_scan._HARD_PATTERNS)["aws-secret-labelled"]
    found = any(matcher.search(line) is not None for line in row["text"].splitlines())
    if row["shape"] == "empty-value":
        # The redactor's anchor runs `\s*` across the line break after `key=`
        # and claims the next line's first word (the base-era rule, an
        # over-redaction and never a leak); the packaging scan reads one line
        # at a time, where `key=` alone is a key with no value.
        assert found is False, row["shape"]
    else:
        assert found is row["live"], row["shape"]
    assert all(matcher.search(line) is None for line in row["expected"].splitlines()), row["shape"]
    # And the vendored claim is byte-identical to the canonical one on every line.
    from kiro_crew.security import scan_keyed_value

    for line in row["text"].splitlines():
        for anchor in pkg_scan._LABEL_RE.finditer(line):
            vendored = pkg_scan._scan_value(line, anchor.end())
            canonical = scan_keyed_value(line, anchor.end())
            assert vendored == (
                canonical.start,
                canonical.end,
                canonical.closes,
                canonical.opener,
            ), (
                row["shape"],
                line,
            )


def test_the_scanner_is_linear_in_its_input() -> None:
    """One token per step: the time to scan grows with the text, not with its square.

    Adversarial shapes for a backtracking grammar -- a run of backslashes, a run of
    doubled quotes, a run of escaped-whitespace heads, an unterminated quote over a
    long line -- cost the same per byte as prose. Measured at two sizes a factor of
    eight apart; a quadratic scanner would show ~64x, a linear one ~8x (the bound
    below leaves room for timer noise, as ``test_security_regex_linearity.py`` does).
    """
    from kiro_crew.security import scan_keyed_value

    def shapes(n: int) -> list[str]:
        return [
            "k=" + "\\\\" * n,
            'k="' + '""' * n + "x",
            'k="' + "\\t" * n + VALUE + '"',
            'k="' + "a" * n,
            'k=\\"' + "\\\\" * n + '\\"',
            "k=" + (TAG * (n // len(TAG) + 1)),
        ]

    def cost(n: int) -> float:
        best = float("inf")
        for _ in range(3):
            t0 = time.perf_counter()
            for text in shapes(n):
                scan_keyed_value(text, 2)
            best = min(best, time.perf_counter() - t0)
        return best

    small, large = cost(2_000), cost(16_000)
    assert large < small * 24, (small, large)
