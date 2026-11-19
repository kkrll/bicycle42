# The chat

**What.** The conversation with the agent in the panel: messages, steps and tools, the composer
(`/` commands, `@` mentions, pasted pictures), the model and effort under it, permission and
question cards, Stop.

**Reach.** `mod+K` puts the cursor in the chat box.

**Drive.** The fake server has no messages, models beyond one, or commands, so the driver shows an
empty conversation. Drive the composer in the window:

```
"ui document.querySelector('.composer textarea').focus()"
"ui window.b42.invoke('send', 'hello', [], {})" "prompts"
```

The rest is the mock: `bun run visual`, shots `review`, `long`, `long-code`, `history`,
`slash-menu`, `slash-run`, `mention-menu`, `attach-mention`, `permission`, `question`, `steer`,
`cancel`, `drop`, `lightbox`.

**What lies.**

- The chat is rebuilt from the server's events (`opencode.ts`). A mock shot proves rendering only;
  ordering and de-duplication after a reconnect are proven in `opencode.test.ts` and
  `controller.test.ts`.
- Markdown goes through DOMPurify in `markdown.tsx`. A shot of nice markdown says nothing about
  what was stripped.
