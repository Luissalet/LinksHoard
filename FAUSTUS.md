# Links Hoard

## App Dock

When opened beside a Faustus chat, this page registers `links_open`, `links_filter`, `links_view` through `window.HoardApp`. These tools resolve records by id or unique name, apply the app's filters and switch sections. Ambiguous names return candidates. The current reading section and the selected or open link are reported. Text, tag and site filters use the normal saved-link lists.

`dock/changed` refreshes the mounted views without a page reload. Existing pending form fields are retained by the app's refresh handlers. The standalone interface continues to use its normal routes and controls. The Dock tools are exposed through the host's `app_view` and `app_act`; the existing backend tool catalogue is unchanged.

## Plegar and bilingual reading

Faustus reads a long saved text (web page, PDF, DOCX, EPUB, arXiv paper) level by level instead of all at once: `fold_link` writes the generated levels once with the Sparks model through the Hub (key idea per section, one line per section, theme map) and reports what each level costs in tokens; `fold_read` returns one level, 5 to 1, for the whole text or one section, as markdown with `[¶n]` paragraph marks. Levels 1-2 are literal and need no model; 3-5 are generated and say so. `translate_link` returns paragraphs with their stored translation into a chosen language, translating the missing ones. Details in [docs/FOLD.md](docs/FOLD.md).
