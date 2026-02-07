import * as vscode from "vscode";
import { DeploymentProviderAdapter, ProviderId } from "./types";

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, DeploymentProviderAdapter>();

  public register(adapter: DeploymentProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public get(providerId: ProviderId): DeploymentProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  public getAll(): DeploymentProviderAdapter[] {
    return [...this.adapters.values()];
  }

  public getEnabled(): DeploymentProviderAdapter[] {
    const configuration = vscode.workspace.getConfiguration("deployify.providers");

    return this.getAll().filter((adapter) => {
      const enabled = configuration.get<boolean>(`${adapter.id}.enabled`, true);
      return enabled;
    });
  }

  public getConnected(connectedProviderIds: ReadonlySet<ProviderId>): DeploymentProviderAdapter[] {
    return this.getEnabled().filter((adapter) => connectedProviderIds.has(adapter.id));
  }
}
