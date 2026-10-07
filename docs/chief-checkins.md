# Chief check-ins

Chief check-ins are personal to a company membership and turn on by default when the active Chief has a usable normal AI connection. Each member can turn them off or adjust their own times. A saved setting, including an explicit Off choice, is always preserved. If no usable Chief connection exists, settings remain unset and off; the background engine initializes them after a connection becomes usable.
They review existing, permitted task and chat context and suggest concrete next
steps in the member's private direct Chief chat. They never execute suggested
work. Accepting a suggestion by sending an ordinary chat message creates an
ordinary user-authorized run.

The settings allow one or two distinct local times (initially 09:00 and 15:00)
and weekdays only (initially on). Times follow the workspace timezone through
DST. The next occurrence is stored durably and rebased when that timezone
changes. No separate model is stored: the normal Chief assignment and permitted
company model fallback apply.

A default setting is saved only for eligible members with no prior setting, after checking the active Chief's normal model assignment and fallback. The setting starts at the next future weekday occurrence and never triggers an immediate run. A scheduled occurrence is claimed in a database transaction after checking AI availability, then rechecked against current settings, membership and Chief.
Occurrences over fifteen minutes old are skipped. Busy Chiefs, paused companies,
unavailable AI and unchanged completed context are skipped without queued
backlogs. Settings and runs live in dedicated tables; action-capable schedules
are not repurposed. Check-ins receive no automatic recovery enrollment or retry.
Check now explains a skip and cannot run when settings are off.

Check-in execution advertises a narrow list of safe read tools and finish_work.
The same allowlist is enforced by the server dispatcher, including tool calls a
provider makes without advertising. Computers, MCP, messages, mutations,
recruitment, delegation, approvals, human requests and notes writes are blocked.
All generated prose is buffered until an accepted finish. Empty/quiet, failed,
cancelled and incomplete runs leave no chat messages, progress or notifications.
Permissions, membership, active Chief and enabled state are checked again before
publication. Turning settings off cancels queued/running check-ins; later
in-flight events cannot publish.

Successful checks retain a fingerprint of permitted context, excluding internal
check-ins and published check-in suggestions. Previous suggestions and dismissals
are included separately in bounded model context; normalized identical output is
suppressed even if unrelated context changed. Existing reminders and paused/held
work are included as exclusions. A dismissal preserves the suggestion message
and marks its metadata; it does not disable future checks.

## API

- GET `/api/chief-checkins`: personal settings including the active Chief,
  workspace timezone, last checked time/result and next occurrence.
- PATCH `/api/chief-checkins`: strict partial `enabled`, `times` (minute values),
  `weekdays_only`; duck/model fields and duplicate times are rejected.
- POST `/api/chief-checkins/check`: `{settings, started, reason?}`.
- POST `/api/chief-checkins/runs/:id/dismiss`: scoped to the requesting member and
  company; published suggestions only.

All settings routes require duck configuration permission. Enabling/running also
requires task and chat permission. Boot data includes `chief_checkins` for members
who can configure ducks. Useful message metadata is
`chief_checkin: {run_id, dismissed}`. Internal message origin is `chief_checkin`;
published suggestions use `chief_checkin_suggestion`.

`NO_BACKGROUND_WORK=1` disables the check-in engine with other background work.
Tests use throwaway fixture databases and mock AI providers; no live workspace
or connected AI is required.
