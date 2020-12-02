import {
  CallbackFunction,
  CheckForUpdateResponse,
  ICurrentConfig,
  IDeployConfig,
  ISnapshotInfo,
  ISyncOptions,
} from './IonicCordova';
import { CancelToken } from './tokens';

/**
 * @hidden
 */
const deviceready = new Promise<IDeployPluginAPI>((resolve, rejects) => {
  document.addEventListener('deviceready', () => {
    if (window.IonicCordova) {
      return resolve(window.IonicCordova.deploy);
    }
    return rejects('cordova-plugin-ionic not found. Are you sure you installed it?');
  });
});

export class DeployClass implements IDeployPluginAPI {

  async configure(config: IDeployConfig) {
    const deploy = await deviceready;
    return deploy.configure(config);
  }

  async getConfiguration(): Promise<ICurrentConfig> {
    const deploy = await deviceready;
    return deploy.getConfiguration();
  }

  async checkForUpdate(): Promise<CheckForUpdateResponse> {
    const deploy = await deviceready;
    return deploy.checkForUpdate();
  }

  async downloadUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>) {
    const deploy = await deviceready;
    return deploy.downloadUpdate(cancelToken, progress);
  }

  async extractUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>) {
    const deploy = await deviceready;
    return deploy.extractUpdate(cancelToken, progress);
  }

  async reloadApp() {
    const deploy = await deviceready;
    return deploy.reloadApp();
  }

  async resetToBundle() {
    const deploy = await deviceready;
    return deploy.resetToBundle();
  }

  async showErrorAlert() {
    const deploy = await deviceready;
    return deploy.showErrorAlert();
  }

  async sync(options: ISyncOptions, cancelToken: CancelToken, progress?: CallbackFunction<number>) {
    const deploy = await deviceready;
    return deploy.sync(options, cancelToken, progress);
  }

  async getCurrentVersion(): Promise<ISnapshotInfo | undefined> {
    const deploy = await deviceready;
    return deploy.getCurrentVersion();
  }

  async getAvailableVersions() {
    const deploy = await deviceready;
    return deploy.getAvailableVersions();
  }

  async deleteVersionById(versionId: string) {
    const deploy = await deviceready;
    return deploy.deleteVersionById(versionId);
  }

  async getVersionById(versionId: string) {
    const deploy = await deviceready;
    return deploy.getVersionById(versionId);
  }
}

export const Deploy = new DeployClass();