# Shared copilot

Links contributes its native reading context to Faustus through
`window.hoardCopilot.context()` and refreshes its own views through
`window.hoardCopilot.onTurnEnd()`. The shared HoardLink installer supplies the
launcher and relay; Faustus supplies the actual `faustus-chat` component,
canonical conversations, unsent chat drafts, model selection and agent loop.
Links does not store another chat history or run another conversational agent.

The reader resolves `GET /api/links/:id` before supplying the native project
reference. `active_objects` identifies the link and a paragraph only when its
source version still matches. New or deleted objects yield app context without
a fabricated identifier. Current form fields and the reader's note/selection
snapshot are carried in `view`. A turn refreshes lists and the reader while
keeping their component identities, filters, pending tag input and dirty notes.
Settings refresh merges unchanged fields from the server and keeps manual edits.

## HTTP and MCP

The relay routes are `/api/copilot/info`, `/api/copilot/panel.js`,
`/api/copilot/proxy` and `/api/copilot/launcher.js`. The stable data-space UUID
belongs to the app's configured data directory. Faustus credentials remain in
the backend. `LINKS_FAUSTUS_URL` selects the shared service; the global model
remains configured in Faustus.

`PATCH /api/links/:id` updates only the provided title, notes, tags, archived or
favorite fields. `tags` keeps its previous complete-replacement behavior;
`tags_add` and `tags_remove` apply label deltas to the current native record.
Adding or removing a label in the reader uses these deltas, preserving labels
added by the agent since the reader loaded. Blurring unchanged notes sends no
write. Settings forms similarly send only fields the user actually changed.

`edit_link` exposes the same partial update through the agent API and MCP.
Identify an existing link by `id` or `url`; all patch fields are optional.
The existing `read_link`, `tag_link`, `mark_link` and other tools retain their
behavior. Read the current native link before editing it.
