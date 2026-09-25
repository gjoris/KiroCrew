"""Generator for the keyed-value fixture shared by the backend, the stream, the hard
URL floor, the packaging scan's vendored scanner and the chat mirror.

The value grammar of a key-anchored credential pair lives in ONE scanner
(``kiro_crew.security.scan_keyed_value``) and in two ports of it that cannot
import the canonical module: the packaging scan's standalone copy and the chat
mirror ``website/src/utils/sanitize.ts``. A port that drifts on a quote or escape
shape is a leak one surface has and another does not, which is exactly how four
consecutive review rounds found four real findings in the regex this scanner
replaced. So the rows here are generated from the canonical redactor over every
shape the scanner knows, written to ``test/fixtures/redaction_keyed_values.json``,
and consumed by ``test_redaction_keyed_value_fixture.py`` (pytest: the committed
file equals a fresh generation; every row holds for the redactor, the stream at
six chunk sizes, the hard floor and the vendored scanner) and by
``website/src/test/sanitizeCredentials.fixture.test.ts`` (vitest: the mirror's
output equals ``expected_mirror``). Regenerate with
``python -m test.redaction_keyed_value_fixture``.

Each row: ``text`` (the input), ``expected`` (``redact_credentials(text)[0]``),
``warnings`` (count), ``expected_mirror`` (the chat mirror's output: the backend
tag spelled ``[REDACTED]``, backend tags in the INPUT left as they are), ``live``
(whether a live labelled value stands in the text, as the hard floor and the
packaging scan must read it), ``shape`` and ``key``.
"""

from __future__ import annotations

import json
from pathlib import Path

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "redaction_keyed_values.json"

KEYS = (
    "aws_secret_access_key",
    "SecretAccessKey",
    "aws_session_token",
    "SessionToken",
    "aws_access_key_id",
    "AccessKeyId",
)

#: Values whose only credential shape is the label: short, lowercase-heavy, so no
#: entropy or encoded-chunk pass fires and every row isolates the keyed rule.
VALUE = "test-value-not-a-credential-0123"
SECOND = "second-value-not-a-credential-4567"
TAG = "[REDACTED: credential]"
ENC = "[REDACTED: encoded credential]"


def _shapes(key: str) -> list[tuple[str, str]]:
    v, w = VALUE, SECOND
    rows: list[tuple[str, str]] = [
        ("eq", f"{key}={v}\nnext: line\n"),
        ("colon", f"{key}: {v}\nnext: line\n"),
        ("json", json.dumps({key: v, "r": "x"}) + "\n"),
        ("json-compact", "{" + json.dumps(key) + ":" + json.dumps(v) + ',"r":"x"}'),
        ("dq", f'{key}="{v}"\nnext: line\n'),
        ("sq", f"{key}='{v}'\nnext: line\n"),
        ("dq-tail", f'{key}="{v} key, rotated"\nnext: line\n'),
        ("dq-doubled", f'{key}="{v}""{w}"\nnext: line\n'),
        ("sq-doubled", f"{key}='{v}''{w}'\nnext: line\n"),
        ("dq-escaped-interior", f'{key}="{v}\\"{w}" tail\n'),
        ("unterminated", f'{key}="{v} rest of the line\nnext: line\n'),
        ("unterminated-eof", f'"{key}": "{v} tail'),
        ("embedded", json.dumps({"text": f'{key}="{v}"'}) + "\n"),
        ("embedded-json", json.dumps({"text": f'"{key}": "{v}"', "r": "x"}) + "\n"),
        ("embedded-unterminated", json.dumps({"text": f'{key}="{v} tail'}) + "\n"),
        ("escaped-slash", f"{key}=\\/{v[:8]}\\/{v[8:]}\nnext: line\n"),
        ("escaped-slash-json", '{"' + key + '": "\\/' + v[:8] + "\\/" + v[8:] + '"}\n'),
        ("escaped-backslash", f"{key}={v[:8]}\\\\{v[8:]} tail\n"),
        ("unicode-escape", f'{key}="{v[:8]}\\u002f{v[8:]}" tail\n'),
        ("newline-head", '{"' + key + '": "\\n' + v + '"}\n'),
        ("tab-heads-9", f'{key}="' + "\\t" * 9 + v + '"\n'),
        ("tab-heads-unquoted", f"{key}=" + "\\n" * 3 + v + "\nnext: line\n"),
        ("embedded-newline-head", json.dumps({"text": f'{key}="\\n{v}"'}) + "\n"),
        # Raw whitespace after the opening quote is part of the quoted scalar.
        ("dq-leading-space", f'{key}=" {v}"\nnext: line\n'),
        ("sq-leading-space", f"{key}=' {v}'\nnext: line\n"),
        ("dq-leading-tab", f'{key}="\t{v}"\nnext: line\n'),
        ("dq-leading-several", f'{key}="  \t {v}"\nnext: line\n'),
        ("json-leading-space", json.dumps({key: f"  {v}", "r": "x"}) + "\n"),
        ("embedded-leading-space", json.dumps({"text": f'{key}=" {v}"'}) + "\n"),
        # The redactor's own output and its neighbours: fixed points and lookalikes.
        ("tag-filled", f"{key}={TAG}\nnext: line\n"),
        ("tag-filled-quoted", f'{key}="{TAG}" # note\n'),
        ("tag-run", f"{key}={TAG}{ENC}\n"),
        ("tag-filled-embedded", json.dumps({"text": f'{key}="{TAG}"'}) + "\n"),
        ("tag-glued", f"{key}={TAG}{v}\n"),
        ("tag-heading-quoted", f'{key}="{TAG} {v}"\n'),
        ("tag-doubled-close", f"{key}='{TAG}''{v}'\n"),
        ("tag-other-quote-close", f"{key}=\"{TAG}'{v}'\n"),
        ("tag-escaped-glued", f"{key}={TAG}\\/{v}\n"),
        ("tag-lowercase", f"{key}={TAG.lower()}\n"),
        ("tag-with-head", f'{key}="\\n{TAG}"\n'),
        ("empty-value", f"{key}=\nnext: line\n"),
        ("empty-quoted", f'{key}=""\nnext: line\n'),
    ]
    return rows


def _has_tag(text: str) -> bool:
    return TAG in text or ENC in text


def _mirror_expected(text: str) -> str:
    """What the chat mirror (``sanitize.ts``) writes: the same anchor-and-scanner
    walk, its own ``[REDACTED]`` for every live claim with the close written when
    the quote never closed, and a tag run filling its value left alone."""
    from kiro_crew.security.redaction import (
        _CREDENTIAL_PATTERNS,
        _keyed_value_of,
        _value_is_credential_tag,
    )

    out: list[str] = []
    cursor = 0
    for match in _CREDENTIAL_PATTERNS.finditer(text):
        value = _keyed_value_of(text, match)
        if value is None or match.start() < cursor or value.end <= value.start:
            continue
        if _value_is_credential_tag(text, value.start, value.end) and value.closes:
            continue
        out.append(text[cursor : value.start])
        out.append("[REDACTED]" + ("" if value.closes else value.opener))
        cursor = value.end
    out.append(text[cursor:])
    return "".join(out)


def build_rows() -> list[dict[str, object]]:
    from kiro_crew.security import credential_matches, redact_credentials

    rows: list[dict[str, object]] = []
    for key in KEYS:
        for shape, text in _shapes(key):
            expected, warnings = redact_credentials(text)
            live = next(credential_matches(text), None) is not None
            # Invariants every row must hold, or the fixture is not worth pinning.
            assert VALUE not in expected or shape in ("empty-value", "empty-quoted"), (
                shape,
                expected,
            )
            assert SECOND not in expected, (shape, expected)
            assert redact_credentials(expected) == (expected, []), (shape, expected)
            mirror = _mirror_expected(text)
            assert VALUE not in mirror or shape in ("empty-value", "empty-quoted"), (shape, mirror)
            # The mirror's answer is the backend's with the backend's tag spelled as
            # the mirror's, on every row where no backend tag stood in the input.
            if not _has_tag(text):
                assert mirror == expected.replace(TAG, "[REDACTED]"), (shape, mirror, expected)
            rows.append(
                {
                    "key": key,
                    "shape": shape,
                    "text": text,
                    "expected": expected,
                    "warnings": len(warnings),
                    "expected_mirror": mirror,
                    "live": live,
                }
            )
    return rows


def render() -> str:
    return json.dumps(build_rows(), indent=1, ensure_ascii=True) + "\n"


if __name__ == "__main__":
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(render(), encoding="utf-8")
    print(f"wrote {FIXTURE_PATH} ({len(build_rows())} rows)")
