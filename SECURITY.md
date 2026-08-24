# Security Policy

## Reporting a vulnerability

Report privately — please do not open a public issue. Use [GitHub's
private vulnerability reporting](https://github.com/wlame/drakkar-ui/security/advisories/new)
on this repository, or contact the maintainer directly.

Include the affected release tag, what an attacker can achieve, and a
reproduction if you have one. Expect an acknowledgement within a week.

## What this repository is

drakkar-ui is the static SPA that Drakkar workers serve. It holds no
secrets, stores no server-side state, and enforces nothing: the bearer
token it forwards is validated by the backend, and every byte it renders
comes from a worker's `/api/v1` surface.

So most security questions about "the Drakkar UI" are really questions
about the worker serving it. Those are answered in the backend's
[Security posture](https://wlame.github.io/drakkar/security/), and reports
about backend behaviour belong on
[drakkar](https://github.com/wlame/drakkar/security/advisories/new) or
[drakkar-go](https://github.com/wlame/drakkar-go/security/advisories/new).

## Deployment posture — please read before reporting

Drakkar is an **internal tool**. Its operator UI and API are built for a
trusted, private contour — a VPC, an internal cluster network, an
operator-only ingress — and are not intended to be exposed to an untrusted
network. The authentication and rate limiting the backends ship are
**defence in depth, not a security perimeter**; the perimeter is the
operator's network and the application built on top of Drakkar.

Two consequences are design assumptions rather than vulnerabilities, and
reports resting on them will be closed with a pointer here:

- **Auth is opt-in.** With no token configured the UI sends no
  `Authorization` header, because the backend requires none. That is the
  documented dev-trust default for a private-contour deployment.
- **Custom renderer modules are deployment-owned code.** A module named by
  `ui.custom_renderers_path` is served same-origin with full DOM access.
  Configuring one is choosing to run your own JavaScript in the UI's
  origin, the same way a deployment already chooses the URLs behind its
  link templates.

In scope and welcome: anything where **this SPA** mishandles what a backend
sent it — cross-site scripting from rendered message content, task output,
labels or configuration values; a token leaking somewhere it should not
(a URL it constructs, an outbound request, storage another origin can
read); or any request it makes to an origin other than its own.
