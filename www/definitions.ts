export interface IAvailableUpdate {
  binaryVersionName: string;
  binaryVersionCode: string;
  channel: string;
  lastUsed: string;
  state: string;
  url: string;
  versionId: string;
}

export interface ISavedPreferences extends ICurrentConfig {
  currentVersionForAppId?: string;
  availableUpdate?: IAvailableUpdate;
  updates: { [versionId: string]: IAvailableUpdate };
  switchToReference: boolean;
}

export interface UpdateInfo {
  versionId: string;
  path: string;
}

export interface ManifestFileEntry {
  integrity: string;
  href: string;
  size: number;
}

export interface FetchManifestResp {
  manifestJson: ManifestFileEntry[];
  fileBaseUrl: string;
}

export interface IDeviceDetails {
  binary_version: string;
  device_id?: string;
  platform: string;
  platform_version: string;
  snapshot?: string;
}