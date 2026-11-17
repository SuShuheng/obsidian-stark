# Upstream provenance

## Source

- Repository: <https://github.com/o1xhack/obsidian-chatting>
- Plugin name: Chatting with AI
- Base version: `0.12.0`
- Base commit: `dd69bb2bcf2f03a84a1a2a1e622e79496f467cc8`
- Imported on: 2026-11-17
- License: MIT, preserved verbatim in [LICENSE](LICENSE)

The source archive was retrieved through the GitHub tarball API. The original
Git history is not included in this repository; the exact base commit is
recorded above for audit and diffing.

## Changes made during initialization

- Renamed the plugin identity from `chatting-with-ai` to `stark`.
- Changed the workspace view type from `ochatting-view` to `stark-view` so both
  plugins can be loaded without registering the same view.
- Reset release numbering to `0.1.0` for the independently developed plugin;
  the first public preview is `1.0.0`.
- Moved new secrets, chats, logs and local-storage keys to Stark-specific names.
- Kept upstream secret keys as read-only migration fallbacks.
- Updated user-facing assistant names and system/voice prompts to Stark.
- Added in-chat model and thinking controls for desktop and mobile.
- Restricted the visible and persisted provider configuration to ChatGPT OAuth.
- Split settings into eight pages and added Simplified Chinese/English UI translation.
- Added catalog-driven model enablement, per-model context overrides, and percentage-based compaction.
- Added Agent tool permissions, per-tool overrides, and `.agents/skills` management.
- Added desktop system/manual/direct proxy support with streaming `CONNECT`, while mobile
  continues to use Obsidian's native network stack.
- Added the About page with version, repository, and manual GitHub Release checks.

## Compatibility identifiers intentionally retained

The following identifiers are not yet renamed because they participate in
provider authentication or established UI behavior:

- ChatGPT OAuth `originator` and provider `User-Agent` values.
- The `ochatting-` CSS class prefix.

These should only change after validating desktop login, mobile login, provider
requests and both plugin themes side by side.

## Attribution

Stark is an independent fork and is not affiliated with or endorsed by the
upstream authors. Copyright notices for upstream and earlier contributors are
preserved in [LICENSE](LICENSE).
