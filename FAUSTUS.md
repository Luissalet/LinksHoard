# Links Hoard

## App Dock

When opened beside a Faustus chat, this page registers `links_open`, `links_filter`, `links_view` through `window.HoardApp`. These tools resolve records by id or unique name, apply the app's filters and switch sections. Ambiguous names return candidates. The current reading section and the selected or open link are reported. Text, tag and site filters use the normal saved-link lists.

`dock/changed` refreshes the mounted views without a page reload. Existing pending form fields are retained by the app's refresh handlers. The standalone interface continues to use its normal routes and controls. The Dock tools are exposed through the host's `app_view` and `app_act`; the existing backend tool catalogue is unchanged.
