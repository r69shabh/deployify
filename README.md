# Deployify

Deployify is a VS Code extension that surfaces deployment status across multiple hosting providers in one native VS Code view.

## Features

- First-run onboarding in the Deployments view with one-click connect actions
- OAuth connect flow for Vercel and Netlify (no end-user settings required)
- AWS Amplify integration using your existing AWS credentials
- Native VS Code Activity Bar tree for projects and environments
- Environment grouping with recent deployment history under each project
- Workspace-linked projects and all-account projects shown together
- Root sections default to collapsed; expanding one collapses the others
- Auto-refresh polling with backoff on provider errors
- Failure transition notifications
- Deployment details panel and direct links to provider dashboards
- Credentials stored in VS Code `SecretStorage`

## Commands

- `Deployify: Connect Provider`
- `Deployify: Connect Vercel`
- `Deployify: Connect Netlify`
- `Deployify: Connect AWS Amplify`
- `Deployify: Disconnect Provider`
- `Deployify: Refresh`
- `Deployify: Open Deployment`
- `Deployify: Open Project Dashboard`
- `Deployify: View Details`
- `Deployify: Link Workspace Project`
- `Deployify: Unlink Workspace Project`

## End-User Setup

1. Install the VSIX.
2. Open the `Deployments` activity view.
3. Click `Connect Vercel`, `Connect Netlify`, or `Connect AWS Amplify` from the welcome surface.
4. Complete browser OAuth and return to VS Code.

No manual OAuth settings are required for end users.

## Settings

- `deployify.pollIntervalSeconds` (default: `45`, min: `20`)
- `deployify.notifyOnFailure` (default: `true`)
- `deployify.providers.vercel.enabled`
- `deployify.providers.netlify.enabled`
- `deployify.providers.awsAmplify.enabled`
- `deployify.providers.awsAmplify.region`
- `deployify.providers.awsAmplify.profile`

## Maintainer OAuth Configuration

OAuth client IDs are resolved from `src/auth/oauthClientRegistry.ts` by extension ID.

Important:

- OAuth **client IDs are public** and are safe to ship in a VS Code extension.
- OAuth **client secrets are private** and should never be shipped in extension code.
- If a provider flow requires a secret for exchange, use a backend auth broker service.

Before publishing under a new extension ID:

1. Add provider OAuth client mappings for that extension ID in `src/auth/oauthClientRegistry.ts`.
2. Register callback URIs in provider apps:
   - `vscode://<extension-id>/deployify-auth/vercel`
   - `vscode://<extension-id>/deployify-auth/netlify`
3. Build/package and verify connect flow in a clean VS Code profile.

Token fallback is kept as a hidden support path when OAuth is not enabled in a build.

## Testing in VS Code Insiders

Build/package:

```bash
npm install
npm run compile
npm test
npm run package
```

Install the VSIX in Insiders:

```bash
code-insiders --install-extension /Users/rishabh/pgming/deployify/deployify-0.1.0.vsix --force
```

Open Insiders and validate:

1. Deployments view first-run welcome appears with connect actions.
2. Connect Vercel/Netlify and verify no settings prompt is required.
3. Expand one root section at a time (`Workspace Projects`, `All Projects`, `Providers`).
4. Expand a project and verify environment nodes show multiple recent deployments.
5. Trigger refresh and verify statuses and failure notifications update in local timezone.

## Local Development

```bash
npm install
npm run compile
npm test
```

Run extension host:

1. Open this workspace in VS Code.
2. Press `F5` (`Run Deployify Extension` launch config).
3. In the Extension Development Host window, open the `Deployments` activity view.

## Packaging

```bash
npm run package
```

This produces a `.vsix` in the project root.
