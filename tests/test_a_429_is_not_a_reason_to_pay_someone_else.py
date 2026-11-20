"""A rate limit means "too fast", not "broken" — so the chain must not advance on it.

Every other failure in `chat_with_fallback` means the current vendor cannot serve the
call, so moving to the next one is right. A 429 means the vendor is willing and we
asked too quickly, and moving on turns a one-second wait into a paid call somewhere
else.

That is not hypothetical. On 2026-11-20 a single partial scan took 47 Cerebras rate
limits in 26 minutes, with `max_retries=0` on every client in this repo, so all 47 went
straight to the paid fallback — in an arrangement whose stated point was that the paid
vendor is only spent when the first one is throttled.

`time.sleep` is patched throughout: these assert the DECISION, not the waiting.
"""
import unittest
from unittest import mock

from core import llm_client


class _Resp:
    def __init__(self, headers=None):
        self.headers = headers or {}


class RateLimitError(Exception):
    """Named to match what the OpenAI SDK raises — `_is_rate_limit` reads the name."""

    def __init__(self, msg="Requests per minute limit exceeded", headers=None):
        super().__init__(msg)
        self.response = _Resp(headers)
        self.status_code = 429


class _Boom(Exception):
    """Any other failure."""


def _answer(text="OK"):
    msg = mock.Mock()
    msg.content = text
    choice = mock.Mock()
    choice.message = msg
    resp = mock.Mock()
    resp.choices = [choice]
    return resp


def _client(side_effect):
    c = mock.Mock()
    c.chat.completions.create = mock.Mock(side_effect=side_effect)
    c.base_url = "https://api.cerebras.ai/v1"
    return c


class RateLimitStaysOnTheSameEndpoint(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.object(llm_client.time, "sleep")
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)
        # No provider chain: if the call were to advance, it would advance to nothing
        # and return empty, which is exactly what these tests distinguish.
        patcher2 = mock.patch.dict("os.environ", {"RFPIS_LLM_PROVIDERS": ""}, clear=False)
        patcher2.start()
        self.addCleanup(patcher2.stop)

    def test_a_429_then_an_answer_is_served_by_the_same_endpoint(self):
        client = _client([RateLimitError(), _answer("served")])
        content, model, _ = llm_client.chat_with_fallback(
            client, ["gpt-oss-120b"], messages=[])
        self.assertEqual(content, "served")
        self.assertEqual(model, "gpt-oss-120b")
        self.assertEqual(client.chat.completions.create.call_count, 2)

    def test_the_retry_waits_before_asking_again(self):
        client = _client([RateLimitError(), _answer()])
        llm_client.chat_with_fallback(client, ["m"], messages=[])
        self.sleep.assert_called_once()
        self.assertGreater(self.sleep.call_args[0][0], 0)

    def test_it_waits_as_long_as_the_provider_asked(self):
        client = _client([RateLimitError(headers={"retry-after": "7"}), _answer()])
        llm_client.chat_with_fallback(client, ["m"], messages=[])
        self.assertEqual(self.sleep.call_args[0][0], 7.0)

    def test_an_absurd_retry_after_is_capped(self):
        client = _client([RateLimitError(headers={"retry-after": "86400"}), _answer()])
        llm_client.chat_with_fallback(client, ["m"], messages=[])
        self.assertEqual(self.sleep.call_args[0][0], llm_client._RATE_LIMIT_MAX_WAIT)

    def test_backoff_grows_while_the_limit_holds(self):
        client = _client([RateLimitError(), RateLimitError(), _answer()])
        llm_client.chat_with_fallback(client, ["m"], messages=[])
        waits = [c[0][0] for c in self.sleep.call_args_list]
        self.assertEqual(waits, [1.0, 2.0])

    def test_retries_are_bounded_and_then_the_chain_moves_on(self):
        client = _client([RateLimitError()] * 10)
        content, _, _ = llm_client.chat_with_fallback(client, ["m"], messages=[])
        self.assertEqual(content, "")
        self.assertEqual(self.sleep.call_count, llm_client._RATE_LIMIT_RETRIES)
        self.assertEqual(client.chat.completions.create.call_count,
                         llm_client._RATE_LIMIT_RETRIES + 1)

    def test_a_non_rate_limit_failure_still_advances_immediately(self):
        client = _client([_Boom("model is gone"), _answer("second model")])
        content, model, _ = llm_client.chat_with_fallback(
            client, ["dead", "alive"], messages=[])
        self.assertEqual(content, "second model")
        self.assertEqual(model, "alive")
        self.sleep.assert_not_called()

    def test_an_empty_reply_still_advances_without_waiting(self):
        client = _client([_answer(""), _answer("second")])
        content, model, _ = llm_client.chat_with_fallback(
            client, ["first", "second"], messages=[])
        self.assertEqual(content, "second")
        self.assertEqual(model, "second")
        self.sleep.assert_not_called()


class RateLimitHelpers(unittest.TestCase):

    def test_a_429_is_recognised_by_status_code_alone(self):
        exc = _Boom("nope")
        exc.status_code = 429
        self.assertTrue(llm_client._is_rate_limit(exc))

    def test_an_ordinary_error_is_not_a_rate_limit(self):
        self.assertFalse(llm_client._is_rate_limit(_Boom("nope")))

    def test_no_pause_once_the_attempts_are_spent(self):
        self.assertIsNone(
            llm_client._rate_limit_pause(RateLimitError(),
                                         llm_client._RATE_LIMIT_RETRIES))

    def test_headers_that_cannot_be_read_fall_back_to_the_default(self):
        exc = RateLimitError(headers={"retry-after": "not-a-number"})
        self.assertEqual(llm_client._rate_limit_pause(exc, 0), 1.0)


if __name__ == "__main__":
    unittest.main()
