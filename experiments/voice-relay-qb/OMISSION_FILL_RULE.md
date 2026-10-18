# Omission-fill rule (v1) — what the relay delivers as recogniser text, and when

> **SUPERSEDED (2026-10-18)** by `docs/proposals/voice-realtime-omission-fill-SPEC.md` (rule v2).
> This file is kept for history only. `replay_rule.py` implements v1 as the `policy_R`
> comparison column; it is **not** the rule that ships. Do not update it when v2 changes.

Status: superseded. Not implemented in `server/`.
Human acceptance (2026-10-18): auto-filling at ~80–87 % precision is acceptable; short fragments the rule never fills are tolerated;
no new UI is introduced.

## Principle
The relay model's rewritten message is the primary delivery. Recogniser text is delivered only when the model's own messages
show, with fairly high probability, that a substantial utterance was dropped.

## Inputs (all already available to the proxy)
* `F_i = (t_i, x_i)` — every final transcription: arrival time and recogniser text.
* `M_k = (τ_k, m_k)` — every EXECUTED relay message: arrival time and text. Executed means the call ran:
  `session_send` and `session_interrupt` (its `message`) in a response that completed. A call inside a response
  cancelled by new speech never ran and is not an `M`.

## Qualification — which utterances the rule may ever fill
An utterance `F_i` is a candidate only if ALL hold:
1. `len(norm(x_i)) >= 7`, where `norm` lower-cases and removes whitespace, punctuation and symbols;
2. `x_i` is not ASCII-only (an English-only line from a Chinese speaker is a recogniser hallucination);
3. `x_i` is non-empty after `norm`.

Everything else is never filled by this rule (≤6 characters is where only ~25 % of flagged items were real omissions).

## Coverage score
`score(i, T) = bigram_recall( N(x_i), N(concat of m_k for τ_k in [t_i − 1000 ms, T]) )`
* `N(s) = norm(numerals_to_digits(s))`. `numerals_to_digits` rewrites runs of 零〇一二三四五六七八九十百 to Arabic digits
  (十月十七日 → 10月17日), so a model that writes `2026年10月15日` for `二零二六年十月十五日` still matches.
* `bigram_recall(a, b) = |{bigrams of a that occur in b}| / |bigrams of a|`.

## Decision time `T_i`
* `τ_first` = the first executed message with `τ ≥ t_i − 1000 ms`.
* If `τ_first` exists and `τ_first <= t_i + H`: `T_i = min(τ_first + G, t_i + H)`.  (G = 3 s grace for a second message from the same burst)
* Otherwise (no executed message by `t_i + H`): `T_i = t_i + H`.
* Parameters: `G = 3000 ms`, `H = 12000 ms`.

## Action at `T_i`
If `score(i, T_i) < 0.25`, deliver `x_i` verbatim to the session ("fill"). Otherwise do nothing.
* Several fills due at the same moment are delivered in time order as one message.
* No UI, no model round-trip, no retry.

## Not part of the rule
* No settle timer, no span "consumption": a model message never marks earlier utterances as answered.
* No claims, roster, version echo.
* Companion setting assumed: `interrupt_response:false` (not needed for the replay; a replay cannot change what the model did).

## Known limitations (measured)
* When the model corrects a garbled recognition (e.g. `reclamation lost` → `connection lost`) the score is low although the content
  was carried: a garbled duplicate is delivered (3 of 23 labelled ≥7-char flags).
* A fill is delivered after the model message about newer speech, so it is out of chronological order.
* An utterance carried only by a message arriving after `T_i` is delivered twice.
