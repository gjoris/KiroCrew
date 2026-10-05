"""``find_ui``: the packaged dashboard location index and its search.

The index is generated from the dashboard source (``website/scripts/gen-ui-index.mjs``);
these tests read the real packaged file for the golden answers and synthetic
files for the failure statuses. Nothing here may need a session, the gateway or
the user's config.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from kiro_crew import mcp_guide, ui_index
from kiro_crew.validation import ValidationError

#: The packaged docs directory, wherever the index under test lives.
_PACKAGED_DOCS = ui_index.INDEX_PATH.parent


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ui_index._cache.update(key=None, index=None)
    # The committed tiers only, whatever dashboard build this checkout has:
    # the build-time auto tier is pinned in test_find_ui_auto.py.
    monkeypatch.setattr(ui_index, "AUTO_INDEX_PATH", tmp_path / "no-auto-tier.json")
    # Test seam only (the tool itself never reads a path from anywhere): point
    # every golden at an index written by `gen:ui --out <file>`, so parallel
    # area batches each validate their own index without touching the
    # committed one.
    alt = os.environ.get("KIROCREW_UI_INDEX")
    if alt:
        monkeypatch.setattr(ui_index, "INDEX_PATH", Path(alt).resolve())


def _top(d: dict[str, Any]) -> dict[str, Any]:
    assert d["status"] == "ok", d
    return d["results"][0]


def _path(placement: dict[str, Any]) -> list[str]:
    return [seg["label"] for seg in placement["path"]]


# ── golden answers from the real index ──


def test_older_sessions_in_english_is_sessions_then_older_sessions() -> None:
    d = ui_index.find_ui("where are my older sessions?", "en")
    top = _top(d)
    assert top["id"] == "chat.older-sessions"
    desktop, mobile = top["placements"]
    assert _path(desktop) == ["Sessions", "Older Sessions"]
    assert [s["role"] for s in desktop["path"]] == ["navigation", "target"]
    assert desktop["route"] == "/chat"
    assert {"kind": "viewport", "value": "desktop"} in desktop["requires"]
    shown = next(r for r in desktop["requires"] if r["kind"] == "shown_by")
    assert shown["label"] == "Show sessions sidebar"
    assert {"kind": "viewport", "value": "mobile"} in mobile["requires"]
    assert (
        next(r for r in mobile["requires"] if r["kind"] == "shown_by")["label"] == "Toggle sessions"
    )
    assert top["availability"] == "not_observed"
    assert d["resolved_locale"] == "en" and d["locale_source"] == "requested"


def test_the_sidebar_toggle_is_a_conditional_step_with_its_own_qualifications() -> None:
    # With no open sessions the sidebar is forced open and no toggle is drawn;
    # while it is open the toggle reads "Hide". So the step applies only while
    # the sidebar is collapsed, and says what to do otherwise.
    desktop, mobile = _top(ui_index.find_ui("older sessions", "en"))["placements"]
    shown = next(r for r in desktop["requires"] if r["kind"] == "shown_by")
    assert shown["when"] == "sessions_sidebar_collapsed"
    assert shown["only_if"] == "the sessions sidebar is collapsed"
    assert shown["otherwise"].startswith("already visible")
    own = {r["id"]: r for r in shown["requires"]}
    assert set(own) == {"has_open_sessions", "full_dashboard"}
    assert own["has_open_sessions"]["description"] == "at least one open session is listed"
    drawer = next(r for r in mobile["requires"] if r["kind"] == "shown_by")
    assert drawer["when"] == "sessions_drawer_closed"
    assert "requires" not in drawer  # the mobile toggle has no further gate


# ── legacy pages resolve to where their redirect lands ──


def test_a_legacy_page_title_finds_its_explicit_canonical_location() -> None:
    top = _top(ui_index.find_ui("kiro crew agents", "en"))
    assert top["id"] == "tab.capabilities.crews"
    assert top["placements"][0]["route"] == "/capabilities?tab=crews"
    remote = _top(ui_index.find_ui("remote crew", "en"))
    assert remote["id"] == "settings.tab.instances"
    assert remote["placements"][0]["route"] == "/settings/instances"


def test_the_tasks_alias_keeps_the_task_runner_gate() -> None:
    d = ui_index.find_ui("tasks", "en")
    projects = next(r for r in d["results"] if r["id"] == "page.projects")
    assert projects["placements"][0]["requires"][0]["id"] == "app_enabled"


def test_no_result_hands_out_a_redirecting_route() -> None:
    real = json.loads(ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    routes = {p["route"].split("?")[0] for loc in real["locations"] for p in loc["placements"]}
    assert not routes & {"/mc-agents", "/tasks", "/instances", "/agents", "/connections"}
    assert not {loc["id"] for loc in real["locations"]} & {
        "page.mc-agents",
        "page.tasks",
        "page.instances",
    }


def test_older_sessions_in_chinese_is_answered_in_chinese() -> None:
    d = ui_index.find_ui("较早的会话在哪里", "zh-CN")
    top = _top(d)
    assert top["id"] == "chat.older-sessions"
    assert _path(top["placements"][0]) == ["会话", "较早的会话"]
    assert d["resolved_locale"] == "zh-CN"


def test_a_localized_query_without_lang_matches_but_reports_english_fallback() -> None:
    d = ui_index.find_ui("较早的会话")
    top = _top(d)
    assert top["id"] == "chat.older-sessions"
    assert _path(top["placements"][0]) == ["Sessions", "Older Sessions"]
    assert d["requested_locale"] is None
    assert d["locale_source"] == "fallback"


def test_a_setting_carries_its_route_setting_id_and_guide() -> None:
    top = _top(ui_index.find_ui("link previews", "en"))
    assert top["id"] == "setting:chat.link-previews"
    assert top["setting_id"] == "chat.link-previews"
    placement = top["placements"][0]
    assert _path(placement) == ["Settings", "Chat", "Transcript", "Link Previews"]
    assert placement["route"] == "/settings/chat/transcript?highlight=chat.link-previews"
    assert top["guide_ref"] == {
        "action_id": "settings.show",
        "params": {"setting_id": "chat.link-previews"},
    }


def test_a_credential_setting_never_carries_a_guide() -> None:
    d = ui_index.find_ui("jev api key", "en")
    hit = next(r for r in d["results"] if r.get("setting_id") == "developer.jev-api-key")
    assert "guide_ref" not in hit


def test_crewmates_names_its_preview_flag_and_where_to_turn_it_on() -> None:
    d = ui_index.find_ui("crewmates", "en")
    page = next(r for r in d["results"] if r["id"] == "page.members")
    flag = page["placements"][0]["requires"][0]
    assert flag["kind"] == "preview_flag"
    assert flag["setting_id"] == "developer.crewmates"
    assert flag["path"] == ["Settings", "Developer", "Crewmates"]
    assert flag["route"].startswith("/settings/developer?highlight=")


def test_channel_settings_hang_under_their_channel_without_a_label_suffix() -> None:
    d = ui_index.find_ui("slack", "en")
    slack = next(r for r in d["results"] if r["id"] == "settings.sub.channels.slack")
    assert slack["placements"][0]["route"] == "/settings/channels/slack"
    assert slack["label"] == "Slack"


def test_nonsense_is_no_match_and_says_so() -> None:
    d = ui_index.find_ui("zqxjv wpfk", "en")
    assert d["status"] == "no_match"
    assert d["results"] == []
    assert "not every dashboard control" in d["coverage"]


def test_fullwidth_and_case_fold_to_the_same_label() -> None:
    assert (
        _top(ui_index.find_ui("ＬＩＮＫ　ＰＲＥＶＩＥＷＳ", "en"))["id"]
        == "setting:chat.link-previews"
    )


def test_an_exact_location_or_setting_id_is_found() -> None:
    assert _top(ui_index.find_ui("chat.link-previews"))["id"] == "setting:chat.link-previews"
    assert _top(ui_index.find_ui("chat.older-sessions"))["match"] == "id"


def test_an_unsupported_locale_falls_back_to_english() -> None:
    d = ui_index.find_ui("older sessions", "tlh")
    assert d["resolved_locale"] == "en" and d["locale_source"] == "fallback"
    assert d["requested_locale"] == "tlh"


def test_surface_keeps_only_that_surface() -> None:
    d = ui_index.find_ui("sessions", "en", "settings")
    assert d["results"]
    assert all(p["path"][0]["label"] == "Settings" for r in d["results"] for p in r["placements"])


def test_ties_are_ordered_by_id_and_flagged_ambiguous() -> None:
    d = ui_index.find_ui("crewmates", "en")
    exact = [r["id"] for r in d["results"] if r["match"] == "exact_label"]
    assert exact == sorted(exact) and len(exact) > 1
    assert d["ambiguous"] is True


# ── newcomer wording: curated terms find it, one shared word does not ──


@pytest.mark.parametrize(
    ("query", "lang"),
    [
        ("where are my old chats", "en"),
        ("where are my old chats?", None),
        ("past conversations", "en"),
        ("previous sessions", "en"),
        ("where is my chat history", "en"),
        ("history", "en"),
        ("历史对话在哪里", "zh-CN"),
        ("以前的聊天", "zh-CN"),
        ("我的聊天记录在哪里", "zh-CN"),
        ("以前的聊天", None),
    ],
)
def test_newcomer_words_for_old_chats_find_older_sessions(query: str, lang: str | None) -> None:
    d = ui_index.find_ui(query, lang)
    top = _top(d)
    assert top["id"] == "chat.older-sessions", d["results"]
    assert top["match"] == "search_term"
    assert d["ambiguous"] is False
    # The weak one-word hits ("Chat", "Sessions") are dropped, not ranked below it.
    assert [r["id"] for r in d["results"]] == ["chat.older-sessions"]


def test_a_zh_answer_found_by_a_term_is_labelled_in_chinese() -> None:
    top = _top(ui_index.find_ui("历史对话在哪里", "zh-CN"))
    assert _path(top["placements"][0]) == ["会话", "较早的会话"]


@pytest.mark.parametrize(
    ("query", "lang", "target"),
    [
        ("how do i turn on dark mode", "en", "setting:display.mode"),
        # "does" is stemmed to "doe"; the question-word list must catch both forms.
        ("where does dark mode live", "en", "setting:display.mode"),
        ("深色模式", "zh-CN", "setting:display.mode"),
        ("where are my reminders", "en", "page.schedule"),
        ("提醒在哪里", "zh-CN", "page.schedule"),
        ("where do i put my api key", "en", "settings.tab.secrets"),
        ("messaging", "en", "settings.tab.channels"),
        ("connect slack", "en", "settings.sub.channels.slack"),
    ],
)
def test_seeded_newcomer_words_on_pages_and_settings(query: str, lang: str, target: str) -> None:
    assert _top(ui_index.find_ui(query, lang))["id"] == target


# ── wave 2, slice 1: creating things and finding search ──


@pytest.mark.parametrize(
    ("query", "lang", "expected"),
    [
        # New chat: the sidebar button, and the empty pane while no session is open.
        ("how do I start a new chat", "en", {"chat.new-session", "chat.start-new-chat"}),
        ("new conversation", None, {"chat.new-session", "chat.start-new-chat"}),
        ("新建对话", "zh-CN", {"chat.new-session", "chat.start-new-chat"}),
        ("怎么开始新对话", "zh-CN", {"chat.new-session", "chat.start-new-chat"}),
        # Schedule: empty-state and populated hosts both answer, each qualified.
        ("where do I make a schedule", "en", {"schedule.add-job", "schedule.create-first"}),
        ("where can I create a reminder", "en", {"schedule.add-job", "schedule.create-first"}),
        ("在哪里新建提醒", "zh-CN", {"schedule.add-job", "schedule.create-first"}),
        # MCP: both ways to add one, under the MCP Servers sub-tab.
        ("add an MCP server", "en", {"mcp.add-custom", "mcp.add-server"}),
        ("添加 MCP", "zh-CN", {"mcp.add-custom", "mcp.add-server"}),
        ("添加MCP服务器", "zh-CN", {"mcp.add-custom", "mcp.add-server"}),
        # Artifacts.
        ("how do I upload a file", "en", {"artifacts.import"}),
        ("上传文件", "zh-CN", {"artifacts.import"}),
        ("create a new document", "en", {"artifacts.new"}),
        ("新建文档", "zh-CN", {"artifacts.new"}),
        # Search Everywhere: the desktop top bar and the phone menu's row.
        ("where is the command palette", "en", {"shell.search", "shell.menu-search"}),
        ("命令面板", "zh-CN", {"shell.search", "shell.menu-search"}),
    ],
)
def test_slice1_newcomer_questions_find_the_creation_controls(
    query: str, lang: str | None, expected: set[str]
) -> None:
    d = ui_index.find_ui(query, lang)
    assert d["status"] == "ok", d
    top_score_ids = {r["id"] for r in d["results"][: len(expected)]}
    assert top_score_ids == expected, [r["id"] for r in d["results"]]


def test_schedule_creation_names_the_state_each_host_is_drawn_in() -> None:
    d = ui_index.find_ui("where do I make a schedule", "en")
    by_id = {r["id"]: r for r in d["results"]}
    assert d["ambiguous"] is True
    first, add = by_id["schedule.create-first"], by_id["schedule.add-job"]
    assert first["label"] == "Create your first job"
    assert add["label"] == "Add Job"
    assert [r["id"] for r in first["placements"][0]["requires"]] == ["no_schedules"]
    assert [r["id"] for r in add["placements"][0]["requires"]] == ["has_schedules"]
    for r in (first, add):
        assert _path(r["placements"][0])[0] == "Schedule"
        assert r["placements"][0]["route"] == "/schedule"


def test_add_mcp_server_walks_through_the_mcp_servers_sub_tab_in_both_languages() -> None:
    en = {r["id"]: r for r in ui_index.find_ui("add an MCP server", "en")["results"]}
    assert _path(en["mcp.add-custom"]["placements"][0]) == [
        "Customize",
        "Connections",
        "MCP Servers",
        "Add Custom",
    ]
    assert en["mcp.add-server"]["placements"][0]["route"] == "/capabilities?tab=mcp"
    assert en["mcp.add-custom"]["guide_ref"] == {"action_id": "mcp.open_add"}
    assert "guide_ref" not in en["mcp.add-server"]
    zh = {r["id"]: r for r in ui_index.find_ui("添加 MCP", "zh-CN")["results"]}
    assert _path(zh["mcp.add-server"]["placements"][0])[-2:] == ["MCP 服务器", "添加服务器"]


def test_new_chat_in_chinese_is_labelled_in_chinese_and_reached_like_the_sidebar() -> None:
    d = ui_index.find_ui("新建对话", "zh-CN")
    by_id = {r["id"]: r for r in d["results"]}
    side = by_id["chat.new-session"]
    assert side["label"] == "新建聊天会话"
    desktop, mobile = side["placements"]
    assert _path(desktop) == ["会话", "新建聊天会话"]
    assert any(r.get("when") == "sessions_sidebar_collapsed" for r in desktop["requires"])
    assert any(r.get("when") == "sessions_drawer_closed" for r in mobile["requires"])
    assert by_id["chat.start-new-chat"]["placements"][0]["requires"][0]["id"] == (
        "no_active_session"
    )


def _by_id(d: dict[str, Any]) -> dict[str, dict[str, Any]]:
    assert d["status"] == "ok", d
    return {r["id"]: r for r in d["results"]}


def test_a_shell_control_is_on_every_page_and_survives_a_surface_filter() -> None:
    d = ui_index.find_ui("command palette", "en")
    # The desktop bar and the phone menu row are alternatives, never one path.
    assert d["ambiguous"] is True
    top = _by_id(d)["shell.search"]
    p = top["placements"][0]
    assert p["on_every_page"] is True and "route" not in p
    assert _path(p) == ["Search sessions, files, and commands"]
    assert [r.get("id") or r.get("value") for r in p["requires"]] == [
        "desktop",
        "search_bar_unclaimed",
    ]
    # Drawn on every page, so a page filter keeps it; an unknown surface is still refused.
    assert "shell.search" in _by_id(ui_index.find_ui("command palette", "en", "schedule"))
    assert "shell.search" in _by_id(ui_index.find_ui("command palette", "en", "shell"))


def test_the_phone_menu_search_row_hangs_under_the_menu_button_on_every_page() -> None:
    row = _by_id(ui_index.find_ui("command palette", "en"))["shell.menu-search"]
    (p,) = row["placements"]
    assert p["on_every_page"] is True and "route" not in p
    assert _path(p) == ["Open menu", "Search sessions, files, and commands"]
    assert [s["role"] for s in p["path"]] == ["navigation", "target"]
    assert p["entry"] == "menu"
    # The menu button's own gates travel with the row: a phone, and not Sessions.
    assert [r.get("id") or r.get("value") for r in p["requires"]] == [
        "mobile",
        "not_on_sessions_page",
        "search_bar_unclaimed",
    ]
    zh = _by_id(ui_index.find_ui("搜索", "zh-CN"))["shell.menu-search"]
    assert _path(zh["placements"][0]) == ["打开菜单", "搜索会话、文件和命令"]


@pytest.mark.parametrize(
    ("query", "lang", "target"),
    [
        ("change the model for this chat", "en", "chat.model-picker"),
        ("how do I switch model", "en", "chat.model-picker"),
        ("换模型", "zh-CN", "chat.model-picker"),
        ("怎么换模型", "zh-CN", "chat.model-picker"),
        ("memory mode", "en", "chat.memory-mode"),
        ("where is incognito mode", "en", "chat.memory-mode"),
        ("记忆", "zh-CN", "chat.memory-mode"),
        ("无痕模式在哪里", "zh-CN", "chat.memory-mode"),
    ],
)
def test_runtime_labelled_chips_are_found_by_newcomer_words(
    query: str, lang: str, target: str
) -> None:
    assert _top(ui_index.find_ui(query, lang))["id"] == target


def test_a_runtime_label_is_returned_as_a_description_never_as_a_label() -> None:
    chip = _top(ui_index.find_ui("change the model for this chat", "en"))
    assert "label" not in chip
    assert chip["description"].startswith("The model button in the message box")
    target = chip["placements"][0]["path"][-1]
    assert target["role"] == "target" and "label" not in target
    assert target["description"] == chip["description"]
    assert _path_or_description(chip["placements"][0]) == ["Sessions", chip["description"]]
    assert [r.get("id") or r.get("label") for r in chip["placements"][0]["requires"]] == [
        "session_open",
        # The shelf unmounts with a collapsed message box: Expand composer first.
        "Show the message input",
        "no_response_running",
    ]
    # Matched by its description's own words, the basis says so (and is never
    # "exact_label": there is no label to match).
    by_desc = _top(ui_index.find_ui(chip["description"], "en"))
    assert by_desc["id"] == "chat.model-picker" and by_desc["match"] == "description"
    zh = _top(ui_index.find_ui("记忆模式", "zh-CN"))
    assert zh["id"] == "chat.memory-mode" and "label" not in zh
    assert zh["description"].startswith("消息框上方的记忆模式按钮")
    assert [r["id"] for r in zh["placements"][0]["requires"]] == ["empty_session"]


def _path_or_description(placement: dict[str, Any]) -> list[str]:
    return [seg.get("label") or seg["description"] for seg in placement["path"]]


@pytest.mark.parametrize(
    ("query", "target"),
    [
        # The path explains "artifact": Artifacts > ... > Import from a file.
        ("import an artifact", "artifacts.import"),
        ("where do I import artifacts", "artifacts.import"),
        # "everything" and "everywhere" are one word: the Search everywhere alias.
        ("search everything", "shell.search"),
        ("search anywhere", "shell.search"),
    ],
)
def test_path_words_and_all_words_complete_a_real_match(query: str, target: str) -> None:
    d = ui_index.find_ui(query, "en")
    assert target in _by_id(d), d["results"]


def test_a_path_completed_match_never_outranks_a_direct_one() -> None:
    d = ui_index.find_ui("chat model", "en")
    assert all(r["match"] != "tokens_with_path" for r in d["results"]), d["results"]
    assert _top(ui_index.find_ui("import an artifact", "en"))["match"] == "tokens_with_path"


@pytest.mark.parametrize(
    "query",
    [
        "chat about dinner",
        "where are my keys",
        "import my taxes",
        "search for my cat",
        "artifact of the ancient world",
    ],
)
def test_path_completion_does_not_answer_unrelated_questions(query: str) -> None:
    assert ui_index.find_ui(query, "en")["status"] == "no_match", query


@pytest.mark.parametrize(
    ("query", "lang"),
    [
        ("what's for dinner", "en"),
        ("asdf qwer", None),
        ("where did I park", "en"),
        ("今天天气怎么样", "zh-CN"),
    ],
)
def test_slice1_terms_do_not_answer_unrelated_questions(query: str, lang: str | None) -> None:
    assert ui_index.find_ui(query, lang)["status"] == "no_match"


@pytest.mark.parametrize(
    ("query", "lang"),
    [
        ("where are my keys", "en"),
        ("chat about dinner", "en"),
        ("where is the chat about dinner", None),
        ("where are my car keys", "en"),
        ("我的钥匙在哪里", "zh-CN"),
    ],
)
def test_one_shared_word_is_no_answer(query: str, lang: str | None) -> None:
    d = ui_index.find_ui(query, lang)
    assert d["status"] == "no_match", d["results"]
    assert d["results"] == []


def test_a_label_covering_only_part_of_the_question_is_dropped(tmp_path: Path) -> None:
    # Before curated terms, "old chats" met the label "Chat" and came back as a
    # lone confident "ok". Without a term for it, it must be no_match.
    real = json.loads(ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    for loc in real["locations"]:
        loc.pop("terms", None)
    path = _write(tmp_path, real)
    assert ui_index.find_ui("where are my old chats", "en", path=path)["status"] == "no_match"
    assert ui_index.find_ui("以前的聊天", "zh-CN", path=path)["status"] == "no_match"
    # A full-coverage label still answers, with the question words dropped.
    assert _top(ui_index.find_ui("where are my older sessions?", "en", path=path))["id"] == (
        "chat.older-sessions"
    )
    assert _top(ui_index.find_ui("较早的会话在哪里", "zh-CN", path=path))["id"] == (
        "chat.older-sessions"
    )


@pytest.mark.parametrize(
    ("query", "lang", "target", "rival"),
    [
        # Context words name the target's own ancestors, and pick between the
        # same label in two places: the label in the other place is gone.
        ("voice model", "en", "setting:voice.model", "settings.sub.chat.models"),
        # The composer's model chip may follow ("change the model for this
        # chat" is one of its terms), never Voice > Model.
        ("chat model", "en", "settings.sub.chat.models", "setting:voice.model"),
        ("display language", "en", "setting:display.language", "setting:voice.language"),
        ("voice language", "en", "setting:voice.language", "setting:display.language"),
        ("slack session folder", "en", "setting:channels.file-sessions-in-a-folder-slack", None),
        ("语音模型", "zh-CN", "setting:voice.model", "settings.sub.chat.models"),
        ("聊天模型", "zh-CN", "settings.sub.chat.models", "setting:voice.model"),
        ("语音语言", "zh-CN", "setting:voice.language", "setting:display.language"),
        # Task phrases ("make a schedule", "新建提醒") now answer with the two
        # creation buttons; see test_slice1_newcomer_questions_find_the_creation_controls.
    ],
)
def test_context_words_disambiguate_instead_of_losing_the_match(
    query: str, lang: str, target: str, rival: str | None
) -> None:
    d = ui_index.find_ui(query, lang)
    ids = [r["id"] for r in d["results"]]
    assert ids[0] == target, d["results"]
    assert rival not in ids
    # The two model controls in the chat may follow (the chip, and the bulk
    # "change the model for all chats" item); never the rival in another place.
    assert set(ids) <= {target, "chat.model-picker", "sessions.list-menu.switch-model"}, ids
    assert d["ambiguous"] is False


@pytest.mark.parametrize(
    ("query", "both"),
    [
        ("model", {"setting:voice.model", "settings.sub.chat.models"}),
        ("language", {"setting:display.language", "setting:voice.language"}),
    ],
)
def test_without_context_the_same_label_stays_ambiguous(query: str, both: set[str]) -> None:
    d = ui_index.find_ui(query, "en")
    assert d["ambiguous"] is True
    assert both <= {r["id"] for r in d["results"]}


def test_an_ancestor_explains_context_but_never_creates_a_match() -> None:
    # "chat" is an ancestor of Settings > Chat > About you, but "dinner" stays
    # unexplained, so the label "About you" is no answer.
    assert ui_index.find_ui("chat about dinner", "en")["status"] == "no_match"
    assert ui_index.find_ui("voice dinner", "en")["status"] == "no_match"


def test_a_generic_word_inside_a_longer_label_is_dropped() -> None:
    # "key" is one of three content words in "Jev API key": not an answer to "keys".
    assert ui_index.find_ui("keys", "en")["status"] == "no_match"
    hits = {r["id"] for r in ui_index.find_ui("jev api key", "en")["results"]}
    assert "setting:developer.jev-api-key" in hits


def test_another_languages_question_words_are_dropped_in_that_language() -> None:
    top = _top(ui_index.find_ui("¿dónde están las conversaciones anteriores?", "es"))
    assert top["id"] == "chat.older-sessions"


def test_malformed_terms_make_the_index_unavailable(tmp_path: Path) -> None:
    real = json.loads(ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    real["locations"][0]["terms"] = {"en": "old chats"}
    assert ui_index.find_ui("x", path=_write(tmp_path, real))["status"] == "unavailable"


# ── size and shape ──


def _synthetic(tmp_path: Path, n: int, label: str = "Widget") -> Path:
    """An index with ``n`` locations that all carry the same English label."""
    locs = [
        {
            "id": f"page.w{i:02d}",
            "kind": "page",
            "label_key": "k.widget",
            "placements": [
                {
                    "surface_id": "chat",
                    "route": f"/w{i}",
                    "parent_ids": [],
                    "entry_kind": "rail",
                    "requires": [],
                }
            ],
        }
        for i in range(n)
    ]
    payload = {
        "schema_version": 1,
        "input_digest": "sha256:test",
        "coverage": {"scope": "test"},
        "locales": ["en"],
        "surfaces": ["chat"],
        "locations": locs,
        "labels": {"en": {"k.widget": label}},
    }
    return _write(tmp_path, payload)


def test_results_are_capped_at_eight_and_six_kib(tmp_path: Path) -> None:
    d = ui_index.find_ui("widget", "en", path=_synthetic(tmp_path, 12))
    assert len(d["results"]) == ui_index.MAX_RESULTS
    assert d["truncated"] is True and d["ambiguous"] is True
    assert (
        len(json.dumps(d, ensure_ascii=False, sort_keys=True).encode())
        <= ui_index.MAX_RESPONSE_BYTES
    )


def test_a_tight_byte_cap_drops_whole_records_and_flags_truncation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _synthetic(tmp_path, 6)
    full = ui_index.find_ui("widget", "en", path=path)
    assert full["truncated"] is False and len(full["results"]) == 6
    monkeypatch.setattr(ui_index, "MAX_RESPONSE_BYTES", 1200)
    d = ui_index.find_ui("widget", "en", path=path)
    assert d["truncated"] is True
    assert 0 < len(d["results"]) < len(full["results"])
    assert d["results"] == full["results"][: len(d["results"])]
    assert len(json.dumps(d, ensure_ascii=False, sort_keys=True).encode()) <= 1200


def test_a_cap_too_small_for_one_record_is_a_bounded_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ui_index, "MAX_RESPONSE_BYTES", 100)
    d = ui_index.find_ui("link previews", "en")
    assert d["status"] == "unavailable" and d["results"] == []
    # The error itself fits the cap: it carries no index metadata.
    assert ui_index._size(d) <= 100


def test_the_fixed_too_big_answer_fits_the_real_cap() -> None:
    assert ui_index._size(ui_index._TOO_BIG) <= ui_index.MAX_RESPONSE_BYTES


# ── structural corruption is unavailable, never a crash or a half answer ──


def _corrupt(tmp_path: Path, mutate: Any) -> Path:
    real = json.loads(ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    mutate(real)
    return _write(tmp_path, real)


def _loc(real: dict[str, Any], loc_id: str) -> dict[str, Any]:
    return next(x for x in real["locations"] if x["id"] == loc_id)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda r: _loc(r, "chat.older-sessions").update(placements=[]), id="empty"),
        pytest.param(lambda r: _loc(r, "page.chat").update(label_key=7), id="numeric-label"),
        pytest.param(lambda r: _loc(r, "page.chat").update(placements=[3]), id="numeric-placement"),
        pytest.param(
            lambda r: _loc(r, "chat.older-sessions")["placements"][0].update(
                parent_ids=["nonexistent"]
            ),
            id="dangling-parent",
        ),
        pytest.param(
            lambda r: _loc(r, "chat.older-sessions")["placements"][0]["requires"][1].update(
                location="nonexistent"
            ),
            id="dangling-shown-by",
        ),
        pytest.param(
            lambda r: _loc(r, "chat.older-sessions")["placements"][0]["requires"][1].update(
                when="nope"
            ),
            id="unknown-reveal-state",
        ),
        pytest.param(
            lambda r: _loc(r, "page.chat")["placements"][0].update(route=""), id="empty-route"
        ),
        pytest.param(
            lambda r: _loc(r, "shell.search")["placements"][0].update(route="/chat"),
            id="shell-with-route",
        ),
        pytest.param(
            lambda r: _loc(r, "shell.search")["placements"][0].update(parent_ids=["page.chat"]),
            id="shell-with-parent",
        ),
        pytest.param(
            # A shell row may hang under shell chrome only, never under a page.
            lambda r: _loc(r, "shell.menu-search")["placements"][0].update(
                parent_ids=["page.chat"]
            ),
            id="shell-child-under-page",
        ),
        pytest.param(
            lambda r: _loc(r, "chat.model-picker").update(label_kind="label"),
            id="unknown-label-kind",
        ),
        pytest.param(
            # A description has no label to put in someone else's path.
            lambda r: _loc(r, "chat.older-sessions")["placements"][0].update(
                parent_ids=["page.chat", "chat.model-picker"]
            ),
            id="path-through-description",
        ),
        pytest.param(
            lambda r: _loc(r, "chat.older-sessions")["placements"][0]["requires"][1].update(
                location="chat.memory-mode"
            ),
            id="shown-by-description",
        ),
        pytest.param(lambda r: _loc(r, "page.chat").update(label_key="no.such.key"), id="no-label"),
        pytest.param(lambda r: r["locations"].append(dict(r["locations"][0])), id="duplicate-id"),
        pytest.param(lambda r: r["labels"]["en"].update({"x": 5}), id="numeric-catalog-value"),
        pytest.param(lambda r: r.update(conditions=["x"]), id="malformed-conditions"),
    ],
)
def test_structural_corruption_is_unavailable(tmp_path: Path, mutate: Any) -> None:
    path = _corrupt(tmp_path, mutate)
    for query in ("older sessions", "sessions", "x"):
        d = ui_index.find_ui(query, "en", path=path)
        assert d["status"] == "unavailable", (query, d)


def test_an_oversized_index_is_not_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _write(tmp_path, ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    monkeypatch.setattr(ui_index, "MAX_INDEX_BYTES", 1024)
    d = ui_index.find_ui("older sessions", "en", path=path)
    assert d["status"] == "unavailable" and d["reason"] == "index file is too large"


# ── a registered guide binding is re-checked against the guide catalog ──


@pytest.mark.parametrize(
    ("ref", "kept"),
    [
        ({"action_id": "mcp.open_add"}, True),
        ({"action_id": "settings.show", "params": {"setting_id": "chat.link-previews"}}, True),
        ({"action_id": "settings.show", "params": {"setting_id": "developer.jev-api-key"}}, False),
        ({"action_id": "settings.show", "params": {"setting_id": "no.such-setting"}}, False),
        ({"action_id": "mcp.open_add", "params": {"x": "1"}}, False),
        ({"action_id": "not.an.action"}, False),
    ],
)
def test_a_registered_guide_binding_is_handed_out_only_if_the_catalog_accepts_it(
    tmp_path: Path, ref: dict[str, Any], kept: bool
) -> None:
    path = _corrupt(tmp_path, lambda r: _loc(r, "chat.older-sessions").update(guide_ref=ref))
    top = _top(ui_index.find_ui("older sessions", "en", path=path))
    assert ("guide_ref" in top) is kept
    if kept:
        assert top["guide_ref"] == ref


# ── failure statuses ──


def _write(tmp_path: Path, payload: Any) -> Path:
    path = tmp_path / "ui-index.generated.json"
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
    return path


def test_missing_corrupt_and_unknown_schema_are_unavailable(tmp_path: Path) -> None:
    assert ui_index.find_ui("x", path=tmp_path / "absent.json")["status"] == "unavailable"
    assert ui_index.find_ui("x", path=_write(tmp_path, "{not json"))["status"] == "unavailable"
    real = json.loads(ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    assert (
        ui_index.find_ui("x", path=_write(tmp_path, {**real, "schema_version": 99}))["status"]
        == "unavailable"
    )
    assert (
        ui_index.find_ui("x", path=_write(tmp_path, {**real, "labels": {}}))["status"]
        == "unavailable"
    )


def test_unavailable_is_distinct_from_no_match(tmp_path: Path) -> None:
    real = json.loads(ui_index.INDEX_PATH.read_text(encoding="utf-8"))
    d = ui_index.find_ui("zqxjv", path=_write(tmp_path, real))
    assert d["status"] == "no_match"


@pytest.mark.parametrize("query", ["", "   ", "x" * 201])
def test_blank_or_overlong_query_is_an_error(query: str) -> None:
    assert "error" in ui_index.find_ui(query)


@pytest.mark.parametrize("lang", ["../../etc/passwd", "en/../../x", "/etc", "zh-CN\n", "zh-CN\x00"])
def test_lang_cannot_name_a_path(lang: str) -> None:
    assert "error" in ui_index.find_ui("sessions", lang)


@pytest.mark.parametrize("lang", ["../../etc/passwd", "en/../../x", "/etc"])
def test_the_schema_refuses_a_path_shaped_lang(lang: str) -> None:
    with pytest.raises(ValidationError):
        mcp_guide._validate_args("find_ui", {"query": "sessions", "lang": lang})


@pytest.mark.parametrize("surface", ["../settings", "/chat", "Chat", "nope"])
def test_surface_must_be_a_known_surface_id(surface: str) -> None:
    assert "error" in ui_index.find_ui("sessions", "en", surface)


def test_unknown_fields_are_refused() -> None:
    with pytest.raises(ValidationError):
        mcp_guide._validate_args("find_ui", {"query": "x", "path": "/etc/passwd"})


# ── wiring: no identity, no gateway, no config, one file ──


def test_find_ui_needs_no_session_gateway_or_config(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("find_ui must not need a session, the gateway or config")

    monkeypatch.setattr(mcp_guide, "_strict_session_key", boom)
    monkeypatch.setattr(mcp_guide, "_get", boom)
    monkeypatch.setattr(mcp_guide, "_post", boom)
    import kiro_crew.config.loader as loader

    monkeypatch.setattr(loader, "load_config", boom, raising=False)
    read: list[Path] = []
    real_read = Path.read_text

    def spy(self: Path, *a: Any, **k: Any) -> str:
        read.append(self.resolve())
        return real_read(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", spy)
    out = json.loads(
        mcp_guide._call_tool_inner("find_ui", {"query": "older sessions", "lang": "en"})
    )
    assert out["results"][0]["id"] == "chat.older-sessions"
    docs = {ui_index.INDEX_PATH.parent, _PACKAGED_DOCS}
    assert read and all(p.parent in docs for p in read), read


def test_find_ui_is_listed_with_a_closed_schema() -> None:
    tool = next(t for t in mcp_guide._list_tools() if t["name"] == "find_ui")
    schema = tool["inputSchema"]
    # Neither is required on its own: a call passes `query` (search) or `area`
    # (browse), and the server refuses both or neither.
    assert "required" not in schema
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"query", "lang", "surface", "area", "offset"}


def test_the_index_is_cached_per_file_version(tmp_path: Path) -> None:
    real = ui_index.INDEX_PATH.read_text(encoding="utf-8")
    path = _write(tmp_path, real)
    first = ui_index.load_index(path)
    assert ui_index.load_index(path) is first
    path.write_text(real + " ", encoding="utf-8")
    assert ui_index.load_index(path) is not first
