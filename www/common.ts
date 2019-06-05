/// <reference path="../types/IonicCordova.d.ts" />
/// <reference types="cordova-plugin-file" />
/// <reference types="cordova-plugin-file-transfer" />
/// <reference types="cordova" />

declare const cordova: Cordova;

const channel = cordova.require('cordova/channel');
channel.createSticky('onIonicProReady');
channel.waitForInitialization('onIonicProReady');

declare const resolveLocalFileSystemURL: Window['resolveLocalFileSystemURL'];
declare const Ionic: any;
declare const Capacitor: any;
declare const window: any;
declare const CryptoJS: any;

enum UpdateMethod {
  BACKGROUND = 'background',
  AUTO = 'auto',
  NONE = 'none'
}

enum UpdateState {
  Available = 'available',
  Pending = 'pending',
  Ready = 'ready'
}

import {
  FetchManifestResp,
  IAvailableUpdate,
  IDeviceDetails,
  ISavedPreferences,
  ManifestFileEntry
} from './definitions';

import { isPluginConfig } from './guards';


class Path {
  static join(...paths: string[]): string {
    let fullPath: string = paths.shift() || '';
    for (const path of paths) {
      if (fullPath && fullPath.slice(-1) !== '/') {
        fullPath += '/';
      }
      fullPath = path.slice(0, 1) !== '/' ? fullPath + path : fullPath + path.slice(1);
    }
    return fullPath;
  }
}

/**
 * LIVE UPDATE API
 *
 * The plugin API for the live updates feature.
 */
class IonicDeployImpl {
  private readonly appInfo: IAppInfo;
  private _savedPreferences: ISavedPreferences;
  private _fileManager: FileManager = new FileManager();
  private SNAPSHOT_CACHE = 'ionic_built_snapshots';
  private MANIFEST_FILE = 'pro-manifest.json';
  public PLUGIN_VERSION = '5.2.10';
  private lastProgressEvent = 0;

  private coreFiles = [
    /index\.html/,
    /build\/main\.((\w)*\.){0,1}js/,
    /build\/vendor.((\w)*\.){0,1}js/,
    /build\/polyfills\.js/,
  ];

  private integrityCheckTimeout: any;
  private integrityCheckForceValid = false;

  constructor(appInfo: IAppInfo, preferences: ISavedPreferences) {
    this.appInfo = appInfo;
    this._savedPreferences = preferences;
  }

  isCoreFile(file: ManifestFileEntry): boolean {
    return this.coreFiles.some((coreFile) => {
      const regxp = new RegExp(coreFile);
      if (regxp.test(file.href)) {
        return true;
      }

      return false;
    });
  }

  async checkCoreIntegrity(): Promise<boolean> {
    if (this._savedPreferences.currentVersionId) {
      const manifest = await this.getSnapshotManifest(<string>this._savedPreferences.currentVersionId);
      const integrityChecks: ManifestFileEntry[] = [];

      manifest.some((file) => {
        if (integrityChecks.length >= this.coreFiles.length) {
          return true;
        }

        this.coreFiles.some((coreFile) => {
          if (integrityChecks.length >= this.coreFiles.length) {
            return true;
          }

          const regxp = new RegExp(coreFile);
          if (regxp.test(file.href)) {
            integrityChecks.push(file);
          }

          return false;
        });

        return false;
      });

      try {
        await Promise.all(integrityChecks.map(async file => this.checkFileIntegrity(file, <string>this._savedPreferences.currentVersionId)));
      } catch (err) {
        window.broadcaster && window.broadcaster.fireNativeEvent('ionic/DOWNLOAD_WARNING', {
          type: 'coreIntegrity'
        });

        throw err;
      }

      return true;
    }

    return true;
  }

  async checkFileIntegrity(file: ManifestFileEntry, versionId: string): Promise<any> {
    const fileSize = (await this._fileManager.getFileEntryFile(this.getSnapshotCacheDir(versionId), file.href)).size;

    // Can't verify the size of the pro-manifest
    if (file.size === 0) {
      return true;
    }

    const fileSizesMatch = fileSize === file.size;

    if (!fileSizesMatch) {
      window.broadcaster && window.broadcaster.fireNativeEvent('ionic/DOWNLOAD_WARNING', {
        file: file.href,
        type: 'integrity'
      });

      console.log('File size integrity does not match.');

      throw new Error('File size integrity does not match.');
    }

    if (fileSizesMatch && this.isCoreFile(file)) {
      console.log(`Verifying hash of core file ${file.href}.`);
      const fullPath = Path.join(this.getSnapshotCacheDir(versionId), file.href);
      const contents = await this._fileManager.getFile(fullPath);
      const expectedHash = file.integrity.split(' ')[0] || '';
      const contentsWords = CryptoJS.enc.Utf8.parse(contents);
      const contentsHash = CryptoJS.SHA256(contentsWords);
      const base64 = CryptoJS.enc.Base64.stringify(contentsHash);
      const formattedHash = `sha256-${base64}`;
      const hashesMatch = formattedHash === expectedHash;

      if (!hashesMatch) {
        console.log('Core file integrity hash does not match.', file, contents, contentsHash);
      }
    }
  }

  async _handleInitialPreferenceState() {
    // 6 seconds after startup, check core file integrity
    // this timeout is cleared if 'configure' is called (because clearly file integrity is fine if configure was called)
    this.integrityCheckTimeout = setTimeout(() => {
      console.log('CoreFileIntegrityCheck - Starting');
      this.checkCoreIntegrity()
        .then(() => console.log('CoreFileIntegrityCheck - Success')) // do nothing, integrity is fine... )
        .catch((err) => {
          console.log('CoreFileIntegrityCheck - Failed', err);
          if (!this.integrityCheckForceValid) {
            window.broadcaster && window.broadcaster.fireNativeEvent('ionic/DOWNLOAD_ERROR', {});
          }
        });
    }, 6000);

    const isOnline = navigator && navigator.onLine;
    if (!isOnline) {
      console.warn(
        'The device appears to be offline. Loading last available version and skipping update checks.'
      );
      this.reloadApp();
      return;
    }

    const updateMethod = this._savedPreferences.updateMethod;
    switch (updateMethod) {
      case UpdateMethod.AUTO:
        // NOTE: call sync with background as override to avoid sync
        // reloading the app and manually reload always once sync has
        // set the correct currentVersionId
        console.log('calling _sync');
        try {
          await this.sync({ updateMethod: UpdateMethod.BACKGROUND });
        } catch (e) {
          console.warn(e);
          console.warn('Sync failed. Defaulting to last available version.');
        }
        console.log('calling _reload');
        await this.reloadApp();
        console.log('done _reloading');
        break;
      case UpdateMethod.NONE:
        this.reloadApp();
        break;
      default:
        // NOTE: default anything that doesn't explicitly match to background updates
        await this.reloadApp();
        try {
          this.sync({ updateMethod: UpdateMethod.BACKGROUND });
        } catch (e) {
          console.warn(e);
          console.warn('Background sync failed. Unable to check for new updates.');
        }
        return;
    }
  }

  getSnapshotCacheDir(versionId: string): string {
    return Path.join(this.appInfo.dataDirectory, this.SNAPSHOT_CACHE, versionId);
  }

  getBundledAppDir(appId?: string): string {
    let folder = 'www';
    if (typeof Capacitor !== 'undefined') {
      folder = 'public';
    }

    const dir = Path.join(cordova.file.applicationDirectory, folder);

    if (appId) {
      return Path.join(dir, appId);
    }

    return dir;
  }

  private async _savePrefs(prefs: ISavedPreferences): Promise<ISavedPreferences> {
    return new Promise<ISavedPreferences>(async (resolve, reject) => {
      try {
        cordova.exec(
          async (savedPrefs: ISavedPreferences) => {
            resolve(savedPrefs);
          },
          reject,
          'IonicCordovaCommon',
          'setPreferences',
          [prefs]
        );
      } catch (e) {
        reject(e.message);
      }
    });
  }

  async configure(config: IDeployConfig) {
    clearTimeout(this.integrityCheckTimeout);
    this.integrityCheckForceValid = true;

    if (!isPluginConfig(config)) {
      throw new Error('Invalid Config Object');
    }
    await new Promise((resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'configure', [config]);
    });
    Object.assign(this._savedPreferences, config);
    this._savePrefs(this._savedPreferences);

  }

  async checkForUpdate(): Promise<CheckDeviceResponse> {
    const isOnline = navigator && navigator.onLine;
    if (!isOnline) {
      throw new Error('The device is offline.');
    }

    const prefs = this._savedPreferences;
    const appInfo = this.appInfo;

    // check if apoplicaiton switch to reference app
    // if so copy bundle file over
    // skip download
    // reloadApp()
    prefs.switchToReference =
      prefs.currentVersionId !== undefined &&
      prefs.currentVersionForAppId !== prefs.appId &&
      prefs.appId === '5fc6b2fe';

    console.log('checkForUpdate: ' + JSON.stringify(prefs));

    if (prefs.switchToReference) {
      delete prefs.availableUpdate;
      prefs.currentVersionId = 'bundle';
      prefs.currentVersionForAppId = '5fc6b2fe';
      prefs.updates['bundle'] = <IAvailableUpdate>{
        binaryVersionCode: prefs.binaryVersionCode,
        binaryVersionName: prefs.binaryVersionName,
        channel: prefs.channel,
        state: 'ready',
        lastUsed: '',
        url: '',
        versionId: 'bundle'
      };
      await this._savePrefs(prefs);

      return <CheckDeviceResponse>{
        available: true,
        compatible: false,
        partial: false
      };
    } else {
      const endpoint = `${prefs.host}/apps/${prefs.appId}/channels/check-device`;

      const device_details = <IDeviceDetails>{
        binary_version: prefs.binaryVersionName,
        device_id: appInfo.device || null,
        platform: appInfo.platform,
        platform_version: appInfo.platformVersion
      };

      if (prefs.currentVersionId && prefs.currentVersionId !== 'bundle') {
        device_details.snapshot = prefs.currentVersionId;
      }

      const body = {
        channel_name: prefs.channel,
        app_id: prefs.appId,
        device: device_details,
        plugin_version: this.PLUGIN_VERSION,
        manifest: true
      };

      const timeout = new Promise((resolve, reject) => {
        setTimeout(reject, 15000, 'Request timed out. The device maybe offline.');
      });
      const request = fetch(endpoint, {
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify(body)
      });

      const resp = await (Promise.race([timeout, request]) as Promise<Response>);

      let jsonResp;
      if (resp.status < 500) {
        jsonResp = await resp.json();
      }
      if (resp.ok) {
        const checkDeviceResp: CheckDeviceResponse = jsonResp.data;
        if (checkDeviceResp.available && checkDeviceResp.url && checkDeviceResp.snapshot) {
          prefs.availableUpdate = {
            binaryVersionCode: prefs.binaryVersionCode,
            binaryVersionName: prefs.binaryVersionName,
            channel: prefs.channel,
            state: UpdateState.Available,
            lastUsed: new Date().toISOString(),
            url: checkDeviceResp.url,
            versionId: checkDeviceResp.snapshot
          };
          await this._savePrefs(prefs);
        }
        return checkDeviceResp;
      }

      throw new Error(
        `Error Status ${resp.status}: ${jsonResp ? jsonResp.error.message : await resp.text()}`
      );
    }
  }

  async downloadUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    this.lastProgressEvent = 0;
    const prefs = this._savedPreferences;
    if (prefs.switchToReference) {
      // it is an application switch, in this case we don't download anything
      await this._copyBundleToSnapshot();
      return true;
    } else if (prefs.availableUpdate && prefs.availableUpdate.state === UpdateState.Available) {
      // Async fetch manifest while preparing the update directory
      const [{ fileBaseUrl, manifestJson }] = await Promise.all([
        this._fetchManifest(prefs.availableUpdate.url),
        this.prepareUpdateDirectory(prefs.availableUpdate.versionId)
      ]);

      // Diff new to snapshot, seperate any we already have
      const diffedManifest = await this._diffManifests(
        manifestJson,
        prefs.availableUpdate.versionId
      );

      // Download the files
      try {
        await this._downloadFilesFromManifest(fileBaseUrl, diffedManifest,  prefs.availableUpdate.versionId, progress);
      } catch (err) {
        console.log('CAUGHT ERROR - DOWNLOAD', err);

        throw err;
      }

      prefs.availableUpdate.state = UpdateState.Pending;

      await this._savePrefs(prefs);

      return true;
    }
    return false;
  }

  private async _downloadFilesFromManifest(
    baseUrl: string,
    manifest: ManifestFileEntry[],
    versionId: string,
    progress?: CallbackFunction<number>
  ) {
    console.log('Downloading update...');

    let size = 0, downloaded = 0;
    const concurrent = 5;

    manifest.forEach(i => {
      size += i.size;
    });

    const reportProgress = () => {
      const percentage = Math.floor((downloaded / size) * 100);

      if (percentage === this.lastProgressEvent) {
        return;
      }

      this.lastProgressEvent = percentage;
      progress && progress(percentage);
    };

    const beforeDownloadTimer = new Timer('downloadTimer');
    const downloadFile = async (file: ManifestFileEntry) => {
      console.log('Downloading ionic update file: ', file.href);
      const base = new URL(baseUrl);
      const newUrl = new URL(file.href, baseUrl);
      newUrl.search = base.search;
      const filePath = Path.join(this.getSnapshotCacheDir(versionId), file.href);
      let bytesLoaded = 0;

      try {
        bytesLoaded = await this._fileManager.downloadAndWriteFile(file, newUrl.toString(), filePath, (bytes) => {
          if (bytes) {
            downloaded += bytes;
            reportProgress();
          }
        });
      } catch (err) {
        window.broadcaster && window.broadcaster.fireNativeEvent('ionic/DOWNLOAD_WARNING', {
          file: file.href,
          type: 'http'
        });

        throw err;
      }

      // After download, check file integrity
      await this.checkFileIntegrity(file, versionId);

      // Report download, removing already reported
      downloaded += file.size - bytesLoaded;
      reportProgress();
    };

    const downloads: ManifestFileEntry[] = [];
    console.log(`Downloading ${manifest.length} new files...`);
    for (const entry of manifest) {
      downloads.push(entry);
    }

    await this.asyncPoolDownloads(concurrent, downloads, async (entry: ManifestFileEntry) => {
      try {
        await downloadFile(entry);
      } catch (err) {
        await downloadFile(entry); // retry once, if failed, bubble error
      }
    });

    console.log(`Files downloaded.`);

    beforeDownloadTimer.end(`Downloaded ${manifest.length} files`);
  }

  async asyncPoolDownloads(poolLimit: number, array: any[], iteratorFn: Function) {
    const realPoolLimit = poolLimit >= array.length ? array.length : poolLimit;
    const ret = [];
    const executing: any[] = [];
    for (const item of array) {
      const p = Promise.resolve().then(() => iteratorFn(item, array));
      ret.push(p);
      const e: any = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= realPoolLimit) {
        await Promise.race(executing);
      }
    }
    return Promise.all(ret);
  }

  private async _fetchManifest(url: string): Promise<FetchManifestResp> {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow'
    });
    return {
      fileBaseUrl: resp.url,
      manifestJson: await resp.json()
    };
  }

  private async _diffManifests(newManifest: ManifestFileEntry[], versionId: string) {
    let snapshotManifest: any[] = [];
    try {
      snapshotManifest = await this.getSnapshotManifest(versionId);
    } catch (err) {
      snapshotManifest = [];
    }

    try {
      const snapManifestStrings = snapshotManifest.map(entry => JSON.stringify(entry));
      const differences = newManifest.filter(entry => snapManifestStrings.indexOf(JSON.stringify(entry)) === -1);

      // Append pro-manifest.json if there are differences
      if (differences.length > 0) {
        differences.push({ href: 'pro-manifest.json', integrity: 'void', size: 0 });
      }

      return differences;
    } catch (e) {
      return newManifest;
    }
  }

  private async prepareUpdateDirectory(versionId: string) {
    await this._cleanSnapshotDir(versionId);
    console.log('Cleaned version directory');

    await this._copyBaseAppDir(versionId);
    console.log('Copied base app resources');
  }

  async extractUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    const prefs = this._savedPreferences;

    if (prefs.switchToReference) {
      return true;
    }

    if (!prefs.availableUpdate || prefs.availableUpdate.state !== UpdateState.Pending) {
      return false;
    }

    if (progress) {
      progress(100);
    }

    prefs.availableUpdate.state = UpdateState.Ready;
    prefs.updates[prefs.availableUpdate.versionId] = prefs.availableUpdate;
    await this._savePrefs(prefs);
    return true;
  }

  async reloadApp(): Promise<boolean> {
    const prefs = this._savedPreferences;

    if (prefs.switchToReference) {
      prefs.switchToReference = false;
      await this._savePrefs(prefs);
    }

    // Save the current update if it's ready
    if (prefs.availableUpdate && prefs.availableUpdate.state === UpdateState.Ready) {
      prefs.currentVersionId = prefs.availableUpdate.versionId;
      prefs.currentVersionForAppId = prefs.appId;
      delete prefs.availableUpdate;
      await this._savePrefs(prefs);
    }

    // Clean current version if its stale
    await this.cleanCurrentVersionIfStale();

    // Is there a non-binary version deployed?
    if (prefs.currentVersionId) {
      // Are we already running the deployed version?
      if (await this._isRunningVersion(prefs.currentVersionId)) {
        console.log(`Already running version ${prefs.currentVersionId}`);
        prefs.currentVersionForAppId = prefs.appId;
        await this._savePrefs(prefs);
        channel.onIonicProReady.fire();
        Ionic.WebView.persistServerBasePath();
        this.cleanupVersions(); // don't wait to cleanup versions, do it in the bg
        return false;
      }

      // Is the current version on the device?
      if (!(prefs.currentVersionId in prefs.updates) && prefs.currentVersionId !== 'bundle') {
        console.error(`Missing version ${prefs.currentVersionId}`);
        channel.onIonicProReady.fire();
        return false;
      }

      // Reload the webview
      const newLocation = new URL(this.getSnapshotCacheDir(prefs.currentVersionId));
      console.log('setServerBasePath: ' + newLocation.pathname);
      Ionic.WebView.setServerBasePath(newLocation.pathname);
      return true;
    }

    channel.onIonicProReady.fire();
    return false;
  }

  // compare an update to the current version using both name & code
  private isCurrentVersion(update: IAvailableUpdate) {
    const currentVersionCode = this._savedPreferences.binaryVersionCode;
    const currentVersionName = this._savedPreferences.binaryVersionName;
    console.log(`Current: versionCode: ${currentVersionCode} versionName: ${currentVersionName}`);
    console.log(
      `update: versionCode: ${update.binaryVersionCode} versionName: ${update.binaryVersionName}`
    );
    return (
      update.binaryVersionName === currentVersionName &&
      update.binaryVersionCode === currentVersionCode
    );
  }

  public async cleanCurrentVersionIfStale() {
    const prefs = this._savedPreferences;
    // Is the current version built from a previous binary?
    if (prefs.currentVersionId) {
      if (!this.isCurrentVersion(prefs.updates[prefs.currentVersionId]) && !this._isRunningVersion(prefs.currentVersionId) ) {
        console.log(
          `Update ${
            prefs.currentVersionId
          } was built for different binary version, updating cordova assets...` +
            `Update binaryVersionName: ${
              prefs.updates[prefs.currentVersionId].binaryVersionName
            }, Device binaryVersionName ${prefs.binaryVersionName}` +
            `Update binaryVersionCode: ${
              prefs.updates[prefs.currentVersionId].binaryVersionCode
            }, Device binaryVersionCode ${prefs.binaryVersionCode}`
        );

        console.log('Ionic: Cleaning stale assets...');

        // We need to ensure some plugins and other files are copied from bundled to snapshot
        // this ensure plugins js are not out of date.
        const snapshotDirectory = this.getSnapshotCacheDir(prefs.currentVersionId);
        const bundledAppDir = this.getBundledAppDir();

        try {
          // Copy directories over (they are removed first)
          console.log('Ionic: Copying cordova directories...');
          await this._fileManager.copyDirectory(
            Path.join(bundledAppDir, 'plugins'),
            snapshotDirectory,
            'plugins'
          );
          await this._fileManager.copyDirectory(
            Path.join(bundledAppDir, 'cordova-js-src'),
            snapshotDirectory,
            'cordova-js-src'
          );
          await this._fileManager.copyDirectory(
            Path.join(bundledAppDir, 'task'),
            snapshotDirectory,
            'task'
          );

          // Copy files over
          console.log('Ionic: Copying cordova files...');
          await this._fileManager.removeFile(snapshotDirectory, 'cordova.js');
          await this._fileManager.removeFile(snapshotDirectory, 'cordova_plugins.js');
          await this._fileManager.copyTo(bundledAppDir, 'cordova.js', snapshotDirectory, 'cordova.js');
          await this._fileManager.copyTo(bundledAppDir, 'cordova_plugins.js', snapshotDirectory, 'cordova_plugins.js');

          // IOS only
          if (this.appInfo.platform === 'ios') {
            console.log('Ionic: Copying ios specific files...');
            await this._fileManager.removeFile(snapshotDirectory, 'wk-plugin.js');
            await this._fileManager.copyTo(bundledAppDir, 'wk-plugin.js', snapshotDirectory, 'wk-plugin.js');
          }
        } catch (err) {
          console.log(err);
        }

        // Switch the updates binary version name
        prefs.updates[prefs.currentVersionId].binaryVersionName = prefs.binaryVersionName;
        prefs.updates[prefs.currentVersionId].binaryVersionCode = prefs.binaryVersionCode;

        // Save prefs to stop this happening again
        return await this._savePrefs(prefs);
      }
    }
  }

  private async _isRunningVersion(versionId: string) {
    const currentPath = await this._getServerBasePath();
    return currentPath.includes(versionId);
  }

  private async _getServerBasePath(): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
      try {
        Ionic.WebView.getServerBasePath(resolve);
      } catch (e) {
        reject(e);
      }
    });
  }

  private async _cleanSnapshotDir(versionId: string) {
    const timer = new Timer('CleanSnapshotDir');
    const snapshotDir = this.getSnapshotCacheDir(versionId);
    try {
      const dirEntry = await this._fileManager.getDirectory(snapshotDir, false);
      await new Promise((resolve, reject) => dirEntry.removeRecursively(resolve, reject));
      timer.end();
    } catch (e) {
      console.log('No directory found for snapshot no need to delete');
      timer.end();
    }
  }

  private async _copyBundleToSnapshot() {
    return new Promise(async (resolve, reject) => {
      try {
        const copyFrom = this.getBundledAppDir();
        const rootAppDirEntry = await this._fileManager.getDirectory(copyFrom, false);
        const snapshotCacheDirEntry = await this._fileManager.getDirectory(
          this.getSnapshotCacheDir(''),
          true
        );

        await this._cleanSnapshotDir('bundle');

        rootAppDirEntry.copyTo(snapshotCacheDirEntry, 'bundle', resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  private async _copyBaseAppDir(versionId: string) {
    const timer = new Timer('CopyBaseApp');
    return new Promise(async (resolve, reject) => {
      try {
        const prefs = this._savedPreferences;
        const currentVersion = await this.getCurrentVersion();
        const isDefaultApp = await this.isDefaultApp();
        const switchingApps = !(currentVersion && prefs.currentVersionForAppId === prefs.appId);

        // If not default, create direct, copy bundled club app, then copy over
        // plugins, cordova-js-src, tasks, cordova.js, cordova_plugins.js

        // Bundled? check if has current version, otherwise copy bundled app over
        const copyFrom = !switchingApps
          ? this.getSnapshotCacheDir(<string>this._savedPreferences.currentVersionId)
          : isDefaultApp
          ? this.getBundledAppDir()
          : this.getBundledAppDir();

        const rootAppDirEntry = await this._fileManager.getDirectory(copyFrom, false);
        const snapshotCacheDirEntry = await this._fileManager.getDirectory(
          this.getSnapshotCacheDir(''),
          true
        );

        rootAppDirEntry.copyTo(
          snapshotCacheDirEntry,
          versionId,
          () => {
            timer.end();
            resolve();
          },
          reject
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  async getCurrentVersion(): Promise<ISnapshotInfo | undefined> {
    const versionId = this._savedPreferences.currentVersionId;
    if (typeof versionId === 'string') {
      return this.getVersionById(versionId);
    }
    return;
  }

  async getVersionById(versionId: string): Promise<ISnapshotInfo> {
    const update = this._savedPreferences.updates[versionId];
    if (!update) {
      throw Error(`No update available with versionId ${versionId}`);
    }
    return this._convertToSnapshotInfo(update);
  }

  private _convertToSnapshotInfo(update: IAvailableUpdate): ISnapshotInfo {
    return {
      deploy_uuid: update.versionId,
      versionId: update.versionId,
      channel: update.channel,
      binary_version: update.binaryVersionName,
      binaryVersion: update.binaryVersionName,
      binaryVersionCode: update.binaryVersionCode,
      binaryVersionName: update.binaryVersionName
    };
  }

  async getSnapshotManifest(versionId: string): Promise<ManifestFileEntry[]> {
    return this.parseManifestFile(this.getSnapshotCacheDir(versionId));
  }

  async parseManifestFile(dir: string): Promise<ManifestFileEntry[]> {
    let fileContents = '[]';

    try {
      fileContents = await this._fileManager.getFile(
        Path.join(dir, this.MANIFEST_FILE)
      );
    } catch (err) {
      // do nothing, use fresh
    }

    try {
      const manifest = JSON.parse(<string>fileContents);
      return manifest;
    } catch (err) {
      console.error('Could not parse JSON:', fileContents);
    }

    return [];
  }

  async isDefaultApp(): Promise<boolean> {
    return Promise.resolve(this._savedPreferences.appId === '5fc6b2fe');
  }

  async getAvailableVersions(): Promise<ISnapshotInfo[]> {
    return Object.keys(this._savedPreferences.updates).map(k =>
      this._convertToSnapshotInfo(this._savedPreferences.updates[k])
    );
  }

  async deleteVersionById(versionId: string): Promise<boolean> {
    const prefs = this._savedPreferences;

    if (prefs.currentVersionId === versionId) {
      throw Error(`Can't delete version with id: ${versionId} as it is the current version.`);
    }

    delete prefs.updates[versionId];
    await this._savePrefs(prefs);

    // delete snapshot directory
    await this._cleanSnapshotDir(versionId);

    return true;
  }

  private getStoredUpdates() {
    // get an array of stored updates minus current deployed one
    const prefs = this._savedPreferences;
    const updates = [];
    for (const versionId of Object.keys(prefs.updates)) {
      // don't clean up the current version
      if (versionId !== prefs.currentVersionId) {
        updates.push(prefs.updates[versionId]);
      }
    }
    return updates;
  }

  private async cleanupVersions() {
    // const prefs = this._savedPreferences;

    // let updates = this.getStoredUpdates();
    // First clean stale versions
    /*for (const update of updates) {
      if (!this.isCurrentVersion(update)) {
        console.log(
          `Update ${update.versionId} was built for different binary version removing update from device` +
          `Update binaryVersionName: ${update.binaryVersionName}, Device binaryVersionName ${prefs.binaryVersionName}` +
          `Update binaryVersionCode: ${update.binaryVersionCode}, Device binaryVersionCode ${prefs.binaryVersionCode}`
        );
        await this.deleteVersionById(update.versionId);
      }
    }*/

    // clean down to Max Updates stored
    let updates = this.getStoredUpdates();
    updates = updates.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
    updates = updates.reverse();
    updates = updates.slice(3);

    for (const update of updates) {
      await this.deleteVersionById(update.versionId);
    }
  }

  async sync(syncOptions: ISyncOptions = {}): Promise<ISnapshotInfo | undefined> {
    const prefs = this._savedPreferences;

    // TODO: Get API override if present?
    const updateMethod = syncOptions.updateMethod || prefs.updateMethod;

    await this.checkForUpdate();

    if (prefs.availableUpdate) {
      if (prefs.availableUpdate.state === UpdateState.Available) {
        await this.downloadUpdate();
      }
      if (prefs.availableUpdate.state === UpdateState.Pending) {
        await this.extractUpdate();
      }
      if (prefs.availableUpdate.state === UpdateState.Ready && updateMethod === UpdateMethod.AUTO) {
        await this.reloadApp();
      }
    }

    if (prefs.currentVersionId) {
      return {
        deploy_uuid: prefs.currentVersionId,
        versionId: prefs.currentVersionId,
        channel: prefs.channel,
        binary_version: prefs.binaryVersionName,
        binaryVersion: prefs.binaryVersionName,
        binaryVersionCode: prefs.binaryVersionCode,
        binaryVersionName: prefs.binaryVersionName
      };
    }
    return;
  }
}

class FileManager {
  async getDirectory(path: string, createDirectory = true): Promise<DirectoryEntry> {
    return new Promise<DirectoryEntry>((resolve, reject) => {
      resolveLocalFileSystemURL(
        path,
        entry => (entry.isDirectory ? resolve(entry as DirectoryEntry) : reject()),
        async () => {
          const components = path.split('/');
          const child = components.pop() as string;
          try {
            const parent = (await this.getDirectory(
              components.join('/'),
              createDirectory
            )) as DirectoryEntry;
            parent.getDirectory(
              child,
              { create: createDirectory },
              async entry => {
                if (entry.fullPath === path) {
                  resolve(entry);
                } else {
                  resolve(await this.getDirectory(path, createDirectory));
                }
              },
              reject
            );
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }

  async resolvePath(): Promise<DirectoryEntry> {
    return new Promise<DirectoryEntry>((resolve, reject) => {
      resolveLocalFileSystemURL(
        cordova.file.dataDirectory,
        (rootDirEntry: Entry) => {
          resolve(rootDirEntry as DirectoryEntry);
        },
        reject
      );
    });
  }

  async getFile(fullPath: string): Promise<string> {
    const normalizedURL = Ionic.WebView.convertFileSrc(fullPath);
    const req = await fetch(normalizedURL);
    return req.text();
  }

  async getFileEntry(path: string, fileName: string) {
    const dirEntry = await this.getDirectory(path, false);
    return new Promise<FileEntry>((resolve, reject) => {
      dirEntry.getFile(fileName, { create: false, exclusive: false }, resolve, reject);
    });
  }

  async getFileEntryFile(path: string, fileName: string): Promise<File> {
    const fileEntry = await this.getFileEntry(path, fileName);
    return new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
  }

  async fileExists(path: string, fileName: string) {
    try {
      await this.getFileEntry(path, fileName);
      return true;
    } catch (e) {
      return false;
    }
  }

  async copyTo(oldPath: string, oldFileName: string, newPath: string, newFileName: string) {
    const fileEntry = await this.getFileEntry(oldPath, oldFileName);
    const newDirEntry = await this.getDirectory(newPath);
    return new Promise((resolve, reject) => {
      console.log(`Copying file '${oldPath}', '${oldFileName}', '${newPath}', ${newFileName}`);
      fileEntry.copyTo(newDirEntry, newFileName, resolve, reject);
    });
  }

  async removeFile(path: string, filename: string) {
    const fileEntry = await this.getFileEntry(path, filename);
    return new Promise((resolve, reject) => {
      console.log(`Removing file '${path}', '${filename}`);
      fileEntry.remove(resolve, reject);
    });
  }

  async removeDir(dir: string) {
    const dirEntry = await this.getDirectory(dir);
    return new Promise((resolve, reject) => {
      console.log(`Removing Directory ${dir}`);
      dirEntry.removeRecursively(resolve, reject);
    });
  }

  async copyDirectory(from: string, to: string, dirName: string) {
    await this.removeDir(Path.join(to, dirName));
    const fromEntry = await this.getDirectory(from);
    const toEntry = await this.getDirectory(to);
    return new Promise((resolve, reject) => {
      console.log(`Copying Directory '${from}', '${to}', '${dirName}`);
      fromEntry.copyTo(toEntry, dirName, resolve, reject);
    });
  }

  async downloadAndWriteFile(file: ManifestFileEntry, url: string, path: string, progressFn: CallbackFunction<number> = () => void 0): Promise<number> {
    const fileT = new FileTransfer();
    let loaded = 0;

    // On progress, increment total progress
    fileT.onprogress = (progress) => {
      if (progress.loaded) {
        progressFn(progress.loaded - loaded);
        loaded = progress.loaded;
      }
    };

    return new Promise<number>((resolve, reject) => {
      fileT.download(url, path, () => {
        console.log('Download of ionic update file complete.', url);
        resolve(loaded);
      }, reject, true);
    });
  }
}

class IonicDeploy implements IDeployPluginAPI {
  private parent: IPluginBaseAPI;
  private delegate: Promise<IonicDeployImpl>;
  private fetchIsAvailable: boolean;
  private lastPause = 0;
  private minBackgroundDuration = 10;
  private disabled = false;
  public supportsPartialNativeUpdates = true;

  constructor(parent: IPluginBaseAPI) {
    this.parent = parent;
    this.delegate = this.initialize();
    this.fetchIsAvailable = typeof fetch === 'function';
    document.addEventListener('deviceready', this.onLoad.bind(this));
  }

  async initialize() {
    const preferences = await this._initPreferences();
    this.minBackgroundDuration = preferences.minBackgroundDuration;
    this.disabled = preferences.disabled || !this.fetchIsAvailable;
    const appInfo = await this.parent.getAppDetails();
    const delegate = new IonicDeployImpl(appInfo, preferences);
    // Only initialize start the plugin if fetch is available and DisableDeploy preference is false
    if (this.disabled) {
      let disabledMessage = 'cordova-plugin-ionic has been disabled.';
      if (!this.fetchIsAvailable) {
        disabledMessage = 'Fetch is unavailable so ' + disabledMessage;
      }
      console.warn(disabledMessage);
      channel.onIonicProReady.fire();
    } else {
      await delegate._handleInitialPreferenceState();
    }

    return delegate;
  }

  async onLoad() {
    document.addEventListener('pause', this.onPause.bind(this));
    document.addEventListener('resume', this.onResume.bind(this));
    await this.onResume();
  }

  async onPause() {
    this.lastPause = Date.now();
  }

  async onResume() {
    if (
      !this.disabled &&
      this.lastPause &&
      this.minBackgroundDuration &&
      Date.now() - this.lastPause > this.minBackgroundDuration * 1000
    ) {
      await (await this.delegate)._handleInitialPreferenceState();
    }
  }
  async _initPreferences(): Promise<ISavedPreferences> {
    return new Promise<ISavedPreferences>(async (resolve, reject) => {
      try {
        channel.onNativeReady.subscribe(async () => {
          // timeout to let browser proxy to init
          window.setTimeout(function() {
            cordova.exec(
              async (prefs: ISavedPreferences) => {
                resolve(prefs);
              },
              reject,
              'IonicCordovaCommon',
              'getPreferences'
            );
          }, 0);
        });
      } catch (e) {
        channel.onIonicProReady.fire();
        reject(e.message);
      }
    });
  }

  async checkForUpdate(): Promise<CheckDeviceResponse> {
    if (!this.disabled) {
      return (await this.delegate).checkForUpdate();
    }
    return { available: false, compatible: false, partial: false };
  }

  async configure(config: IDeployConfig): Promise<void> {
    if (!this.disabled) return (await this.delegate).configure(config);
  }

  async getConfiguration(): Promise<ICurrentConfig> {
    return new Promise<ICurrentConfig>(async (resolve, reject) => {
      try {
        cordova.exec(
          async (prefs: ISavedPreferences) => {
            if (prefs.availableUpdate) {
              delete prefs.availableUpdate;
            }
            if (prefs.updates) {
              delete prefs.updates;
            }
            resolve(prefs);
          },
          reject,
          'IonicCordovaCommon',
          'getPreferences'
        );
      } catch (e) {
        reject(e.message);
      }
    });
  }

  async deleteVersionById(version: string): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).deleteVersionById(version);
    return true;
  }

  async downloadUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).downloadUpdate(progress);
    return false;
  }

  async extractUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).extractUpdate(progress);
    return false;
  }

  async getAvailableVersions(): Promise<ISnapshotInfo[]> {
    if (!this.disabled) return (await this.delegate).getAvailableVersions();
    return [];
  }

  async getCurrentVersion(): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).getCurrentVersion();
    return;
  }

  async getVersionById(versionId: string): Promise<ISnapshotInfo> {
    if (!this.disabled) return (await this.delegate).getVersionById(versionId);
    throw Error(`No update available with versionId ${versionId}`);
  }

  async reloadApp(): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).reloadApp();
    return false;
  }

  async sync(syncOptions: ISyncOptions = {}): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).sync(syncOptions);
    return;
  }
}

/**
 * BASE API
 *
 * All features of the Ionic Cordova plugin are registered here, along with some low level error tracking features used
 * by the monitoring service.
 */
class IonicCordova implements IPluginBaseAPI {
  public deploy: IDeployPluginAPI;

  constructor() {
    this.deploy = new IonicDeploy(this);
  }

  getAppInfo(success: CallbackFunction<IAppInfo>, failure: CallbackFunction<string>) {
    console.warn('This function has been deprecated in favor of IonicCordova.getAppDetails.');
    this.getAppDetails().then(
      result => success(result),
      err => {
        typeof err === 'string' ? failure(err) : failure(err.message);
      }
    );
  }

  async getAppDetails(): Promise<IAppInfo> {
    return new Promise<IAppInfo>((resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'getAppInfo');
    });
  }
}

class Timer {
  name: string;
  startTime: Date;
  lastTime: Date;
  constructor(name: string) {
    this.name = name;
    this.startTime = new Date();
    this.lastTime = new Date();
    // console.log(`Starting IonicTimer ${this.name}`);
  }

  end(extraLog?: string) {
    // console.log(`Finished IonicTimer ${this.name} in ${(new Date().getTime() - this.startTime.getTime()) / 1000} seconds.`);
    if (extraLog) {
      // console.log(`IonicTimer extra ${extraLog}`);
    }
  }

  diff(message?: string) {
    // console.log(`Message: ${message} Diff IonicTimer ${this.name} in ${(new Date().getTime() - this.lastTime.getTime()) / 1000} seconds.`);
    this.lastTime = new Date();
  }
}

const instance = new IonicCordova();
export = instance;
