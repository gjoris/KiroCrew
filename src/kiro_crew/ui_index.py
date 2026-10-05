"""``find_ui``: search the packaged index of dashboard locations. Read-only.

The index (``docs/ui-index.generated.json``) is generated from the dashboard's
own source by ``website/scripts/gen-ui-index.mjs``: pages and tabs from the
registries the rail and Search Everywhere render, every Settings control from
the settings extraction, and registered controls proven at their render site.
This module only reads that packaged file and the optional build-time auto
tier (below). It never loads config, contacts
the gateway, inspects a browser or reads user state, so a result describes the
build's known locations and says ``availability: "not_observed"``.

Matching is deliberately literal: Unicode NFKC + casefold, whole phrases for
CJK scripts (no single-character scoring), token coverage for space-separated
scripts, over each location's labels and its curated search terms (the words a
newcomer uses, e.g. "old chats" for Older Sessions). A candidate must also
explain enough of the question once question words are dropped
(:data:`_MIN_COVERAGE`), so one shared word ("Chat" in "where are my old
chats") is never a confident answer. Words a location's ancestors explain
("Voice" in "voice model") leave the question before coverage is measured; they
never create a match on their own. When a location's own words and its path's
together explain the whole question ("import an artifact": Import from a file,
under Artifacts) it may answer, but only if nothing matches by its own words.
"everything"/"everywhere"/"anything"/"anywhere" are one word. A query that only
resembles a label is
``no_match``, which means "not in this build's index", never "the feature does
not exist".

A location whose on-screen label is runtime data (the model chip shows the
model's name) has ``label_kind: "description"``: its result carries
``description`` instead of ``label``, a static sentence saying what the control
is, never text to quote as what the screen shows. One element whose label flips
with a state (Switch to board view / Switch to list view) also carries
``label_by_state``: each label with the state it is on screen in, so the label
quoted is the one the person sees; ``label`` is the one the question named.

A question that is only an action verb ("add", "delete", "删除") names no
object, so no location answers it: the result is ``no_match`` with
``needs_object``, which tells the caller to ask what to act on rather than
guessing one of the many places that verb applies. Naming the kind of thing
("stop button", "停止按钮") supplies that object only when exactly one
registered control's own label starts with the verb (Stop generation): then
that control is the answer. A verb several controls start with ("delete
button") still asks.

An auto entry (``tier: "auto"``) is an unregistered control whose one static
label and one page the generator proved from source (its file is drawn by that
page's route and no other), or that only the app shell draws (then it is on
every page, like a registered shell control); where on the page it sits and what must be true
for it to show are unknown, so it carries ``conditions_unknown: true`` and no
search terms. It answers only when the whole label is in the question and
explains all of it (question words and its page's words aside), never on one
shared word or on a question that is only part of the label, and only when no
generated or curated location matches at all. It is never the sole-control
answer to "<verb> button", and never answers with a label that is one word in
the locale it matched in ("Back", "Name"; for CJK, a label of at most two
characters such as 返回): one word on one page is not specific enough to name
that control rather than any other.

The auto tier is not in the committed index. Any new static-label button moves
it, so it is generated at BUILD time (``npm run build``) into the dashboard
bundle as ``static/dist/ui-index.auto.json`` (:data:`AUTO_INDEX_PATH`) and read
beside the committed index when present. It names the committed index it was
built against (``base_input_digest``); a missing, unreadable, malformed or
mismatched auto file leaves the committed tiers fully usable and says
``auto_tier: "unavailable"`` in every answer (a source checkout with no
frontend build, or a build from another revision).

A one-content-word search term ("get an app" once question words go) answers
only when said whole, never by sharing that word ("app settings").

:func:`browse_ui` is the other mode of the same tool: it lists one AREA (see
:data:`AREAS`) whole, paged under the same byte cap, so a question the search
misses can still be answered by choosing the entry that means it.

Labels come in the requested locale; the prerequisite prose (``description``,
``only_if``, ``otherwise``) is English only. A non-English answer carries
``prose_locale: "en"`` and says so, and the caller translates that prose for
the person (it is one table, ``website/src/uiLocations/conditions.ts``, kept in
one language on purpose: it states facts for the agent, not on-screen copy).
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: The committed index (generated + curated tiers). This and
#: :data:`AUTO_INDEX_PATH` are the only files read; nothing a tool caller
#: passes becomes a path.
INDEX_PATH = Path(__file__).resolve().parent / "docs" / "ui-index.generated.json"
#: The build-time auto tier, shipped inside the dashboard bundle (never
#: committed). Optional: absent in a source checkout with no frontend build.
AUTO_INDEX_PATH = Path(__file__).resolve().parent / "static" / "dist" / "ui-index.auto.json"
_AUTO_ARTIFACT = "auto"
_AUTO_AVAILABLE = "available"
_AUTO_UNAVAILABLE = "unavailable"
#: The longest CJK label that is still "one word" for the auto tier (返回, 名称).
_AUTO_CJK_ONE_WORD_MAX = 2
SCHEMA_VERSION = 1
MAX_RESULTS = 8
#: Ceiling on the serialized response (UTF-8), applied to whole records. It
#: must be at least the bytes of :data:`_TOO_BIG` (the fixed answer when even
#: one record does not fit), which carries no index metadata for that reason.
MAX_RESPONSE_BYTES = 6 * 1024
#: The packaged index is read whole; a file past this size is not read at all.
MAX_INDEX_BYTES = 4 * 1024 * 1024
QUERY_MAX_CHARS = 200
DEFAULT_LOCALE = "en"
#: The dashboard shell (the top bar): a placement there is on every page, so it
#: has no route and no parent path. Kept under any ``surface`` filter.
SHELL_SURFACE = "shell"
_LITERAL_PREFIX = "literal:"
#: ``label_kind`` of a location whose on-screen label is runtime data (the
#: model chip shows the model's name): its ``label_key`` is a static
#: description, returned as ``description`` and never as a label to quote.
_DESCRIPTION = "description"
_REQUIREMENT_KINDS = frozenset({"shown_by", "viewport", "preview_flag", "condition"})
#: ``tier`` of a location. ``generated`` (pages, tabs, settings) and ``curated``
#: (registered controls) are proven whole; ``auto`` is an unregistered control
#: whose label and page are proven from source but whose exact place and
#: prerequisites are not (it carries ``conditions_unknown: true``). An index
#: without the field is read as curated.
_CURATED = "curated"
_AUTO = "auto"
_TIERS = frozenset({"generated", _CURATED, _AUTO})
#: Match bases an auto location may answer with, and only at full coverage:
#: the whole label is in the question (question words aside). A question that
#: is only part of the label (``query_phrase``: "sign" inside "Open sign-in
#: page", whose other words are all question words) is never enough.
_AUTO_BASES = frozenset({"exact_label", "label_phrase"})
_FULL = 1.0 - 1e-9
_TOO_BIG: dict[str, Any] = {
    "status": "unavailable",
    "reason": "the best match does not fit the response limit",
    "results": [],
}

_LANG_RE = re.compile(r"\A[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?\Z")
_SURFACE_RE = re.compile(r"\A[a-z][a-z0-9-]{0,63}\Z")
_SPACE_RE = re.compile(r"\s+")

#: Question words that say nothing about WHICH location. They are dropped from
#: both the question and the label before coverage is measured, so "where are
#: my old chats" is about {old, chats}, and a label that explains one of the two
#: is not an answer. English always applies; a form in another space-separated
#: language also drops that language's list (never another language's, where
#: the same spelling can be a content word).
_STOPWORDS = frozenset(
    "a an the is are am be was were where wheres how do does did i me my mine we our "
    "can could should would to in on at of for from into with find found see show "
    "open get go look located location which what whats it its this that there here "
    "please you your option button setting settings page menu tab panel turn change "
    "switch need want have has".split()
)
_LOCALE_STOPWORDS: dict[str, frozenset[str]] = {
    code: frozenset(words.split())
    for code, words in {
        "es": "dónde donde está están esta estan cómo como mi mis tu tus el la los las un una "
        "de del en se puedo puede ver encontrar cambiar qué que es son hay por para",
        "fr": "où ou est sont comment mes mon ma le la les un une de des du dans je puis peux "
        "trouver voir changer quel quelle quels quelles qu que ce se trouve trouvent",
        "de": "wo ist sind wie meine mein meinen der die das den dem ein eine finde finden "
        "ich kann sehen ändern",
        "pt": "onde está estão esta estao como meus minhas meu minha o a os as um uma de do da "
        "em posso ver encontrar mudar fica ficam",
        "it": "dove è sono come miei mie mio mia il lo la i gli le un una di del della in "
        "posso trovare vedere cambiare trovo",
        "ru": "где мои мой моя мое моё находится находятся как найти посмотреть изменить можно "
        "я в на",
        "hi": "कहाँ कहां है हैं मेरी मेरा मेरे कैसे मैं को की का के में",
        "bn": "কোথায় আমার কীভাবে কিভাবে আছে আমি",
    }.items()
}
#: The same idea for CJK questions, removed as whole phrases (longest first)
#: from both sides before measuring phrase coverage. Single characters appear
#: only where they cannot be part of a label word in practice.
_CJK_STOP_PHRASES = tuple(
    sorted(
        {
            # zh
            "在哪里",
            "在哪儿",
            "在哪",
            "哪里",
            "哪儿",
            "怎么",
            "如何",
            "怎样",
            "我的",
            "找到",
            "查看",
            "打开",
            "可以",
            "的",
            "吗",
            "呢",
            "了",
            "请",
            "我",
            # Determiners: "this/these/that" in "copy this conversation".
            "这个",
            "这些",
            "那个",
            "那些",
            # ja
            "どこ",
            "ですか",
            "ありますか",
            "どうやって",
            "私の",
            "は",
            "の",
            "を",
            "に",
            # ko (multi-syllable only: single syllables are parts of words)
            "어디에",
            "어디",
            "있나요",
            "있어요",
            "어떻게",
            "나의",
        },
        key=lambda s: (-len(s), s),
    )
)
#: A candidate must explain at least this share of the question's content (and
#: the question this share of the label's): one shared word in a longer
#: question, or a generic word inside a longer label, is not an answer.
_MIN_COVERAGE = 0.6

#: Action verbs that name no object on their own. A question made only of
#: these ("add", "delete it", "删除") is about nothing in particular: the same
#: verb is a button in a dozen places, and answering with whichever label is an
#: exact match would be a confident guess. Matched on content tokens (question
#: words already dropped) for space-separated scripts, on the whole stripped
#: phrase for CJK.
_BARE_VERBS = frozenset(
    "add delete remove create new make edit update upgrade install uninstall close stop "
    "start run rename copy duplicate move enable disable save cancel clear refresh reload "
    "sync send upload download set reset mute unmute pin unpin select archive restore "
    "hide unhide expand collapse join leave connect disconnect share export import help".split()
)
_BARE_CJK_VERBS = frozenset(
    {
        "添加",
        "删除",
        "移除",
        "新建",
        "创建",
        "编辑",
        "修改",
        "更新",
        "升级",
        "安装",
        "卸载",
        "关闭",
        "停止",
        "开始",
        "运行",
        "重命名",
        "复制",
        "移动",
        "启用",
        "停用",
        "禁用",
        "保存",
        "取消",
        "清除",
        "清空",
        "刷新",
        "同步",
        "发送",
        "上传",
        "下载",
        "设置",
        "重置",
        "分享",
        "导出",
        "导入",
        "帮助",
    }
)
#: Words naming a kind of on-screen control ("the stop button"). With a bare
#: verb they say the question is about a control, never which one: see
#: :func:`_sole_control`.
_UI_NOUNS = frozenset({"button", "icon", "control"})
_CJK_UI_NOUNS = ("按钮", "图标", "按键")
#: Location kinds that are a control a person presses (not a page or a setting).
_CONTROL_KINDS = frozenset({"button", "menu-item", "toggle", "link", "disclosure"})
#: ``match`` of an answer found through :func:`_sole_control`.
_VERB_CONTROL_BASIS = "verb_control"
#: Said with every non-English answer: which fields stay English, and what to do.
_PROSE_NOTE = (
    "labels are in the requested language; translate description, only_if, otherwise"
    " and needs_object"
)
#: Wording returned with a bare-verb ``no_match`` (English, like all prose here).
_NEEDS_OBJECT = "the question names an action but not what it acts on; ask what to {verb}"

# Score bands. A candidate below _MIN_SCORE is dropped before any refinement,
# so a parent match can only reorder real target matches, never create one.
_SCORE_ID = 1000
_SCORE_EXACT = 900
_SCORE_LABEL_IN_QUERY = 700
_SCORE_QUERY_IN_LABEL = 600
_SCORE_ALL_TOKENS = 500
_SCORE_CJK_BIGRAMS = 400
_SCORE_MOST_TOKENS = 300
_MIN_SCORE = 300
_PARENT_BONUS = 40
#: Match basis of a form that explains part of the question while its path
#: explains the rest; only returned when nothing matches by its own words.
_PATH_BASIS = "tokens_with_path"


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x3040 <= o <= 0x30FF  # Hiragana, Katakana
        or 0x3400 <= o <= 0x4DBF
        or 0x4E00 <= o <= 0x9FFF
        or 0xF900 <= o <= 0xFAFF
        or 0xAC00 <= o <= 0xD7AF  # Hangul syllables
        or 0x1100 <= o <= 0x11FF
        or 0x3130 <= o <= 0x318F
    )


def normalize(text: str) -> str:
    """NFKC + casefold, every non letter/mark/number run collapsed to one space."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    kept = "".join(c if unicodedata.category(c)[0] in "LMN" else " " for c in folded)
    return _SPACE_RE.sub(" ", kept).strip()


#: "everything", "everywhere", "anything", "anywhere": one meaning for a search
#: ("search everything" is the "Search everywhere" button). Only these four:
#: "someone"/"somewhere" and the like say something else.
_ALL_WORDS = re.compile(r"\A(?:every|any)(?:thing|where)\Z")


def _stem(token: str) -> str:
    if _ALL_WORDS.match(token):
        return "every"
    if token.isascii() and len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


_stop_cache: dict[str, frozenset[str]] = {}


def _stopwords(locale: str) -> frozenset[str]:
    """English plus ``locale``'s question words, raw and stemmed (tokens are stemmed)."""
    hit = _stop_cache.get(locale)
    if hit is None:
        words = _STOPWORDS | _LOCALE_STOPWORDS.get(locale, frozenset())
        hit = frozenset(words | {_stem(w) for w in words})
        _stop_cache[locale] = hit
    return hit


def _strip_cjk(compact: str) -> str:
    for phrase in _CJK_STOP_PHRASES:
        compact = compact.replace(phrase, "")
    return compact


def _bare_verb(q: _Text, locale: str) -> str | None:
    """The verb when the question is only action verbs (no object), else None."""
    if q.cjk:
        return q.core if q.core in _BARE_CJK_VERBS else None
    if q.content and q.content <= _BARE_VERBS:
        return " ".join(tok for tok in q.tokens if tok in q.content)
    return None


def _noun_verb(q: _Text) -> str | None:
    """The one verb of a question that is that verb plus a control noun, else None.

    "stop button" and "停止按钮" qualify; "stop", "stop start button" and
    "stop the reply" do not (no noun, two verbs, a real object).
    """
    if q.cjk:
        for noun in _CJK_UI_NOUNS:
            if q.core.endswith(noun) and q.core[: -len(noun)] in _BARE_CJK_VERBS:
                return q.core[: -len(noun)]
        return None
    rest = q.content - _UI_NOUNS
    if len(rest) == 1 and rest <= _BARE_VERBS and _UI_NOUNS & set(q.tokens):
        return next(iter(rest))
    return None


def _sole_control(idx: _Index, verb: str, code: str) -> tuple[str, str | None] | None:
    """(location id, label key) of the ONE control whose own label starts with ``verb``.

    Only a control's label counts, never a search term or a setting: "stop"
    starts Stop generation alone, so "stop button" is that control; "delete"
    starts two labels, so "delete button" names nothing in particular.
    """
    hits: dict[str, str | None] = {}
    for loc_id, per in idx.texts.items():
        loc = idx.by_id[loc_id]
        # An auto entry never makes a control the sole answer: its place is unknown.
        if loc.get("kind") not in _CONTROL_KINDS or loc.get("tier") == _AUTO:
            continue
        for t in per.get(code, []):
            if t.term:
                continue
            if t.compact.startswith(verb) if t.cjk else t.tokens[:1] == (verb,):
                hits.setdefault(loc_id, t.key)
    if len(hits) != 1:
        return None
    return next(iter(hits.items()))


def _bigrams(compact: str) -> frozenset[str]:
    return frozenset(compact[i : i + 2] for i in range(len(compact) - 1))


def _one_word(t: _Text) -> bool:
    """Whether a label form is one word, so an AUTO entry may not answer with it.

    Space-separated scripts: one token after folding ("Back", "Name", "Save";
    "Sign-in" is two). CJK, which has no spaces to count: a label of at most
    :data:`_AUTO_CJK_ONE_WORD_MAX` characters (返回, 名称, 名前), the length
    of a single common word. A one-word label on one page names one of many
    look-alike controls, and an auto entry has nothing else (no terms, no
    place) to tell them apart; generated and curated locations are not
    affected.
    """
    if t.cjk:
        return len(t.compact) <= _AUTO_CJK_ONE_WORD_MAX
    return len(t.tokens) <= 1


@dataclass(frozen=True)
class _Text:
    """One searchable form (a label or a curated search term) in one locale.

    ``content`` is the token set minus that locale's question words and
    ``core`` the CJK compact form minus question phrases: what coverage is
    measured on.
    """

    norm: str
    compact: str
    cjk: bool
    tokens: tuple[str, ...]
    content: frozenset[str]
    core: str
    term: bool = False
    #: The catalog key a label form came from (None for a search term).
    key: str | None = None

    @classmethod
    def of(
        cls, raw: str, locale: str = DEFAULT_LOCALE, *, term: bool = False, key: str | None = None
    ) -> _Text:
        norm = normalize(raw)
        compact = norm.replace(" ", "")
        cjk = any(_is_cjk(c) for c in compact)
        tokens = tuple(_stem(t) for t in norm.split(" ") if t)
        stop = _stopwords(locale)
        content = frozenset(t for t in tokens if t not in stop)
        core = _strip_cjk(compact)
        return cls(norm, compact, cjk, tokens, content, core, term, key)


def _contains_run(haystack: tuple[str, ...], needle: tuple[str, ...]) -> bool:
    if not needle or len(needle) > len(haystack):
        return False
    n = len(needle)
    return any(haystack[i : i + n] == needle for i in range(len(haystack) - n + 1))


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def _ratio(part: str, whole: str) -> float:
    """Share of ``whole`` that ``part`` (a substring of it) explains."""
    return 1.0 if not whole else min(1.0, len(part) / len(whole))


def _cjk_rest(q: _Text, t: _Text, context: tuple[_Text, ...]) -> float:
    """Share of the CJK question the label explains, once the phrases its
    ancestors explain are taken out of the question."""
    rest = q.core
    if t.core and t.core in rest:
        head, _, tail = rest.partition(t.core)
        for c in context:
            if len(c.core) >= 2 and c.core not in t.core:
                head, tail = head.replace(c.core, "", 1), tail.replace(c.core, "", 1)
        rest = head + t.core + tail
    return _ratio(t.core, rest)


def _score(
    q: _Text, t: _Text, *, phrase_only: bool, context: tuple[_Text, ...] = ()
) -> tuple[int, str, float]:
    """(score, basis, coverage). ``q`` must be built for ``t``'s locale.

    The score comes from the form ``t`` alone: a location must match by its own
    label or term. ``context`` (the labels of the location's ancestors in the
    path) only helps coverage, so "voice model" is fully explained by Voice >
    Model while "chat about dinner" stays unexplained. Coverage is how much of
    the question the form and its ancestors explain, and how much of the form
    the question explains; a match below :data:`_MIN_COVERAGE` is never
    returned, whatever its score.
    """
    if not t.norm:
        return 0, "", 0.0
    if q.norm == t.norm:
        return _SCORE_EXACT, "exact_label", 1.0
    if t.cjk or q.cjk:
        if len(t.compact) >= 2 and t.compact in q.compact:
            return (
                _SCORE_LABEL_IN_QUERY + min(len(t.compact), 50),
                "label_phrase",
                _cjk_rest(q, t, context),
            )
        if len(q.compact) >= 2 and q.compact in t.compact:
            return _SCORE_QUERY_IN_LABEL, "query_phrase", _ratio(q.core, t.core)
        t_grams, q_grams = _bigrams(t.core), _bigrams(q.core)
        if t.cjk and not phrase_only and len(t_grams) >= 2:
            covered = len(t_grams & q_grams) / len(t_grams)
            if covered >= 0.75:
                return (
                    _SCORE_CJK_BIGRAMS + int(covered * 50),
                    "phrase_overlap",
                    _jaccard(t_grams, q_grams),
                )
        return 0, "", 0.0
    # Words an ancestor's label explains leave the question before coverage is
    # measured; every other question word must still be explained by the form.
    ancestors: frozenset[str] = frozenset().union(*(c.content for c in context))
    coverage = _jaccard(q.content - (ancestors - t.content), t.content)
    # When the form and its path together explain EVERY question word ("import
    # an artifact": Import from a file, under Artifacts), the path's words also
    # count on the form's side, so a form's own extra word ("file") does not
    # sink it. A question word nobody explains ("dinner") keeps the strict share.
    by_path = (ancestors & q.content) - t.content
    if by_path and q.content <= t.content | by_path:
        coverage = max(coverage, _jaccard(q.content, t.content | by_path))
    q_content = tuple(tok for tok in q.tokens if tok in q.content)
    if len(t.norm) >= 3 and _contains_run(q.tokens, t.tokens):
        return _SCORE_LABEL_IN_QUERY + min(len(t.norm), 50), "label_phrase", coverage
    if q_content and len(" ".join(q_content)) >= 3 and _contains_run(t.tokens, q_content):
        return _SCORE_QUERY_IN_LABEL, "query_phrase", coverage
    if phrase_only or not t.content:
        return 0, "", 0.0
    matched = len(t.content & q.content)
    if matched == len(t.content):
        return _SCORE_ALL_TOKENS + 10 * matched, "tokens", coverage
    if matched >= 2 and matched / len(t.content) >= 0.6:
        return _SCORE_MOST_TOKENS + 10 * matched, "tokens", coverage
    # The form matches part of the question and the path the rest ("Import from
    # a file" under Artifacts for "import an artifact"). The form must still
    # carry a question word and at least half of its own words: the path only
    # completes a match, it never makes one.
    if (
        matched >= 1
        and by_path
        and q.content <= t.content | by_path
        and matched / len(t.content) >= 0.5
    ):
        return _SCORE_MOST_TOKENS + 10 * matched, _PATH_BASIS, coverage
    return 0, "", 0.0


@dataclass
class _Index:
    raw: dict[str, Any]
    by_id: dict[str, dict[str, Any]]
    locales: tuple[str, ...]
    surfaces: frozenset[str]
    labels: dict[str, dict[str, str]]
    #: location id -> locale -> searchable forms (label, aliases, then search terms).
    texts: dict[str, dict[str, list[_Text]]] = field(default_factory=dict)
    conditions: dict[str, str] = field(default_factory=dict)
    reveal_states: dict[str, str] = field(default_factory=dict)
    #: (location id, locale) -> its ancestors' label forms, built on first use.
    contexts: dict[tuple[str, str], tuple[_Text, ...]] = field(default_factory=dict)
    #: Whether the build-time auto tier was merged in, and why not.
    auto_status: str = _AUTO_UNAVAILABLE
    auto_reason: str | None = "no auto tier file was read"
    auto_scope: str | None = None


_cache: dict[str, Any] = {"key": None, "index": None}


class IndexUnavailable(Exception):
    """The packaged index is missing, unreadable, malformed or of an unknown schema."""


class AutoTierUnavailable(Exception):
    """The auto-tier artifact cannot be used; the committed index still answers."""


def _str_map(value: Any, what: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in value.items()
    ):
        raise IndexUnavailable(f"malformed {what}")
    return value


def _str_list(value: Any, what: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise IndexUnavailable(f"malformed {what}")
    return value


def _check_location(
    loc: dict[str, Any],
    ids: set[str],
    english: dict[str, str],
    reveal_states: dict[str, str],
    shell_ids: set[str],
    described: set[str],
    conditions: dict[str, str],
) -> None:
    """Every field the search and the records read, with every reference resolved.

    Raises :class:`IndexUnavailable` on the first problem: a structurally broken
    index is reported as unavailable, never answered from partially.
    """
    key = loc.get("label_key")
    if not isinstance(key, str) or not (key.startswith(_LITERAL_PREFIX) or key in english):
        raise IndexUnavailable("location label is missing")
    if not isinstance(loc.get("kind"), str):
        raise IndexUnavailable("malformed location")
    tier = loc.get("tier", _CURATED)
    if tier not in _TIERS:
        raise IndexUnavailable("unknown location tier")
    if "conditions_unknown" in loc and loc["conditions_unknown"] is not True:
        raise IndexUnavailable("malformed location")
    if tier == _AUTO and (loc.get("conditions_unknown") is not True or "terms" in loc):
        # An auto entry is searchable by its label alone and never claims to
        # know its prerequisites: a curated term or a missing flag is a broken index.
        raise IndexUnavailable("malformed auto location")
    if loc.get("label_kind", _DESCRIPTION) != _DESCRIPTION:
        raise IndexUnavailable("unknown label kind")
    for k in _str_list(loc.get("alias_keys", []), "alias keys"):
        if not (k.startswith(_LITERAL_PREFIX) or k in english):
            raise IndexUnavailable("location alias label is missing")
    if "setting_id" in loc and not isinstance(loc["setting_id"], str):
        raise IndexUnavailable("malformed location")
    if "guide_ref" in loc and not isinstance(loc["guide_ref"], dict):
        raise IndexUnavailable("malformed guide binding")
    if "state_labels" in loc:
        states = loc["state_labels"]
        own = {key, *loc.get("alias_keys", [])}
        if (
            not isinstance(states, list)
            or len(states) < 2
            or not all(
                isinstance(s, dict)
                and s.get("label_key") in own
                and isinstance(s.get("when"), str)
                and (s["when"] in conditions or s["when"] in reveal_states)
                for s in states
            )
        ):
            raise IndexUnavailable("malformed state labels")
    placements = loc.get("placements")
    if not isinstance(placements, list) or not placements:
        raise IndexUnavailable("location has no placements")
    for p in placements:
        if not isinstance(p, dict):
            raise IndexUnavailable("malformed placement")
        route = p.get("route")
        if not isinstance(p.get("surface_id"), str) or not isinstance(p.get("entry_kind"), str):
            raise IndexUnavailable("malformed placement")
        parent_ids = _str_list(p.get("parent_ids"), "placement path")
        if not all(pid in ids for pid in parent_ids):
            raise IndexUnavailable("placement path names an unknown location")
        if any(pid in described for pid in parent_ids):
            raise IndexUnavailable("placement path names a location with no label")
        if p["surface_id"] == SHELL_SURFACE:
            # Shell chrome is drawn on every page: no route, and a path only
            # through other shell chrome (the phone menu button), never a page.
            if route != "" or not all(pid in shell_ids for pid in parent_ids):
                raise IndexUnavailable("malformed shell placement")
        elif not isinstance(route, str) or not route.startswith("/"):
            raise IndexUnavailable("placement has no route")
        requires = p.get("requires")
        if not isinstance(requires, list):
            raise IndexUnavailable("malformed requirements")
        for r in requires:
            if not isinstance(r, dict) or r.get("kind") not in _REQUIREMENT_KINDS:
                raise IndexUnavailable("malformed requirement")
            if r["kind"] in ("shown_by", "preview_flag") and r.get("location") not in ids:
                raise IndexUnavailable("requirement names an unknown location")
            if r["kind"] == "shown_by" and r["location"] in described:
                raise IndexUnavailable("requirement names a location with no label")
            if "when" in r and r["when"] not in reveal_states:
                raise IndexUnavailable("requirement names an unknown reveal state")
            if r["kind"] == "condition" and not isinstance(r.get("id"), str):
                raise IndexUnavailable("malformed requirement")


def _parse(raw: Any) -> _Index:
    if not isinstance(raw, dict) or raw.get("schema_version") != SCHEMA_VERSION:
        raise IndexUnavailable("unsupported index schema")
    locations, labels, locales = raw.get("locations"), raw.get("labels"), raw.get("locales")
    if (
        not isinstance(locations, list)
        or not isinstance(labels, dict)
        or not isinstance(locales, list)
    ):
        raise IndexUnavailable("malformed index")
    if DEFAULT_LOCALE not in labels:
        raise IndexUnavailable("index has no English labels")
    for name, table in labels.items():
        _str_map(table, f"labels for {name!r:.20}")
    _str_list(locales, "locales")
    _str_list(raw.get("surfaces") or [], "surfaces")
    conditions = _str_map(raw.get("conditions"), "conditions")
    reveal_states = _str_map(raw.get("reveal_states"), "reveal states")
    by_id: dict[str, dict[str, Any]] = {}
    for loc in locations:
        if not isinstance(loc, dict) or not isinstance(loc.get("id"), str) or not loc["id"]:
            raise IndexUnavailable("malformed location")
        if loc["id"] in by_id:
            raise IndexUnavailable("duplicate location id")
        by_id[loc["id"]] = loc
    ids = set(by_id)
    shell_ids = {
        loc_id
        for loc_id, loc in by_id.items()
        if isinstance(loc.get("placements"), list)
        and loc["placements"]
        and all(
            isinstance(p, dict) and p.get("surface_id") == SHELL_SURFACE for p in loc["placements"]
        )
    }
    described = {loc_id for loc_id, loc in by_id.items() if loc.get("label_kind") == _DESCRIPTION}
    for loc in locations:
        if loc.get("tier") == _AUTO:
            # The auto tier is a build-time artifact (AUTO_INDEX_PATH); the
            # committed index carrying it would mean two sources for one tier.
            raise IndexUnavailable("the committed index carries auto entries")
        _check_location(
            loc, ids, labels[DEFAULT_LOCALE], reveal_states, shell_ids, described, conditions
        )
    idx = _Index(
        raw=raw,
        by_id=by_id,
        locales=tuple(locales),
        surfaces=frozenset(raw.get("surfaces") or []),
        labels={str(k): v for k, v in labels.items()},
        conditions=conditions,
        reveal_states=reveal_states,
    )
    for loc_id, loc in by_id.items():
        idx.texts[loc_id] = _forms(idx.labels, loc)
    return idx


def _forms(labels: dict[str, dict[str, str]], loc: dict[str, Any]) -> dict[str, list[_Text]]:
    """A location's searchable forms per locale: label, aliases, then search terms."""
    keys = [loc["label_key"], *[k for k in loc.get("alias_keys") or [] if isinstance(k, str)]]
    terms = loc.get("terms") or {}
    if not isinstance(terms, dict) or not all(
        isinstance(v, list) and all(isinstance(x, str) for x in v) for v in terms.values()
    ):
        raise IndexUnavailable("malformed search terms")
    per_locale: dict[str, list[_Text]] = {}
    for locale in labels:
        forms = [
            _Text.of(t, locale, key=k) for k, t in ((k, labels[locale].get(k)) for k in keys) if t
        ]
        forms += [_Text.of(t, locale, term=True) for t in terms.get(locale, []) if t.strip()]
        if forms:
            per_locale[locale] = forms
    return per_locale


def _attach_auto(idx: _Index, raw: Any) -> None:
    """Merge a build-time auto-tier artifact into ``idx``, or raise without touching it.

    Every check runs before anything is merged, so a refused artifact leaves
    the committed index exactly as parsed. The artifact must name this
    committed index (``base_input_digest``), ship the same locales, add only
    ``tier: auto`` entries (same per-entry validation as any location) whose
    paths run through committed pages and tabs, and add labels only for keys
    the committed index does not already define differently.
    """
    if (
        not isinstance(raw, dict)
        or raw.get("schema_version") != SCHEMA_VERSION
        or raw.get("artifact") != _AUTO_ARTIFACT
    ):
        raise AutoTierUnavailable("unsupported auto tier schema")
    if raw.get("base_input_digest") != idx.raw.get("input_digest"):
        raise AutoTierUnavailable("auto tier was built against a different index")
    locations, labels, locales = raw.get("locations"), raw.get("labels"), raw.get("locales")
    if (
        not isinstance(locations, list)
        or not isinstance(labels, dict)
        or locales != list(idx.locales)
    ):
        raise AutoTierUnavailable("malformed auto tier")
    try:
        merged: dict[str, dict[str, str]] = {}
        for locale, table in idx.labels.items():
            extra = _str_map(labels.get(locale), "auto labels")
            for k, v in extra.items():
                if table.get(k, v) != v:
                    raise AutoTierUnavailable("auto tier relabels a committed key")
            merged[locale] = {**table, **extra}
        if set(labels) - set(idx.labels):
            raise AutoTierUnavailable("auto tier has labels for an unknown locale")
        new: dict[str, dict[str, Any]] = {}
        for loc in locations:
            if not isinstance(loc, dict) or not isinstance(loc.get("id"), str) or not loc["id"]:
                raise AutoTierUnavailable("malformed auto location")
            if loc["id"] in idx.by_id or loc["id"] in new:
                raise AutoTierUnavailable("duplicate location id")
            if loc.get("tier") != _AUTO:
                raise AutoTierUnavailable("auto tier carries a non-auto location")
            new[loc["id"]] = loc
        committed = set(idx.by_id)
        described = {i for i, loc in idx.by_id.items() if loc.get("label_kind") == _DESCRIPTION}
        # An auto entry may be ON the shell (a control only the app shell draws:
        # no route, no path) but never hangs under shell chrome.
        shell_ids: set[str] = set()
        for loc in new.values():
            _check_location(
                loc,
                committed,
                merged[DEFAULT_LOCALE],
                idx.reveal_states,
                shell_ids,
                described,
                idx.conditions,
            )
        texts = {loc_id: _forms(merged, loc) for loc_id, loc in new.items()}
    except IndexUnavailable as exc:
        raise AutoTierUnavailable(str(exc)) from exc
    idx.labels = merged
    idx.by_id.update(new)
    idx.texts.update(texts)
    idx.contexts.clear()
    cov = raw.get("coverage")
    idx.auto_scope = cov.get("scope") if isinstance(cov, dict) else None
    idx.auto_status, idx.auto_reason = _AUTO_AVAILABLE, None


def _stat_key(target: Path) -> tuple[str, int, int] | None:
    try:
        st = target.stat()
    except OSError:
        return None
    return (str(target), st.st_mtime_ns, st.st_size)


def _read_auto(idx: _Index, target: Path | None) -> None:
    """Merge the auto tier from ``target`` when it is there and sound; else say why not."""
    if target is None:
        idx.auto_reason = "no auto tier file was read"
        return
    try:
        st = target.stat()
    except OSError:
        idx.auto_reason = "no auto tier in this install (the dashboard bundle was not built)"
        return
    try:
        if st.st_size > MAX_INDEX_BYTES:
            raise AutoTierUnavailable("auto tier file is too large")
        try:
            raw = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise AutoTierUnavailable("auto tier file is unreadable") from exc
        _attach_auto(idx, raw)
    except AutoTierUnavailable as exc:
        # The committed tiers still answer; only the auto entries are missing.
        logger.warning("find_ui auto tier unavailable: %s", exc)
        idx.auto_reason = str(exc)


def load_index(path: Path | None = None, auto_path: Path | None = None) -> _Index:
    """The parsed index, cached per (file, mtime, size) of both files; one entry, process-wide.

    ``auto_path`` defaults to :data:`AUTO_INDEX_PATH` only when ``path`` does
    too: an explicit committed index (a test, a scratch build) is read with
    the auto tier the caller names, or none. The cache holds packaged build
    data only, never anything about a caller.
    """
    target = path or INDEX_PATH
    auto_target = (
        auto_path if auto_path is not None else (AUTO_INDEX_PATH if path is None else None)
    )
    key = _stat_key(target)
    if key is None:
        raise IndexUnavailable("index file is missing")
    full_key = (key, _stat_key(auto_target) if auto_target is not None else None)
    if _cache["key"] == full_key and _cache["index"] is not None:
        return _cache["index"]  # type: ignore[no-any-return]
    if key[2] > MAX_INDEX_BYTES:
        raise IndexUnavailable("index file is too large")
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise IndexUnavailable("index file is unreadable") from exc
    idx = _parse(raw)
    _read_auto(idx, auto_target)
    _cache["key"], _cache["index"] = full_key, idx
    return idx


def _resolve_locale(lang: str | None, available: tuple[str, ...]) -> tuple[str, str]:
    """(resolved locale, source): ``requested`` when shipped, else English ``fallback``."""
    if not lang:
        return DEFAULT_LOCALE, "fallback"
    want = lang.replace("_", "-").casefold()
    exact = [code for code in available if code.casefold() == want]
    if exact:
        return exact[0], "requested"
    base = want.split("-")[0]
    prefixed = [code for code in available if code.casefold().split("-")[0] == base]
    if len(prefixed) == 1:
        return prefixed[0], "requested"
    return DEFAULT_LOCALE, "fallback"


def _label(idx: _Index, key: str, locale: str) -> str:
    if key.startswith(_LITERAL_PREFIX):
        return key[len(_LITERAL_PREFIX) :]
    return idx.labels.get(locale, {}).get(key) or idx.labels[DEFAULT_LOCALE].get(key) or key


def _loc_label(idx: _Index, loc_id: str, locale: str) -> str:
    loc = idx.by_id.get(loc_id)
    return _label(idx, loc["label_key"], locale) if loc else loc_id


def _guidable(setting_id: str) -> bool:
    from kiro_crew.guide_catalog import guidable_settings

    return setting_id in guidable_settings()


def _guide_ref_ok(ref: dict[str, Any]) -> bool:
    """Whether the gateway's guide catalog accepts this binding, params included."""
    from kiro_crew.guide_catalog import GuideCatalogError, validate_actions

    params = ref.get("params", {})
    try:
        validate_actions([{"id": ref.get("action_id"), "params": params}])
    except (GuideCatalogError, TypeError, ValueError):
        return False
    return True


def _viewport(requires: list[dict[str, Any]]) -> Any:
    return next((r.get("value") for r in requires if r.get("kind") == "viewport"), None)


def _where(placement: dict[str, Any]) -> dict[str, Any]:
    """The placement's route, or ``on_every_page`` for the shell (no route there)."""
    if placement.get("surface_id") == SHELL_SURFACE:
        return {"on_every_page": True}
    return {"route": placement["route"]}


def _on_surface(placement: dict[str, Any], surface: str) -> bool:
    """Whether a placement is drawn on ``surface``: its own, or the shell's (everywhere)."""
    return placement.get("surface_id") in (surface, SHELL_SURFACE)


def _requirement(
    idx: _Index, req: dict[str, Any], locale: str, viewport: Any = None, depth: int = 0
) -> dict[str, Any]:
    kind = req.get("kind")
    if kind in ("shown_by", "preview_flag"):
        target = idx.by_id.get(str(req.get("location")))
        out: dict[str, Any] = {"kind": kind}
        if target:
            placements = target["placements"]
            # The revealing control's placement for the same viewport, so its own
            # qualifications ("desktop only", "with open sessions") travel along.
            placement = next(
                (p for p in placements if _viewport(p["requires"]) in (None, viewport)),
                placements[0],
            )
            out["label"] = _label(idx, target["label_key"], locale)
            out["path"] = [_loc_label(idx, p, locale) for p in placement["parent_ids"]] + [
                out["label"]
            ]
            out.update(_where(placement))
            if target.get("setting_id"):
                out["setting_id"] = target["setting_id"]
            if kind == "shown_by" and depth < 2:
                own = [
                    _requirement(idx, r, locale, viewport, depth + 1)
                    for r in placement["requires"]
                    if r.get("kind") != "viewport"
                ]
                if own:
                    out["requires"] = own
        when = req.get("when")
        if kind == "shown_by" and isinstance(when, str):
            # A conditional step: only while this state holds; otherwise the
            # target is already on screen and the step is skipped.
            out["when"] = when
            out["only_if"] = idx.reveal_states.get(when, when)
            out["otherwise"] = "already visible; skip this step"
        return out
    if kind == "viewport":
        return {"kind": kind, "value": req.get("value")}
    cid = req.get("id")
    out = {"kind": kind, "id": cid}
    if isinstance(cid, str) and cid in idx.conditions:
        out["description"] = idx.conditions[cid]
    return out


def _state_text(idx: _Index, when: str) -> str:
    return idx.conditions.get(when) or idx.reveal_states.get(when) or when


def _state_key(
    idx: _Index, loc: dict[str, Any], queries: list[_Text], matched_key: str | None
) -> str | None:
    """Which of a flipping label's keys the question is about.

    The label sharing the most words (CJK: two-character runs) with the question
    wins: "collapse the navigation" is asked while the rail shows Collapse, "切换
    看板" while the list shows 切换到看板视图. A tie keeps the label the question
    matched, else the primary one.
    """
    best: tuple[int, str | None] = (0, None)
    for s in loc.get("state_labels") or []:
        overlap = 0
        for q in queries:
            for code in dict.fromkeys((DEFAULT_LOCALE, *idx.labels)):
                text = idx.labels.get(code, {}).get(s["label_key"])
                if not text:
                    continue
                t = _Text.of(text, code)
                n = (
                    len(_bigrams(t.core) & _bigrams(q.core))
                    if (t.cjk or q.cjk)
                    else len(t.content & q.content)
                )
                overlap = max(overlap, n)
        if overlap > best[0]:
            best = (overlap, s["label_key"])
        elif overlap == best[0] and overlap and s["label_key"] == matched_key:
            best = (overlap, matched_key)
    return best[1] or matched_key


def _record(
    idx: _Index,
    loc: dict[str, Any],
    placements: list[dict[str, Any]],
    locale: str,
    basis: str,
    matched_key: str | None = None,
) -> dict[str, Any]:
    states = loc.get("state_labels") or []
    # A flipping label answers with the state the question named ("switch to
    # list view" -> the label shown in board view); otherwise the primary one.
    shown_key = (
        matched_key
        if matched_key and any(s["label_key"] == matched_key for s in states)
        else loc["label_key"]
    )
    text = _label(idx, shown_key, locale)
    # A description says what the control is; it is never its on-screen label.
    shown = {_DESCRIPTION: text} if loc.get("label_kind") == _DESCRIPTION else {"label": text}
    rec: dict[str, Any] = {
        "id": loc["id"],
        "kind": loc.get("kind"),
        **shown,
        "placements": [
            {
                "path": [
                    {
                        "role": "navigation",
                        "label": _loc_label(idx, pid, locale),
                        "id": pid,
                    }
                    for pid in p["parent_ids"]
                ]
                + [{"role": "target", **shown, "id": loc["id"]}],
                **_where(p),
                "entry": p.get("entry_kind"),
                "requires": [
                    _requirement(idx, r, locale, _viewport(p["requires"])) for r in p["requires"]
                ],
            }
            for p in placements
        ],
        "availability": "not_observed",
        "match": basis,
    }
    if loc.get("tier") == _AUTO:
        # A control with this label is drawn on this page; where on it, and
        # what must be true for it to show, is not known (see find_ui's doc).
        rec["tier"] = _AUTO
        rec["conditions_unknown"] = True
    if states:
        rec["label_by_state"] = [
            {
                "label": _label(idx, s["label_key"], locale),
                "when": s["when"],
                "only_if": _state_text(idx, s["when"]),
            }
            for s in states
        ]
    sid = loc.get("setting_id")
    if sid:
        rec["setting_id"] = sid
        if _guidable(sid):
            rec["guide_ref"] = {"action_id": "settings.show", "params": {"setting_id": sid}}
    elif isinstance(loc.get("guide_ref"), dict) and _guide_ref_ok(loc["guide_ref"]):
        # Checked here as well as at generation: a binding the catalog refuses
        # (an unknown action, or a sensitive setting) is never handed out.
        rec["guide_ref"] = loc["guide_ref"]
    return rec


def _envelope(idx: _Index | None, status: str, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"status": status}
    if idx is not None:
        out["schema_version"] = idx.raw.get("schema_version")
        out["input_digest"] = idx.raw.get("input_digest")
        cov = idx.raw.get("coverage")
        if isinstance(cov, dict) and isinstance(cov.get("scope"), str):
            out["coverage"] = cov["scope"]
            if idx.auto_status == _AUTO_AVAILABLE and idx.auto_scope:
                out["coverage"] += f"; plus {idx.auto_scope}"
        # Whether unregistered (auto-indexed) controls could answer at all: a
        # no_match with the tier unavailable says less than one with it.
        out["auto_tier"] = idx.auto_status
        if idx.auto_status != _AUTO_AVAILABLE and idx.auto_reason:
            out["auto_tier_reason"] = idx.auto_reason
    out.update(extra)
    return out


def _size(obj: dict[str, Any]) -> int:
    return len(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8"))


def find_ui(
    query: str,
    lang: str | None = None,
    surface: str | None = None,
    *,
    path: Path | None = None,
    auto_path: Path | None = None,
) -> dict[str, Any]:
    """Search the packaged location index. See the module docstring for scope."""
    q_raw = (query or "").strip()
    if not q_raw:
        return {"error": "give a nonblank 'query'"}
    if len(q_raw) > QUERY_MAX_CHARS:
        return {"error": f"'query' is longer than {QUERY_MAX_CHARS} characters"}
    if lang is not None and lang != "" and not _LANG_RE.match(lang):
        return {"error": "'lang' must be a language tag such as 'en' or 'zh-CN'"}
    if surface is not None and surface != "" and not _SURFACE_RE.match(surface):
        return {"error": "'surface' must be a surface id such as 'chat' or 'settings'"}
    try:
        idx = load_index(path, auto_path)
    except IndexUnavailable as exc:
        logger.warning("find_ui index unavailable: %s", exc)
        return _envelope(None, "unavailable", reason=str(exc), results=[])
    if surface and surface not in idx.surfaces:
        return {"error": f"unknown surface '{surface}'; known: {', '.join(sorted(idx.surfaces))}"}

    locale, locale_source = _resolve_locale(lang or None, tuple(idx.labels))
    meta = {
        "requested_locale": lang or None,
        "resolved_locale": locale,
        "locale_source": locale_source,
    }
    queries = {code: _Text.of(q_raw, code) for code in idx.labels}
    if locale != DEFAULT_LOCALE:
        # Labels are localized; the prerequisite prose is not (see module doc).
        meta["prose_locale"] = DEFAULT_LOCALE
        meta["prose_note"] = _PROSE_NOTE
    verb = _bare_verb(queries[locale], locale) or _bare_verb(queries[DEFAULT_LOCALE], locale)
    for code in dict.fromkeys((locale, DEFAULT_LOCALE)):
        noun_verb = _noun_verb(queries[code])
        if noun_verb is None:
            continue
        sole = _sole_control(idx, noun_verb, code)
        if sole is not None:
            loc = idx.by_id[sole[0]]
            placements = [p for p in loc["placements"] if not surface or _on_surface(p, surface)]
            if placements:
                resp = _envelope(idx, "ok", **meta, ambiguous=False, truncated=False, results=[])
                resp["results"].append(
                    _record(idx, loc, placements, locale, _VERB_CONTROL_BASIS, sole[1])
                )
                return resp if _size(resp) <= MAX_RESPONSE_BYTES else {**_TOO_BIG, "results": []}
        verb = verb or noun_verb
        break
    if verb is not None:
        return _envelope(
            idx,
            "no_match",
            **meta,
            needs_object=_NEEDS_OBJECT.format(verb=verb),
            truncated=False,
            results=[],
        )
    searched = [locale] if locale == DEFAULT_LOCALE else [locale, DEFAULT_LOCALE]
    # With no locale named, other shipped languages still count for whole-phrase
    # matches, so a localized question finds its control; labels stay English.
    phrase_locales = [code for code in idx.labels if code not in searched] if not lang else []

    scored: list[tuple[int, str, str]] = []
    matched: dict[str, str | None] = {}
    for loc_id, loc in idx.by_id.items():
        best, basis, best_key = 0, "", None
        auto = loc.get("tier") == _AUTO
        if q_raw.casefold() in (loc_id.casefold(), str(loc.get("setting_id") or "").casefold()):
            best, basis = _SCORE_ID, "id"
        else:
            forms = idx.texts.get(loc_id, {})
            ancestor_ids = list(
                dict.fromkeys(pid for p in loc["placements"] for pid in p["parent_ids"])
            )
            for code in searched + phrase_locales:
                code_forms = forms.get(code, [])
                if auto:
                    # A one-word label never answers (see _one_word). Then a
                    # cheap necessary condition for a full-coverage match, so
                    # the many auto entries cost a set test, not a score.
                    q = queries[code]
                    code_forms = [
                        t
                        for t in code_forms
                        if not _one_word(t)
                        and (
                            t.compact in q.compact
                            if (t.cjk or q.cjk)
                            else (t.content and t.content <= q.content)
                        )
                    ]
                if not code_forms:
                    continue
                # The ancestors' labels, in this locale or else English: words
                # the path explains ("Voice" in "voice model") count toward
                # coverage, never toward the score.
                context = idx.contexts.get((loc_id, code))
                if context is None:
                    context = idx.contexts[(loc_id, code)] = tuple(
                        t
                        for pid in ancestor_ids
                        for t in (
                            idx.texts.get(pid, {}).get(code)
                            or idx.texts.get(pid, {}).get(DEFAULT_LOCALE, [])
                        )
                        if not t.term
                    )
                for t in code_forms:
                    s, b, coverage = _score(
                        queries[code], t, phrase_only=code in phrase_locales, context=context
                    )
                    # A form that explains too little of the question (or the
                    # question too little of it) is no answer, however high it
                    # would rank: one shared word must not come back as "ok".
                    if coverage < _MIN_COVERAGE:
                        continue
                    # A search term that is ONE content word once question words
                    # are dropped ("get an app" is {app}) answers only when it is
                    # said whole: otherwise every question about that one word
                    # ("app settings": {app}) would be confidently this location.
                    if (
                        t.term
                        and not t.cjk
                        and len(t.content) == 1
                        and b not in ("exact_label", "label_phrase")
                    ):
                        continue
                    # An auto entry answers only when the question IS its label
                    # (question words and its page's words aside): a partial or
                    # one-word overlap could name any of many similar controls.
                    if auto and (
                        b not in _AUTO_BASES
                        or coverage < _FULL
                        or not (t.core if t.cjk else t.content)
                    ):
                        continue
                    if s > best:
                        best, basis, best_key = s, b, t.key
                        if b != _PATH_BASIS and t.term:
                            basis = "search_term"
                        elif b != _PATH_BASIS and loc.get("label_kind") == _DESCRIPTION:
                            basis = _DESCRIPTION
        if best < _MIN_SCORE:
            continue
        placements = loc["placements"]
        if surface:
            placements = [p for p in placements if _on_surface(p, surface)]
            if not placements:
                continue
        for pid in placements[0].get("parent_ids") or []:
            for code in searched:
                q = queries[code]
                if any(
                    (len(t.compact) >= 2 and _contains_run(q.tokens, t.tokens))
                    or (t.cjk and t.compact in q.compact)
                    for t in idx.texts.get(pid, {}).get(code, [])
                    if not t.term
                ):
                    best += _PARENT_BONUS
                    break
        scored.append((best, loc_id, basis))
        matched[loc_id] = best_key

    if not scored:
        return _envelope(idx, "no_match", **meta, truncated=False, results=[])
    # The auto tier is a fallback, like a path-completed match: any generated or
    # curated location that answers outranks every auto entry, so an auto entry
    # is returned only when nothing proven whole matches.
    if any(idx.by_id[i].get("tier") != _AUTO for _s, i, _b in scored):
        scored = [r for r in scored if idx.by_id[r[1]].get("tier") != _AUTO]
    # A path-completed match is a fallback: it answers only when no location
    # matches the question by its own words ("chat model" is Chat > Models,
    # not every model setting under Chat).
    if any(basis != _PATH_BASIS for _s, _i, basis in scored):
        scored = [r for r in scored if r[2] != _PATH_BASIS]
    scored.sort(key=lambda r: (-r[0], r[1]))
    top = scored[0][0]
    resp = _envelope(
        idx,
        "ok",
        **meta,
        ambiguous=len(scored) > 1 and scored[1][0] == top,
        truncated=False,
        results=[],
    )
    for n, (_score_v, loc_id, basis) in enumerate(scored):
        if n >= MAX_RESULTS:
            resp["truncated"] = True
            break
        loc = idx.by_id[loc_id]
        placements = [p for p in loc["placements"] if not surface or _on_surface(p, surface)]
        key = matched.get(loc_id)
        if loc.get("state_labels"):
            key = _state_key(idx, loc, [queries[c] for c in searched], key)
        rec = _record(idx, loc, placements, locale, basis, key)
        resp["results"].append(rec)
        if _size(resp) > MAX_RESPONSE_BYTES:
            resp["results"].pop()
            resp["truncated"] = True
            break
    if not resp["results"]:
        # Fixed and metadata-free, so it fits any cap of at least its own size.
        return {**_TOO_BIG, "results": []}
    return resp


# ---------------------------------------------------------------------- browse

#: ``find_ui``'s browse mode lists every location of one AREA, so a question
#: the search misses ("how do I tidy my chats into groups?") can still be
#: answered by reading the one area it must be in and picking the entry that
#: means it. Areas are a small, stable vocabulary over the index's own
#: structure: a location is in an area when it IS one of the area's anchor
#: locations, when one of its placements runs through an anchor (its path), or
#: when it matches the area's id prefixes or surface. They may overlap (a
#: Settings > Notifications control is in ``notifications`` and in
#: ``settings.notifications``). ``settings`` is split: its listing names one
#: ``settings.<tab>`` sub-area per Settings tab instead of 280 controls.


@dataclass(frozen=True)
class _Area:
    #: One English line saying what the area holds (prose, like ``only_if``).
    about: str
    #: The location whose localized label names the area, when there is one.
    title: str | None = None
    anchors: tuple[str, ...] = ()
    surfaces: tuple[str, ...] = ()
    ids: tuple[str, ...] = ()
    id_prefixes: tuple[str, ...] = ()
    #: Areas whose members are left out of this one.
    exclude: tuple[str, ...] = ()
    #: Neighbouring areas a question about this one often belongs to (returned
    #: as ``related``, so a miss here points at the next listing to read).
    related: tuple[str, ...] = ()


_COMPOSER_IDS = ("chat.model-picker", "chat.memory-mode")
AREAS: dict[str, _Area] = {
    "sessions": _Area(
        "the Sessions page: chat list, new chat, folders, older sessions, row and list menus",
        title="page.chat",
        anchors=("page.chat",),
        exclude=("composer",),
        related=("composer",),
    ),
    "composer": _Area(
        "the message box under a chat: attach files, model, memory mode, context usage, send and stop",
        ids=_COMPOSER_IDS,
        id_prefixes=("composer.",),
        related=("sessions",),
    ),
    "crewmates": _Area(
        "crewmates: the Crewmates page and the Crewmates and Custom agents tabs of Customize",
        title="page.members",
        anchors=("page.members", "tab.capabilities.crews", "tab.capabilities.templates"),
    ),
    "schedule": _Area(
        "the Schedule page: scheduled jobs, reminders, runs",
        title="page.schedule",
        anchors=("page.schedule",),
    ),
    "artifacts": _Area(
        "the Artifacts page: saved documents, folders, import, deploy",
        title="page.artifacts",
        anchors=("page.artifacts",),
    ),
    "apps": _Area(
        "apps: Discover (the app store) and Library (installed apps and their details)",
        title="page.apps",
        anchors=("page.apps", "page.apps-library"),
    ),
    "connections": _Area(
        "connections: MCP servers, messaging channels (Slack, Telegram, ...), OAuth apps",
        title="tab.capabilities.mcp",
        anchors=("tab.capabilities.mcp", "settings.tab.channels", "settings.tab.connections"),
        related=("settings",),
    ),
    "customize": _Area(
        "the Customize page: crewmates, connections, skills, hooks, knowledge, prompts, steering, workflows",
        title="page.capabilities",
        anchors=("page.capabilities",),
        related=("settings",),
    ),
    "notifications": _Area(
        "notifications: the bell in the top bar, the Notifications page, notification settings",
        title="page.notifications",
        anchors=("page.notifications", "shell.notifications", "settings.tab.notifications"),
    ),
    "shell": _Area(
        "controls on every page: navigation rail, top bar, search, terminal, phone menu "
        "(the built-in browser is a view of a chat's side panel, listed under sessions)",
        surfaces=(SHELL_SURFACE,),
        related=("sessions",),
    ),
    "settings": _Area(
        "the Settings page; its listing names one settings.<tab> sub-area per tab",
        title="page.settings",
        anchors=("page.settings",),
        related=("customize",),
    ),
    "developer": _Area(
        "the Developer, Logs, Webhooks and Task Runner pages",
        title="page.developer",
        anchors=("page.developer", "page.logs", "page.webhooks", "page.projects"),
    ),
}
#: The area split into sub-areas, and the tab-id prefix each sub-area is named from.
_SPLIT_AREA = "settings"
_SPLIT_TAB_PREFIX = "settings.tab."
_AREA_RE = re.compile(r"\A[a-z][a-z0-9-]{0,40}(?:\.[a-z0-9-]{1,40})?\Z")
_BROWSE_NOTE = (
    "every entry the index has for this area, in path order. tier auto is approximate: "
    "only its page is known, not where on it or what must be true for it to show; relay "
    "it hedged. needs lists short prerequisites (English ids); call find_ui with an "
    "entry's id as query for the full ones"
)


def _area_table(idx: _Index) -> dict[str, _Area]:
    """The fixed areas plus one ``settings.<tab>`` sub-area per Settings tab in the index."""
    table = dict(AREAS)
    for loc_id in sorted(idx.by_id):
        if loc_id.startswith(_SPLIT_TAB_PREFIX) and idx.by_id[loc_id].get("tier") != _AUTO:
            sub = f"{_SPLIT_AREA}.{loc_id[len(_SPLIT_TAB_PREFIX):]}"
            table[sub] = _Area(f"one Settings tab: {loc_id}", title=loc_id, anchors=(loc_id,))
    return table


def area_ids(idx: _Index | None = None) -> list[str]:
    """Every browsable area id (the fixed vocabulary plus the Settings sub-areas)."""
    return list(_area_table(idx) if idx is not None else AREAS)


def _in_area(area: _Area, loc_id: str, loc: dict[str, Any]) -> bool:
    if loc_id in area.anchors or loc_id in area.ids:
        return True
    if any(loc_id.startswith(p) for p in area.id_prefixes):
        return True
    anchors = set(area.anchors)
    for p in loc["placements"]:
        if p.get("surface_id") in area.surfaces or anchors.intersection(p.get("parent_ids", [])):
            return True
    return False


def area_members(idx: _Index, area_id: str) -> list[str]:
    """Location ids in ``area_id`` (sub-areas included), in path order."""
    table = _area_table(idx)
    area = table[area_id]
    excluded = [table[x] for x in area.exclude]
    out = [
        loc_id
        for loc_id, loc in idx.by_id.items()
        if _in_area(area, loc_id, loc) and not any(_in_area(x, loc_id, loc) for x in excluded)
    ]

    def order(loc_id: str) -> tuple[bool, tuple[str, ...]]:
        # Proven entries first, the approximate auto tier after them; each in
        # path order, so a menu's items follow the menu and a tab's its tab.
        loc = idx.by_id[loc_id]
        return (loc.get("tier") == _AUTO, (*loc["placements"][0]["parent_ids"], loc_id))

    return sorted(out, key=order)


def _auto_one_word(idx: _Index, loc: dict[str, Any], locale: str) -> bool:
    if loc.get("tier") != _AUTO:
        return False
    return _one_word(_Text.of(_label(idx, loc["label_key"], locale), locale))


def _need(idx: _Index, req: dict[str, Any], locale: str) -> str:
    """One prerequisite as a short phrase: the browse listing's ``needs`` item."""
    kind = req.get("kind")
    if kind == "viewport":
        return f"{req.get('value')} only"
    if kind in ("shown_by", "preview_flag"):
        label = _loc_label(idx, str(req.get("location")), locale)
        if kind == "preview_flag":
            return f"preview: {label}"
        when = req.get("when")
        return f"after {label}" + (f" if {when}" if isinstance(when, str) else "")
    return str(req.get("id"))


def _entry(idx: _Index, loc: dict[str, Any], locale: str) -> dict[str, Any]:
    """One compact browse row: id, label (or description), path, needs, tier."""
    p = loc["placements"][0]
    text = _label(idx, loc["label_key"], locale)
    shown = {_DESCRIPTION: text} if loc.get("label_kind") == _DESCRIPTION else {"label": text}
    path_labels = [_loc_label(idx, pid, locale) for pid in p["parent_ids"]]
    out: dict[str, Any] = {
        "id": loc["id"],
        **shown,
        "path": " > ".join(path_labels + ([] if loc.get("label_kind") == _DESCRIPTION else [text])),
        "tier": loc.get("tier", _CURATED),
    }
    if p.get("surface_id") == SHELL_SURFACE:
        out["on_every_page"] = True
    states = loc.get("state_labels") or []
    if states:
        # The label each state shows, so the one the person sees can be quoted.
        out["states"] = {s["when"]: _label(idx, s["label_key"], locale) for s in states}
    needs = [_need(idx, r, locale) for r in p.get("requires", [])]
    if needs:
        out["needs"] = needs
    if len(loc["placements"]) > 1:
        out["ways"] = len(loc["placements"])
    return out


def browse_ui(
    area: str,
    lang: str | None = None,
    offset: int = 0,
    *,
    path: Path | None = None,
    auto_path: Path | None = None,
) -> dict[str, Any]:
    """List every location of one area, a page at a time. Read-only, like :func:`find_ui`.

    Each page holds whole entries up to :data:`MAX_RESPONSE_BYTES`; when more
    remain the answer says ``truncated: true`` and ``next_offset``, so a long
    area is paged, never silently cut. ``settings`` lists its sub-areas
    (``sub_areas``) and only the entries no sub-area holds.
    """
    name = (area or "").strip()
    if not _AREA_RE.match(name):
        return {"error": "'area' must be an area id such as 'sessions' or 'settings.chat'"}
    if lang is not None and lang != "" and not _LANG_RE.match(lang):
        return {"error": "'lang' must be a language tag such as 'en' or 'zh-CN'"}
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        return {"error": "'offset' must be a nonnegative integer"}
    try:
        idx = load_index(path, auto_path)
    except IndexUnavailable as exc:
        logger.warning("find_ui index unavailable: %s", exc)
        return _envelope(None, "unavailable", reason=str(exc), entries=[])
    table = _area_table(idx)
    if name not in table:
        return {"error": f"unknown area '{name}'; known: {', '.join(table)}"}
    locale, locale_source = _resolve_locale(lang or None, tuple(idx.labels))
    spec = table[name]
    members = area_members(idx, name)
    # An auto entry whose label is one word in this locale ("Cancel", "Retry")
    # is left out, as find_ui never answers with one: on its own it cannot say
    # which of a page's look-alike controls it is. The count is reported.
    one_word = [m for m in members if _auto_one_word(idx, idx.by_id[m], locale)]
    members = [m for m in members if m not in set(one_word)]
    sub_areas: list[dict[str, Any]] = []
    if name == _SPLIT_AREA:
        held: set[str] = set()
        for sub_id in table:
            if not sub_id.startswith(f"{_SPLIT_AREA}."):
                continue
            ids = area_members(idx, sub_id)
            held.update(ids)
            sub_areas.append(
                {
                    "area": sub_id,
                    "label": _loc_label(idx, table[sub_id].title or sub_id, locale),
                    # What that sub-area's own listing totals (one-word auto left out).
                    "count": sum(not _auto_one_word(idx, idx.by_id[i], locale) for i in ids),
                }
            )
        members = [m for m in members if m not in held]
    resp = _envelope(
        idx,
        "ok",
        area=name,
        about=spec.about,
        requested_locale=lang or None,
        resolved_locale=locale,
        locale_source=locale_source,
        note=_BROWSE_NOTE,
        total=len(members),
        omitted_one_word_auto=len(one_word),
        offset=offset,
        truncated=False,
        entries=[],
    )
    if spec.title and spec.title in idx.by_id:
        resp["title"] = _loc_label(idx, spec.title, locale)
    if spec.related:
        resp["related"] = list(spec.related)
    if locale != DEFAULT_LOCALE:
        resp["prose_locale"] = DEFAULT_LOCALE
    if sub_areas and offset == 0:
        resp["sub_areas"] = sub_areas
    if _size(resp) > MAX_RESPONSE_BYTES:
        return {**_TOO_BIG, "entries": []}
    for n in range(offset, len(members)):
        resp["entries"].append(_entry(idx, idx.by_id[members[n]], locale))
        if _size(resp) > MAX_RESPONSE_BYTES:
            resp["entries"].pop()
            break
    shown = offset + len(resp["entries"])
    if shown < len(members):
        if not resp["entries"]:
            # Not even one entry fits: a fixed answer, never an endless empty page.
            return {**_TOO_BIG, "entries": []}
        # Keep room for the paging fields themselves.
        resp["truncated"] = True
        resp["next_offset"] = shown
        while _size(resp) > MAX_RESPONSE_BYTES and resp["entries"]:
            resp["entries"].pop()
            resp["next_offset"] = offset + len(resp["entries"])
    return resp
