---
name: ctx
description: Shows the current chat context window size in tokens (intercepted locally by a 0-token PreInvocation hook without calling the model).
---

# Context Token Counter

This slash command (`/ctx`, aliases `/чат`, `/chat`, `/tokens`) is handled locally by the `chat-context-command` PreInvocation hook without calling the model. If the hook did not intercept it, read the latest `input_tokens + cache_read_tokens` from the conversation's `transcript.jsonl` and reply with one short line showing the token count.
