import * as vscode from "vscode";
import { DeploymentDetails, DeploymentSummary, HostedProject } from "../core/types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? iso : date.toLocaleString();
}

export class DetailsWebview {
  private panel: vscode.WebviewPanel | undefined;

  public show(
    details: DeploymentDetails,
    project: HostedProject | undefined,
    history: DeploymentSummary[],
    providerError?: string
  ): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "deployify.details",
        "Deployment Details",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = `${project?.name ?? details.projectId} • ${details.environment}`;
    this.panel.webview.html = this.render(details, project, history, providerError);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private render(
    details: DeploymentDetails,
    project: HostedProject | undefined,
    history: DeploymentSummary[],
    providerError?: string
  ): string {
    const overviewRows: Array<[string, string]> = [
      ["Provider", details.provider],
      ["Project", project?.name ?? details.projectId],
      ["Environment", details.environment],
      ["State", details.state],
      ["URL", details.url ? `<a href=\"${escapeHtml(details.url)}\">${escapeHtml(details.url)}</a>` : "-"],
      ["Commit", details.commitSha ? escapeHtml(details.commitSha) : "-"],
      ["Message", details.commitMessage ? escapeHtml(details.commitMessage) : "-"],
      ["Updated", escapeHtml(formatDate(details.updatedAt))]
    ];

    const overviewHtml = overviewRows
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${value}</td></tr>`)
      .join("\n");

    const historyHtml = history.length
      ? history
          .map(
            (item) => `
              <div class="history-item">
                <div class="history-top">
                  <strong>${escapeHtml(item.environment)}</strong>
                  <span class="badge state-${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
                </div>
                <div class="history-meta">
                  <span>${escapeHtml(formatDate(item.updatedAt))}</span>
                  <span>${item.commitSha ? escapeHtml(item.commitSha.slice(0, 8)) : "-"}</span>
                </div>
                <div class="history-url">
                  ${item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>` : "No URL"}
                </div>
              </div>
            `
          )
          .join("\n")
      : "<p>No recent deployment history.</p>";

    const diagnostics = [providerError, ...(details.diagnostics ?? [])].filter((value): value is string => Boolean(value));
    const diagnosticsHtml = diagnostics.length
      ? `<ul>${diagnostics.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`
      : "<p>No diagnostics.</p>";

    const logsLink = details.logsUrl
      ? `<p><a href="${escapeHtml(details.logsUrl)}">Open provider logs</a></p>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .tabs {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 12px;
    }

    .tab {
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
      padding: 6px 8px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
    }

    .tab.active {
      border-bottom-color: var(--vscode-focusBorder);
      color: var(--vscode-textLink-foreground);
    }

    .panel {
      display: none;
    }

    .panel.active {
      display: block;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      text-align: left;
      padding: 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: top;
    }

    th {
      width: 120px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }

    .history-item {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
      background: var(--vscode-editorWidget-background);
    }

    .history-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .history-meta {
      display: flex;
      gap: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }

    .badge {
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
    }

    .state-ready {
      color: var(--vscode-testing-iconPassed);
    }

    .state-failed {
      color: var(--vscode-testing-iconFailed);
    }

    .state-building,
    .state-queued {
      color: var(--vscode-testing-iconQueued);
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-target="overview">Overview</button>
    <button class="tab" data-target="history">History</button>
    <button class="tab" data-target="diagnostics">Diagnostics</button>
  </div>

  <section id="overview" class="panel active">
    <table>
      ${overviewHtml}
    </table>
  </section>

  <section id="history" class="panel">
    ${historyHtml}
  </section>

  <section id="diagnostics" class="panel">
    ${diagnosticsHtml}
    ${logsLink}
  </section>

  <script>
    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.panel');

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-target');

        tabs.forEach((candidate) => candidate.classList.remove('active'));
        tab.classList.add('active');

        panels.forEach((panel) => {
          if (panel.id === target) {
            panel.classList.add('active');
          } else {
            panel.classList.remove('active');
          }
        });
      });
    });
  </script>
</body>
</html>`;
  }
}
