# Transcript mix study — SHELVED

**Status: parked 2026-08-07. Not on `main`, not on `staging`. Nothing here is live.**

The question was: how much of a long-form video is the presenter's own material,
how much is him reading other people's words, how much is padding, how much is
advertising. The answer is defensible but rests on LLM judgement, and that isn't
a foundation the rest of the site stands on — every other number on
jerminaldecline is countable. Shelved for that reason, not because it's wrong.

This branch holds the finished panel (the top three commits) and every input
needed to resume without paying for the classification again.

## Where it got to

Runtime split across 12 long-form uploads, 333 blocks, 171 minutes:

| | share | of a 14-min upload |
|---|---|---|
| Own substance | 53.0% | 7.4 min |
| Read aloud | 30.1% | 4.2 min |
| Filler | 14.4% | 2.0 min |
| Promo | 2.6% | 0.4 min |

The more interesting result is the texture, not the headline: **no block in the
sample exceeds 60% filler and 212 of 333 are under a fifth.** Padding is woven
through continuously rather than pooled into stretches you could skip.

An earlier version of this study published 23.1% filler. The drop to 14.4% is
almost entirely a counting fix, not a change of opinion: the first pass gave each
block a single label, so a block that was 60% argument and 40% padding counted as
a whole 30 seconds of padding.

## How it was produced

- Blocks of ~30s built from auto-transcripts (`scripts/prep-transcripts.js`).
- Every block scored **twice**, by two *different* models (Opus 5 and Sonnet 5 —
  two runs of one model agreeing proves much less), each shown the neighbouring
  blocks for context, each splitting the block's time across the four categories
  rather than picking one (`scripts/reaudit.js`).
- The two agreed on 73%. Mean absolute difference where they differed: 8
  percentage points per category. The 89 material disagreements were settled by a
  third pass over a wider transcript window (`scripts/reconcile.js`).
- Blocks weighted by real duration — they run 4.5s to 35.2s, not a flat 30.
- Published file built by `scripts/build-mix2.js`.

Tie-break rule when a rater was torn: prefer S > Q > P > F. That deliberately
makes the filler figure a **floor**, not a ceiling.

## Resuming without re-paying

`data/reaudit-responses.json` holds **every raw model response** from the paid
run. Re-parse that rather than re-running — the raters cost roughly $6 and the
responses do not change.

```
node scripts/reconcile.js     # re-parse + adjudicate, needs ANTHROPIC_API_KEY
node scripts/build-mix2.js    # writes public/transcript-mix.json
```

`data/reaudit-final.json` is the reconciled per-block result, so `build-mix2.js`
alone reproduces the published figures with **no API calls at all**.

## Known traps, learned the hard way

- **Parse tolerantly.** Models omit zero categories (`S0.8 F0.2`, no Q or P) and
  echo the timestamp back (`[7] 03:11 | ...`). A strict parser silently dropped
  ~40% of responses, and *not at random* — blocks that were purely one thing are
  exactly the ones written with categories missing. That produced a plausible but
  wrong result that nearly got published.
- **Partial coverage is not a partial answer.** Responses fail in whole batches,
  so the survivors are a biased subset. `reaudit.js` aborts below 97%.
- **Save every raw response.** A parser bug should cost a re-parse, not a re-run.
- `reaudit.js` guards `main()` behind `require.main` — importing it used to start
  a paid run.
- The 5-series models reject a `temperature` parameter outright.

## If it's revisited

The obvious complaint is that this measures an LLM's opinion. The deterministic
disfluency/repetition tally (built separately, no model involved) is the harder
number and could either corroborate this or replace the filler bucket entirely.
