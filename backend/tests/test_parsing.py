# Tolerant JSON parsing tests: think blocks, fences, prose, trailing commas, garbage.
import pytest

from app.llm.parsing import extract_json


def test_plain_objects():
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json("[1, 2, 3]") == [1, 2, 3]


def test_surrounding_prose():
    text = 'Here is the JSON you asked for:\n{"a": 2, "b": [1]}\nHope that helps.'
    assert extract_json(text) == {"a": 2, "b": [1]}


THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


def test_think_block_and_fences():
    text = (
        THINK_OPEN + "\nLet me think about this carefully.\n" + THINK_CLOSE +
        '\n```json\n{"ok": true, "n": 7}\n```\n'
    )
    assert extract_json(text) == {"ok": True, "n": 7}


def test_unclosed_think():
    text = THINK_OPEN + "\nstill reasoning...\n```json\n{\"x\": 5}\n```"
    assert extract_json(text) == {"x": 5}


def test_trailing_comma_fixed():
    assert extract_json('{"a": 1, "b": [1, 2,],}') == {"a": 1, "b": [1, 2]}


def test_smart_quotes():
    assert extract_json('{"s": "\u201chello\u201d"}') == {"s": "hello"}


def test_nested_and_array_of_objects():
    text = (
        "Result:\n"
        '{"outer": {"inner": [1, {"deep": true}]}, "list": [{"a": 1}, {"a": 2}]}'
    )
    assert extract_json(text) == {
        "outer": {"inner": [1, {"deep": True}]},
        "list": [{"a": 1}, {"a": 2}],
    }


def test_garbage_raises():
    with pytest.raises(ValueError):
        extract_json("no structured content here at all, sorry")
    with pytest.raises(ValueError):
        extract_json('{"unclosed": [1, 2')
    with pytest.raises(ValueError):
        extract_json("")
