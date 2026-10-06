from __future__ import annotations

from unittest import mock

from kiro_crew.task_executor import _error_fingerprint


class TestErrorFingerprint:
    def test_volatile_runs_match(self) -> None:
        first = "Connection reset by peer (port 51234) after 120s pid 9912"
        second = "Connection reset by peer (port 51235) after 121s pid 9940"
        assert _error_fingerprint(first) == _error_fingerprint(second)

    def test_distinct_failures_differ(self) -> None:
        assert _error_fingerprint("No module named foo") != _error_fingerprint(
            "No module named bar"
        )

    def test_distinct_errors_differ_only_by_number(self) -> None:
        """Bare digits are identity, not noise.

        Masking every digit run made a steadily-advancing agent look stuck:
        ``error variant 1`` and ``error variant 2`` are different work, and on
        the third attempt the fingerprint replaced the real error with
        "Loop detected". Pinned by
        ``test/test_scenarios_v2_logic.py::TestScenarioCycleDetection::
        test_different_errors_no_cycle``.
        """
        assert _error_fingerprint("error variant 1") != _error_fingerprint("error variant 2")

    def test_distinct_assertion_values_differ(self) -> None:
        assert _error_fingerprint("assert 3 == 0") != _error_fingerprint("assert 1 == 0")

    def test_test_output_truncates_to_identity(self) -> None:
        """The failing-test identity survives ``run_tests``' tail truncation.

        ``run_tests`` trims a failing run to its last 2000 chars, so the
        ``FAILED`` summary is the stable part rather than the head of the text.
        """
        summary = "FAILED test/test_x.py::test_y - assert 1 == 2"
        first = "Tests failed:\n" + "x" * 5000 + "\n" + summary + "\nticks: 12\n"
        second = "Tests failed:\n" + "x" * 5000 + "\n" + summary + "\nticks: 13\n"
        assert _error_fingerprint(first) == _error_fingerprint(second)

    def test_different_tests_differ(self) -> None:
        first = "Tests failed:\nFAILED test/test_x.py::test_y - assert 1 == 2"
        second = "Tests failed:\nFAILED test/test_x.py::test_z - assert 1 == 2"
        assert _error_fingerprint(first) != _error_fingerprint(second)

    def test_fingerprint_is_bounded(self) -> None:
        assert len(_error_fingerprint("E" * 100_000)) <= 1000

    def test_long_summaries_differing_past_the_bound_differ(self) -> None:
        shared = "Tests failed:\n" + "\n".join(
            f"FAILED test/test_a.py::test_{i} - boom" for i in range(40)
        )
        first = shared + "\nFAILED test/test_b.py::test_x - boom"
        second = shared + "\nFAILED test/test_b.py::test_y - boom"
        assert len(shared) > 1000
        assert _error_fingerprint(first) != _error_fingerprint(second)
        assert _error_fingerprint(first) == _error_fingerprint(first + "\nticks: 7\n")

    def test_generic_error_with_error_log_lines_keeps_its_identity(self) -> None:
        first = "RuntimeError: db locked\nERROR    root: retrying\nERROR    root: giving up"
        second = "ValueError: bad config\nERROR    root: retrying\nERROR    root: giving up"
        assert _error_fingerprint(first) != _error_fingerprint(second)

    def test_short_hex_parametrized_cases_differ(self) -> None:
        first = "Tests failed:\nFAILED test/test_x.py::test_y[0x1] - boom"
        second = "Tests failed:\nFAILED test/test_x.py::test_y[0x2] - boom"
        assert _error_fingerprint(first) != _error_fingerprint(second)
        addr_a = "Tests failed:\nFAILED test/test_x.py::test_y - <Obj at 0x7f3a9c0012d0>"
        addr_b = "Tests failed:\nFAILED test/test_x.py::test_y - <Obj at 0x7f3a9c00ffe0>"
        assert _error_fingerprint(addr_a) == _error_fingerprint(addr_b)

    def test_separator_and_timezone_forms_are_volatile(self) -> None:
        first = "bind failed port: 51234 pid=9912 at 2026-09-29T05:00:00Z"
        second = "bind failed port: 51299 pid=9001 at 2026-09-29T05:03:11Z"
        assert _error_fingerprint(first) == _error_fingerprint(second)

    def test_time_unit_node_id_params_are_identity(self) -> None:
        """A parametrized run advancing through time-unit ids is not a loop.

        ``pytest -x`` steps through ``[1s]``, ``[2s]``, ``[30m]`` -- each a
        different case. The duration mask would collapse those bracketed node
        ids to one fingerprint, so on the third failure ``_check_error_loop``
        would overwrite the real error with "Loop detected" and fail the step.
        Bracketed node-id params are lifted out before masking, so they stay
        distinct; this repo's own suite uses such ids (e.g. ``[20s]``,
        ``[99999h]`` in ``test/test_instances.py``).
        """
        a = "Tests failed:\nFAILED test/test_x.py::test_y[1s] - boom"
        b = "Tests failed:\nFAILED test/test_x.py::test_y[2s] - boom"
        c = "Tests failed:\nFAILED test/test_x.py::test_y[30m] - boom"
        assert _error_fingerprint(a) != _error_fingerprint(b)
        assert _error_fingerprint(b) != _error_fingerprint(c)

    def test_volatile_forms_outside_node_ids_still_mask(self) -> None:
        """Protecting node ids must not stop masking volatile text elsewhere."""
        first = "Tests failed:\nFAILED test/test_x.py::test_y[cold] - timed out after 120s"
        second = "Tests failed:\nFAILED test/test_x.py::test_y[cold] - timed out after 121s"
        assert _error_fingerprint(first) == _error_fingerprint(second)

    def test_many_bracket_spans_restore_in_a_single_pass(self) -> None:
        """Restore maps every lifted span back in ONE regex pass, not per span.

        A per-span ``str.replace`` is quadratic -- it rescans the whole text
        once per protected span -- so a single long error line (many bracketed
        spans over a long body) can run long enough on the event loop for the
        watchdog to kill the gateway. The guard is structural, not a wall-clock
        bound (which flakes under ``-n auto`` runner load): ``_PLACEHOLDER_RE.sub``
        is called exactly once no matter how many spans were lifted, and the
        many-bracket input still round-trips to a correct, bounded fingerprint.
        """
        import kiro_crew.task_executor as te

        # Short enough that the fingerprint is returned verbatim (not hashed to a
        # digest past _ERROR_FINGERPRINT_LEN), so the round-trip is observable.
        many = "fail " + "[a][b][c][d][e][f][g][h]"

        class _CountingPattern:
            """Proxy that forwards to the real compiled pattern and counts ``sub``."""

            def __init__(self, real: "object") -> None:
                self._real = real
                self.sub_calls = 0

            def sub(self, repl: "object", string: str) -> str:
                self.sub_calls += 1
                return self._real.sub(repl, string)

        spy = _CountingPattern(te._PLACEHOLDER_RE)
        with mock.patch.object(te, "_PLACEHOLDER_RE", spy):
            result = _error_fingerprint(many)
        assert spy.sub_calls == 1, (
            f"restore made {spy.sub_calls} passes -- it must be a single linear "
            "substitution, not one rescan per protected span"
        )
        assert isinstance(result, str) and result
        # Bracketed node-id spans are identity: they survive restore verbatim.
        assert "[a]" in result and "[h]" in result

    def test_malformed_placeholder_runs_pass_through_without_crashing(self) -> None:
        """Restore is total: a NUL-delimited run ``_lift`` never made is verbatim.

        Test output decoded with ``errors="replace"`` can carry raw ``\\x00``
        bytes, so the raw error may contain a ``\\x00<digits>\\x00`` run that
        looks like a restore placeholder but was never emitted by ``_lift``.
        The restore step matches only a bounded digit run and returns any run
        it did not create unchanged, so fingerprinting a crash-shaped error
        cannot itself raise (no out-of-range index, no unbounded ``int()``).
        For each case the raw ``\\x00`` sequence survives into the normalized
        text verbatim; the only transforms are the volatile masks and the
        whitespace collapse, which these inputs do not trigger.
        """
        cases = {
            "stray run": "boom \x003\x00 end",
            "out of range": "x \x0099\x00 y",
            "huge digit run": "x \x00" + "9" * 5000 + "\x00 y",
            "empty digits": "x \x00\x00 y",
            "adjacent runs": "x \x001\x00\x002\x00 y",
        }
        for name, raw in cases.items():
            result = _error_fingerprint(raw)
            assert isinstance(result, str) and result, f"{name}: empty/non-str result"
            # The NUL-delimited run is not a real placeholder, so it is left in
            # place. A run short enough to stay under the digest bound appears
            # verbatim; the 5000-digit run only exceeds that bound and is hashed.
            if len(raw) <= 1000:
                assert "\x00" in result, f"{name}: placeholder-shaped run was not left verbatim"
