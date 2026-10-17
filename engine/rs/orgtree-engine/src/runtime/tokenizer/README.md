# Generic output-token estimator

`o200k_base.tiktoken.gz` is the deterministic gzip9 form of the MIT-licensed
OpenAI tiktoken encoding. Keep the included `LICENSE` with it.

- Source: https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken
- Uncompressed SHA256: `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`
- Uncompressed size: 3,613,922 bytes; compressed size: 1,692,528 bytes.
- Pattern source: https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py
- Licence source: https://github.com/openai/tiktoken/blob/main/LICENSE

Approved by coordinator 2026-10-17 following the requested aggregate benchmark.
The file is decoded lazily on first use. Literal output is ordinary text, so
special-token-like substrings never become special instructions/tokens.
No current harness has a proven matching model encoding: tool counts remain
estimates with `~`, even after completion. Calibration uses only attributed,
complete text and its reported count. Hidden reasoning, child usage, prompt
deltas, mixed modalities, sampled output and ambiguous receipts cannot train it.

The comparison used complete visible assistant responses as a proxy, excluding
reasoning and calls. Held-out calibrated weighted absolute error: Claude 2.95%
(373 responses / 107,614 reported tokens), Codex 1.69% (55 / 3,101).
This does not establish tool-output error or model exactness.
