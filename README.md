# Deployify

Deployify is a VS Code extension that surfaces deployment status across multiple hosting providers in one native VS Code view.

## Features

- Aggregates deployment info for Vercel and Netlify
- Shows project and environment status in a native VS Code Activity Bar tree
- Supports `workspace-linked` scope and `all-account` scope
- Polls every 45 seconds by default with backoff on provider errors
- Sends notifications on first transition to failed deployments
- Opens deployment and dashboard URLs from tree actions
- Stores provider sessions in VS Code `SecretStorage`

## Commands

- `Deployify: Connect Provider`
- `Deployify: Disconnect Provider`
- `Deployify: Refresh`
- `Deployify: Toggle Scope`
- `Deployify: Open Deployment`
- `Deployify: Open Project Dashboard`
- `Deployify: View Details`
- `Deployify: Link Workspace Project`
- `Deployify: Unlink Workspace Project`

## Provider Auth Setup

### Vercel OAuth

1. Create/configure a Vercel OAuth app.
2. Add redirect URI pattern for this extension callback: `vscode://<publisher>.<extension>/deployify-auth/vercel`.
3. Set these VS Code settings:
   - `deployify.providers.vercel.authMode = oauth`
   - `deployify.providers.vercel.oauthClientId = <your-client-id>`
   - `deployify.providers.vercel.oauthClientSecret = <optional-if-required>`
   - `deployify.providers.vercel.oauthScopes = project.read deployments.read`

### Netlify OAuth

1. Create/configure a Netlify OAuth app.
2. Add redirect URI pattern: `vscode://<publisher>.<extension>/deployify-auth/netlify`.
3. Set these VS Code settings:
   - `deployify.providers.netlify.authMode = oauth`
   - `deployify.providers.netlify.oauthClientId = <your-client-id>`
   - `deployify.providers.netlify.oauthScopes = read_site`
   - `deployify.providers.netlify.oauthGrantType = implicit` (recommended default)
4. For code exchange flow, set:
   - `deployify.providers.netlify.oauthGrantType = authorization_code`
   - `deployify.providers.netlify.oauthClientSecret = <your-client-secret>`
   - `deployify.providers.netlify.oauthTokenEndpoint = https://api.netlify.com/oauth/token`

### Token fallback mode

If you do not want OAuth app setup yet, set provider `authMode` to `token` and Deployify will use token prompt flow.

## Settings

- `deployify.pollIntervalSeconds` (default: `45`, min: `20`)
- `deployify.notifyOnFailure` (default: `true`)
- `deployify.defaultScope` (`workspace-linked` | `all-account`)
- `deployify.providers.vercel.enabled`
- `deployify.providers.vercel.authMode`
- `deployify.providers.vercel.oauthClientId`
- `deployify.providers.vercel.oauthClientSecret`
- `deployify.providers.vercel.oauthScopes`
- `deployify.providers.netlify.enabled`
- `deployify.providers.netlify.authMode`
- `deployify.providers.netlify.oauthClientId`
- `deployify.providers.netlify.oauthClientSecret`
- `deployify.providers.netlify.oauthScopes`
- `deployify.providers.netlify.oauthGrantType`
- `deployify.providers.netlify.oauthTokenEndpoint`

## Local Development

```bash
npm install
npm run compile
npm test
```

Run extension host:

1. Open this workspace in VS Code.
2. Press `F5` (`Run Deployify Extension` launch config).
3. In the Extension Development Host window, open the `Deployments` activity bar view.

## How To Test End-to-End

1. In the dev host, run `Deployify: Connect Provider`.
2. Pick Vercel or Netlify and complete browser auth.
3. Verify provider node switches to `Connected`.
4. Verify `Workspace Projects` / `All Projects` toggle works.
5. Verify deployments render with state icons and URLs.
6. Trigger `Deployify: Refresh` and confirm timestamps/state updates.
7. Open a deployment and details panel from tree item context.
8. Force a failed deployment in provider and confirm only one failure notification appears per transition.

## Packaging

```bash
npm run package
```

This produces a `.vsix` in the project root.

## Provider Extensibility

Providers implement `DeploymentProviderAdapter`.

To add another provider:

1. Add adapter file in `src/providers/`
2. Register it in `src/extension.ts`
3. Add provider settings in `package.json`

The tree UI and polling pipeline do not need structural changes if adapter contract is preserved.
