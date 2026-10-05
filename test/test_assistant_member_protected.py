"""Captain (the ``kirocrew-captain`` member bound to ``kirocrew-captain``) is locked.

Captain is created once behind a one-time marker and never re-created, so every
path that removes a crew member refuses it, no user path creates its key or
rebinds it off its template, and no other member takes its current name. An
ordinary member -- including one keyed ``assistant`` -- is unaffected.
"""

from __future__ import annotations

import argparse
import json
from unittest.mock import MagicMock, patch

import pytest
from aiohttp import web

from kiro_crew import change_card_catalog as catalog
from kiro_crew import cli_commands as cc
from kiro_crew.agent_files import (
    ASSISTANT_MEMBER_NAME,
    ASSISTANT_MEMBER_PROTECTED,
    ASSISTANT_MEMBER_RESERVED,
    ASSISTANT_NAME_TAKEN,
    ASSISTANT_TEMPLATE_NAME,
    is_assistant_member,
)
from kiro_crew.config.loader import KiroCrewAgentConfig, KiroCrewConfig
from kiro_crew.dashboard.handlers.agents import (
    _api_kirocrew_agents_create,
    api_kirocrew_agent_delete,
    api_kirocrew_agent_update,
)
from kiro_crew.members import key_new_crew

ORDINARY = "scout"
DEFAULT = "kirocrew"


@pytest.fixture(autouse=True)
def _owner_caller(monkeypatch):
    monkeypatch.setattr(
        "kiro_crew.dashboard.handlers.source_providers.is_owner_dashboard_request",
        lambda request: True,
    )


def _delete_request(name: str):
    request = MagicMock(spec=web.Request)
    request.method = "DELETE"
    request.match_info = {"name": name}
    request.app = {"state": None}
    return request


def _seed(assistant_template: str = ASSISTANT_TEMPLATE_NAME) -> None:
    cfg = KiroCrewConfig()
    cfg.agents = {
        DEFAULT: KiroCrewAgentConfig(kiro_agent=DEFAULT),
        ASSISTANT_MEMBER_NAME: KiroCrewAgentConfig(kiro_agent=assistant_template),
        ORDINARY: KiroCrewAgentConfig(kiro_agent="oncall-agent"),
    }
    cfg.default_agent = DEFAULT
    cfg.save()


def test_identity_is_name_and_template():
    assert is_assistant_member(ASSISTANT_MEMBER_NAME, {"kiro_agent": ASSISTANT_TEMPLATE_NAME})
    assert is_assistant_member(
        ASSISTANT_MEMBER_NAME, KiroCrewAgentConfig(kiro_agent=ASSISTANT_TEMPLATE_NAME)
    )
    assert not is_assistant_member(ASSISTANT_MEMBER_NAME, {"kiro_agent": "oncall-agent"})
    assert not is_assistant_member(ORDINARY, {"kiro_agent": ASSISTANT_TEMPLATE_NAME})


@pytest.mark.asyncio
async def test_dashboard_delete_refuses_captain():
    _seed()
    resp = await api_kirocrew_agent_delete(_delete_request(ASSISTANT_MEMBER_NAME))
    assert resp.status == 409
    assert json.loads(resp.text)["code"] == ASSISTANT_MEMBER_PROTECTED
    assert ASSISTANT_MEMBER_NAME in KiroCrewConfig.load().agents


@pytest.mark.asyncio
async def test_dashboard_delete_refuses_captain_inside_the_config_lock():
    """A stale pre-read must not let the locked mutation remove Captain."""
    _seed()
    stale = KiroCrewConfig.load()
    stale.agents[ASSISTANT_MEMBER_NAME] = KiroCrewAgentConfig(kiro_agent="oncall-agent")
    with patch.object(KiroCrewConfig, "load", return_value=stale):
        resp = await api_kirocrew_agent_delete(_delete_request(ASSISTANT_MEMBER_NAME))
    assert resp.status == 409
    assert json.loads(resp.text)["code"] == ASSISTANT_MEMBER_PROTECTED
    assert ASSISTANT_MEMBER_NAME in KiroCrewConfig.load().agents


@pytest.mark.asyncio
async def test_dashboard_delete_of_an_ordinary_member_still_works():
    _seed()
    resp = await api_kirocrew_agent_delete(_delete_request(ORDINARY))
    assert resp.status == 200
    agents = KiroCrewConfig.load().agents
    assert ORDINARY not in agents and ASSISTANT_MEMBER_NAME in agents


@pytest.mark.asyncio
async def test_captains_key_on_another_template_is_ordinary():
    _seed(assistant_template="oncall-agent")
    resp = await api_kirocrew_agent_delete(_delete_request(ASSISTANT_MEMBER_NAME))
    assert resp.status == 200
    assert ASSISTANT_MEMBER_NAME not in KiroCrewConfig.load().agents


def test_cli_delete_refuses_captain(capsys):
    _seed()
    with pytest.raises(SystemExit) as exc:
        cc._handle_agent(argparse.Namespace(agent_action="delete", name=ASSISTANT_MEMBER_NAME))
    assert exc.value.code == 1
    assert "Captain" in capsys.readouterr().err
    assert ASSISTANT_MEMBER_NAME in KiroCrewConfig.load().agents


def test_cli_delete_of_an_ordinary_member_still_works(capsys):
    _seed()
    cc._handle_agent(argparse.Namespace(agent_action="delete", name=ORDINARY))
    assert f"Deleted agent: {ORDINARY}" in capsys.readouterr().out
    assert ORDINARY not in KiroCrewConfig.load().agents


@pytest.mark.parametrize("name", ["kirocrew-captain", "Kirocrew-Captain"])
def test_card_refuses_creating_a_crewmate_under_captains_key(name):
    p = catalog.validate_params("crewmate.create", {"name": name, "goal": "g"})
    with pytest.raises(catalog.CardCatalogError) as exc:
        catalog.build_preview("crewmate.create", p, {"exists": False}, {})
    assert exc.value.code == ASSISTANT_MEMBER_RESERVED


def test_card_undo_that_would_delete_captain_is_refused():
    p = catalog.validate_params("crewmate.create", {"name": "Scout", "goal": "g"})
    undo, reason = catalog.build_undo(
        "crewmate.create", p, {}, [{"name": ASSISTANT_MEMBER_NAME}], applied_steps=1
    )
    assert undo is None and reason == ASSISTANT_MEMBER_PROTECTED


def test_card_undo_for_an_ordinary_crewmate_still_deletes_it():
    p = catalog.validate_params("crewmate.create", {"name": "Scout", "goal": "g"})
    undo, reason = catalog.build_undo("crewmate.create", p, {}, [{"name": "scout"}], 1)
    assert reason is None
    assert undo == [{"method": "DELETE", "path": "/api/agents/scout", "body": None}]


def test_plan_guard_matches_only_captains_delete_route():
    assert catalog.deletes_assistant_member(
        [catalog.step("DELETE", f"/api/agents/{ASSISTANT_MEMBER_NAME}")]
    )
    assert not catalog.deletes_assistant_member([catalog.step("DELETE", "/api/agents/scout")])
    assert not catalog.deletes_assistant_member(
        [catalog.step("PUT", f"/api/agents/{ASSISTANT_MEMBER_NAME}")]
    )


# ── identity lock ──


def _create_request(body: dict):
    request = MagicMock(spec=web.Request)
    request.method = "POST"

    async def _json():
        return body

    request.json = _json
    request.app = {"state": None}
    request.get = lambda key, default=None: default
    return request


def _put_request(name: str, body: dict):
    request = _create_request(body)
    request.method = "PUT"
    request.match_info = {"name": name}
    return request


def _seed_with_captain_named(label: str) -> None:
    _seed()
    cfg = KiroCrewConfig.load()
    cfg.agents[ASSISTANT_MEMBER_NAME].display_name = label
    cfg.save()


@pytest.mark.asyncio
@pytest.mark.parametrize("captain_present", [True, False])
async def test_post_refuses_captains_key_whether_or_not_captain_exists(captain_present):
    _seed()
    if not captain_present:
        cfg = KiroCrewConfig.load()
        del cfg.agents[ASSISTANT_MEMBER_NAME]
        cfg.save()
    resp = await _api_kirocrew_agents_create(
        _create_request({"name": ASSISTANT_MEMBER_NAME, "kiro_agent": "kirocrew"})
    )
    assert resp.status == 409
    assert json.loads(resp.text)["code"] == ASSISTANT_MEMBER_RESERVED
    assert (ASSISTANT_MEMBER_NAME in KiroCrewConfig.load().agents) is captain_present


def test_a_free_form_name_never_derives_captains_key():
    keyed = key_new_crew("Kirocrew Captain", "", {})
    assert keyed.key != ASSISTANT_MEMBER_NAME and keyed.code == ""


@pytest.mark.parametrize("label", ["Captain", " captain ", "CAPTAIN"])
def test_key_new_crew_refuses_captains_label_case_insensitively(label):
    agents = {
        ASSISTANT_MEMBER_NAME: {"kiro_agent": ASSISTANT_TEMPLATE_NAME, "display_name": "Captain"}
    }
    keyed = key_new_crew("helper", label, agents)
    assert keyed.code == ASSISTANT_NAME_TAKEN and keyed.taken == "Captain"


def test_default_label_counts_when_captain_has_none():
    agents = {ASSISTANT_MEMBER_NAME: {"kiro_agent": ASSISTANT_TEMPLATE_NAME, "display_name": ""}}
    assert key_new_crew("Captain", "", agents).code == ASSISTANT_NAME_TAKEN
    # "Assistant" is no longer Captain's default label.
    assert key_new_crew("Assistant", "", agents).code == ""
    # No Captain on the roster: nothing to collide with.
    assert key_new_crew("Captain", "", {}).code == ""


@pytest.mark.asyncio
async def test_post_refuses_a_display_name_equal_to_captains():
    _seed_with_captain_named("Captain")
    resp = await _api_kirocrew_agents_create(
        _create_request({"name": "helper", "display_name": "captain", "kiro_agent": "kirocrew"})
    )
    assert resp.status == 409
    assert json.loads(resp.text)["code"] == ASSISTANT_NAME_TAKEN


@pytest.mark.asyncio
async def test_rename_of_another_member_to_captains_name_is_refused():
    _seed_with_captain_named("Captain")
    resp = await api_kirocrew_agent_update(_put_request(ORDINARY, {"display_name": " Captain "}))
    assert resp.status == 409
    assert json.loads(resp.text)["code"] == ASSISTANT_NAME_TAKEN
    assert KiroCrewConfig.load().agents[ORDINARY].display_name == ""


@pytest.mark.asyncio
async def test_renaming_captain_writes_display_name_and_keeps_the_key():
    _seed()
    resp = await api_kirocrew_agent_update(
        _put_request(
            ASSISTANT_MEMBER_NAME,
            {"display_name": "Skipper", "kiro_agent": ASSISTANT_TEMPLATE_NAME},
        )
    )
    assert resp.status == 200
    agents = KiroCrewConfig.load().agents
    assert agents[ASSISTANT_MEMBER_NAME].display_name == "Skipper"
    assert is_assistant_member(ASSISTANT_MEMBER_NAME, agents[ASSISTANT_MEMBER_NAME])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [{"kiro_agent": "oncall-agent"}, {"kiro_agent": "oncall-agent", "description": "x"}],
    ids=["binding-fast-path", "generic-path"],
)
async def test_captain_cannot_be_rebound_off_its_template(body):
    _seed()
    resp = await api_kirocrew_agent_update(_put_request(ASSISTANT_MEMBER_NAME, body))
    assert resp.status == 409
    assert json.loads(resp.text)["code"] == ASSISTANT_MEMBER_RESERVED
    assert KiroCrewConfig.load().agents[ASSISTANT_MEMBER_NAME].kiro_agent == ASSISTANT_TEMPLATE_NAME


def test_cli_create_refuses_captains_key(capsys):
    _seed()
    with pytest.raises(SystemExit):
        cc._handle_agent(
            argparse.Namespace(
                agent_action="create",
                name=ASSISTANT_MEMBER_NAME,
                kiro_agent="kirocrew",
                workspace="default",
                memory_store="",
                display_name=None,
            )
        )
    assert "reserved for Captain" in capsys.readouterr().err


def test_cli_update_refuses_rebinding_captain(capsys):
    _seed()
    with pytest.raises(SystemExit):
        cc._handle_agent(
            argparse.Namespace(
                agent_action="update",
                name=ASSISTANT_MEMBER_NAME,
                kiro_agent="oncall-agent",
                workspace=None,
                memory_store=None,
            )
        )
    assert KiroCrewConfig.load().agents[ASSISTANT_MEMBER_NAME].kiro_agent == ASSISTANT_TEMPLATE_NAME


def test_cards_refuse_captains_name():
    p = catalog.validate_params("crewmate.create", {"name": "Captain", "goal": "g"})
    with pytest.raises(catalog.CardCatalogError) as exc:
        catalog.build_preview(
            "crewmate.create", p, {"exists": False, "assistant_name_taken": "Captain"}, {}
        )
    assert exc.value.code == ASSISTANT_NAME_TAKEN
    p = catalog.validate_params(
        "crewmate.update", {"name": ORDINARY, "fields": {"display_name": "Captain"}}
    )
    with pytest.raises(catalog.CardCatalogError) as exc:
        catalog.build_preview(
            "crewmate.update",
            p,
            {"exists": True, "fields": {"display_name": ""}, "assistant_name_taken": "Captain"},
            {},
        )
    assert exc.value.code == ASSISTANT_NAME_TAKEN


def test_card_snapshot_reports_captains_name():
    from kiro_crew.dashboard import change_cards as cards

    _seed_with_captain_named("Captain")
    snap = cards._sync_read_state(
        "crewmate.update", {"name": ORDINARY, "fields": {"display_name": "captain"}}, []
    )
    assert snap["assistant_name_taken"] == "Captain"
    own = cards._sync_read_state(
        "crewmate.update",
        {"name": ASSISTANT_MEMBER_NAME, "fields": {"display_name": "Captain"}},
        [],
    )
    assert own["assistant_name_taken"] == ""
    create = cards._sync_read_state("crewmate.create", {"name": "CAPTAIN"}, [])
    assert create["assistant_name_taken"] == "Captain"
