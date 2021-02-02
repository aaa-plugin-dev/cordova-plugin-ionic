/// <reference types="cordova" />
/// <reference types="cordova-plugin-file" />

import {
  CallbackFunction,
  CheckForUpdateResponse,
  IAppInfo,
  ICurrentConfig,
  IDeployConfig,
  IPluginBaseAPI,
  ISnapshotInfo,
  ISyncOptions,
} from './IonicCordova';
import { CancelToken } from './tokens';

declare const cordova: Cordova;

const channel = cordova.require('cordova/channel');
channel.createSticky('onIonicProReady');
channel.waitForInitialization('onIonicProReady');

declare const resolveLocalFileSystemURL: Window['resolveLocalFileSystemURL'] ;
declare const Ionic: any;
declare const Capacitor: any;
declare const window: any;

enum UpdateMethod {
  BACKGROUND = 'background',
  AUTO = 'auto',
  NONE = 'none',
}

enum UpdateState {
  Available = 'available',
  Pending = 'pending',
  Ready = 'ready',
}

import {
  FetchManifestResp,
  IAvailableUpdate,
  IDeviceDetails,
  ISavedPreferences,
  ManifestFileEntry,
} from './definitions';

import {
  isPluginConfig
} from './guards';

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
  public PLUGIN_VERSION = '5.4.7';

  private coreIonic5Files = [
    /^runtime\.(\w)*\.js/,
    /^polyfills-(\w)*\.(\w)*\.js/,
    /^polyfills\.(\w)*\.js/,
    /^cordova\.(\w)*\.js/,
    /^main\.(\w)*\.js/,
  ];

  private coreIonic3Files = [
    /build\/main\.((\w)*\.){0,1}js/,
    /build\/vendor.((\w)*\.){0,1}js/,
    /build\/polyfills\.js/,
  ];

  private integrityCheckTimeout: any;

  constructor(appInfo: IAppInfo, preferences: ISavedPreferences) {
    this.appInfo = appInfo;
    this._savedPreferences = preferences;
  }

  isCoreFile(file: ManifestFileEntry): boolean {
    return this.coreIonic5Files.some((coreFile) => {
      const regxp = new RegExp(coreFile);
      if (regxp.test(file.href)) {
        return true;
      }

      return false;
    });
  }

  async checkCoreIntegrity(): Promise<boolean> {
    if (this._savedPreferences.currentVersionId) {
      try {
        const manifest = await this.getSnapshotManifest(this._savedPreferences.currentVersionId);

        if (!manifest || manifest.length === 0) {
          console.log('Deploy => checkCoreIntegrity false because no manifest file');
          return false;
        }

        let integrityChecks = this.filterIonicCoreFies(manifest, this.coreIonic5Files);
        if (integrityChecks.length === 0) {
          console.log('Deploy => Ionic app is Ionic 3 app get this files');
          integrityChecks = this.filterIonicCoreFies(manifest, this.coreIonic3Files);
        }

        if (integrityChecks.length === 0) {
          console.log('Deploy => No core files to check, weired...');
          return true;
        }

        await Promise.all(integrityChecks.map(async file => this.checkFileIntegrity(file, <string>this._savedPreferences.currentVersionId)));
      } catch (error) {
        console.log(`Deploy => Core File Check Error: ${error}`);
        this.sendEvent('onIntegrityCheckFailed', {
          type: 'coreIntegrity'
        });
        return false;
      }
    }

    return true;
  }

  private filterIonicCoreFies(manifest: ManifestFileEntry[], coreFiles: RegExp[]): ManifestFileEntry[] {
    const integrityChecks: ManifestFileEntry[] = [];
    manifest.some((file) => {
      if (integrityChecks.length >= coreFiles.length) {
        return true;
      }
      coreFiles.some((coreFile) => {
        if (integrityChecks.length >= coreFiles.length) {
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

    return integrityChecks;
  }

  async checkFileIntegrity(file: ManifestFileEntry, versionId: string): Promise<any> {
    // Can't verify the size of the pro-manifest
    if (file.size === 0) {
      console.log(`Deploy => checkFileIntegrity => no manifest file size for file '${file.href}' -> can't check`);
      return true;
    }

    const fileSize = (await this._fileManager.getFileEntryFile(this.getSnapshotCacheDirPath(versionId), file.href)).size;
    let fileSizesMatch = false;

    if (file.href === 'index.html') {
      if (fileSize === 0) {
        throw new Error(`File size integrity does not match for ${file.href}.`);
      }
      fileSizesMatch = true; // AppFlow build updates index.html after manifest was created, file sizes never match
    } else {
      fileSizesMatch = fileSize === file.size;
      if (!fileSizesMatch) {
        this.sendEvent('onIntegrityCheckFailed', {
          type: 'integrity',
          file: file.href
        });
        throw new Error(`File size integrity does not match for ${file.href}.`);
      }
    }

    return fileSizesMatch;

    // We do not use the result of this check hence it is better not to execute this step
    // --
    // if (fileSizesMatch && this.isCoreFile(file)) {
    //   const fullPath = Path.join(this.getSnapshotCacheDirPath(versionId), file.href);
    //   const contents = await this._fileManager.getFile(fullPath);
    //   const expectedHash = file.integrity.split(' ')[0] || '';
    //   const contentsWords = CryptoJS.enc.Utf8.parse(contents);
    //   const contentsHash = CryptoJS.SHA256(contentsWords);
    //   const base64 = CryptoJS.enc.Base64.stringify(contentsHash);
    //   const formattedHash = `sha256-${base64}`;
    //   const hashesMatch = formattedHash === expectedHash;

    //   if (!hashesMatch) {
    //     console.log('Deploy => Core file integrity hash does not match.', file, contents, contentsHash);
    //   }
    // }
  }

  async _handleInitialPreferenceState() {    
    const isSnapshotGood = await this.checkCoreIntegrity();
    console.log(`Deploy => Snapshop folder is: ${isSnapshotGood}`)
    if (!isSnapshotGood) {
      this.sendEvent('onCoreFileIntegrityCheckFailed', {});
      await this.resetToBundle();
      return;
    }

    await this.cleanCurrentVersionIfStale();
    const isOnline = navigator && navigator.onLine;
    if (!isOnline) {
      console.warn('Deploy => The device appears to be offline. Loading last available version and skipping update checks.');
      this.reloadApp();
      return;
    }

    const updateMethod = this._savedPreferences.updateMethod;
    switch (updateMethod) {
      case UpdateMethod.AUTO:
        // NOTE: call sync with background as override to avoid sync
        // reloading the app and manually reload always once sync has
        // set the correct currentVersionId
        console.log('Deploy => calling _sync');
        try {
          const cancelToken = new CancelToken();
          await this.sync({updateMethod: UpdateMethod.BACKGROUND}, cancelToken);
        } catch (e) {
          console.warn(`Deploy => ${e}`);
          console.warn('Deploy => Sync failed. Defaulting to last available version.');
        }
        console.log('Deploy => calling _reload');
        await this.reloadApp();
        console.log('Deploy => done _reloading');
        break;
      case UpdateMethod.NONE:
        this.reloadApp();
        break;
      default:
        // NOTE: default anything that doesn't explicitly match to background updates
        await this.reloadApp();
        try {
          const cancelToken = new CancelToken();
          this.sync({updateMethod: UpdateMethod.BACKGROUND}, cancelToken);
        } catch (e) {
          console.warn(`Deploy => ${e}`);
          console.warn('Deploy => Background sync failed. Unable to check for new updates.');
        }
        return;
    }
  }

  async resetToBundle(): Promise<boolean> {
    const prefs = this._savedPreferences;
    const customPrefs = {
      appId: prefs.nativeAppId
    };
    await this.configure(customPrefs);

    if (this.appInfo.platform === 'ios') {
        Ionic.WebView.setServerBasePath(prefs.bundlePath);
    }

    cordova.exec(
      () => {
        console.log('Deploy => App resetToBundle success');
        cordova.exec(
          () => console.log('Deploy => App restart success'),
          () => console.log('Deploy => App restart fail'),
          'IonicCordovaCommon', 'restart');
      },
      () => console.log('Deploy => App resetToBundle fail'),
      'IonicCordovaCommon', 'resetToBundle');

    return true;
  }

  async hasBundle(app: string): Promise<boolean> {
    return await this._fileManager.hasBundle(app);
  }

  async extractApplication(app: string): Promise<boolean> {
    try {
      console.log(`Deploy => Get Bundle version for app: ${app}`);
      const versionId = await this._fileManager.getBundleVersion(app);

      console.log(`Deploy => Prepare availableUpdate prefs`);
      const prefs = this._savedPreferences;    
      prefs.availableUpdate = {
        binaryVersionCode: prefs.binaryVersionCode,
        binaryVersionName: prefs.binaryVersionName,
        channel: prefs.channel,
        state: UpdateState.Available,
        lastUsed: new Date().toISOString(),
        url: '',
        versionId: versionId,
        buildId: '?',
        ionicVersion: '',
      };
      await this._savePrefs(prefs);

      console.log('Deploy => Prepare Snapshotfolder Directory');
      await this.prepareUpdateDirectory(prefs.availableUpdate.versionId)

      console.log('Deploy => Extract application bundle');
      await this._fileManager.extractApplication(app, prefs.availableUpdate.versionId);

      console.log('Deploy => Activate version');
      await this._extractUpdate();

      console.log('Deploy => Reload Application');
      await this.reloadApp();
    } catch(error) {
      console.log(`Deploy => extractApplication Error: ${error}`);
      return false;
    }

    return true;
  }

  getSnapshotCacheDirPath(versionId: string): string {
    return Path.join(this.appInfo.dataDirectory, this.SNAPSHOT_CACHE, versionId);
  }

  getSnapshotCacheDir(versionId: string): string {
    return new URL(this.getSnapshotCacheDirPath(versionId)).pathname;
  }

  getBundledAppDir(appId?: string): string {
    let folder = 'www';
    if (typeof (Capacitor) !== 'undefined') {
      folder = 'public';
    }
    return folder;
  }

  private async _savePrefs(prefs: ISavedPreferences): Promise<ISavedPreferences> {
    return new Promise<ISavedPreferences>(async (resolve, reject) => {
      try {
        cordova.exec(async (savedPrefs: ISavedPreferences) => {
          resolve(savedPrefs);
          }, reject, 'IonicCordovaCommon', 'setPreferences', [prefs]);
      } catch (e) {
        reject(e.message);
      }
    });
  }

  async configure(config: IDeployConfig) {
    clearTimeout(this.integrityCheckTimeout);

    if (!isPluginConfig(config)) {
      throw new Error('Invalid Config Object');
    }
    await new Promise((resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'configure', [config]);
    });
    Object.assign(this._savedPreferences, config);
    this._savePrefs(this._savedPreferences);
  }

  async checkForUpdate(): Promise<CheckForUpdateResponse> {
    const isOnline = navigator && navigator.onLine;
    if (!isOnline) {
      throw new Error('The device is offline.');
    }
    const prefs = this._savedPreferences;
    const appInfo = this.appInfo;

    console.log('Deploy => checkForUpdate: ' + JSON.stringify(prefs));

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

    const timeout = new Promise( (resolve, reject) => {
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
      const checkDeviceResp: CheckForUpdateResponse = jsonResp.data;
      if (checkDeviceResp.available && checkDeviceResp.url && checkDeviceResp.snapshot) {
        prefs.availableUpdate = {
          binaryVersionCode: prefs.binaryVersionCode,
          binaryVersionName: prefs.binaryVersionName,
          channel: prefs.channel,
          state: UpdateState.Available,
          lastUsed: new Date().toISOString(),
          url: checkDeviceResp.url,
          versionId: checkDeviceResp.snapshot,
          buildId: checkDeviceResp.build || '?',
          ionicVersion: '',
        };
        await this._savePrefs(prefs);
      }
      return checkDeviceResp;
    }

    throw new Error(`Error Status ${resp.status}: ${jsonResp ? jsonResp.error.message : await resp.text()}`);
  }

  async downloadUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<boolean> {
    const prefs = this._savedPreferences;
    if (prefs.availableUpdate && prefs.availableUpdate.state === UpdateState.Available) {

      console.log('Deploy => Fetch manifest file from ionic');
      const { fileBaseUrl, manifestJson } = await this._fetchManifestWithRetry(prefs.availableUpdate.url, 2);

      console.log('Deploy => Prepare Update Directory');
      await this.prepareUpdateDirectory(prefs.availableUpdate.versionId)

      console.log('Deploy => Prepare diffed manifest');
      const diffedManifest = await this._diffManifests(
        manifestJson,
        prefs.availableUpdate.versionId
      );

      console.log(`Deploy => Download the files from diffed manifest: ${diffedManifest.length} files`);
      try {
        await this._downloadFilesFromManifest(cancelToken, fileBaseUrl, diffedManifest,  prefs.availableUpdate.versionId, progress);
      } catch (err) {
        console.log('Deploy => CAUGHT ERROR - DOWNLOAD', err);
        throw err;
      }

      if (cancelToken.isCancelled()) {
        console.log('Deploy => Download cancelled, returning');
        cancelToken.onCancel();
        return false;
      } else {

        try {
          const fullPath = Path.join(this.getSnapshotCacheDirPath(prefs.availableUpdate.versionId), 'assets/version.txt');
          const ionicVersion = await this._fileManager.getFile(fullPath);
          prefs.availableUpdate.ionicVersion = ionicVersion;
        } catch (error) {
          delete prefs.availableUpdate.ionicVersion;
          console.log(`Deploy => Get ionic version error: ${error}`);
        }

        prefs.availableUpdate.state = UpdateState.Pending;
        await this._savePrefs(prefs);
        return true;
      }
    }
    console.log('Deploy => Nothing to download');
    return false;
  }

  private async _downloadFilesFromManifest(cancelToken: CancelToken, baseUrl: string, manifest: ManifestFileEntry[], versionId: string, progress?: CallbackFunction<number>) {
    let size = 0, downloaded = 0;
    const concurrent = 10;
    manifest.forEach(i => {
      size += i.size;
    });

    console.log(`Deploy => Downloading update... ${size} bytes`);

    const beforeDownloadTimer = new Timer('downloadTimer');
    const downloadFile = async (file: ManifestFileEntry) => {
      console.log(`Deploy => Downloading ionic update file: ${file.href} of size: ${file.size}`);
      const base = new URL(baseUrl);
      const newUrl = new URL(file.href, baseUrl);
      newUrl.search = base.search;
      const filePath = Path.join(this.getSnapshotCacheDir(versionId), file.href);
      await this._fileManager.downloadAndWriteFile(newUrl.toString(), filePath);

      await this.checkFileIntegrity(file, versionId);

      downloaded += file.size;
      const percentProgress = (downloaded / size) * 100;
      console.log(`Deploy => Finished downloading ${file.href}; progress: ${percentProgress}`);
      if (progress) {
        progress(percentProgress);
      } else {
        console.log('Deploy => No progress callback available');
      }
    };

    const downloads: ManifestFileEntry[] = [];
    console.log(`Deploy => Downloading ${manifest.length} new files...`);
    for (const entry of manifest) {
      downloads.push(entry);
    }

    await this.asyncPoolDownloads(concurrent, downloads, async (entry: ManifestFileEntry) => {
      if (cancelToken.isCancelled()) {
        console.log(`Deploy => Download cancelled for file: ${entry.href}`);
      } else {
        const maxTries = 10;
        let i = 0, success = false, error = '';

        while (!success && i < maxTries && !cancelToken.isCancelled()) {
          try {
            await downloadFile(entry);
            success = true;
          } catch (err) {
            i++;
            error = `${err}`;

            console.log(`Deploy => ${i} File download error ${entry.href} with error: ${err}`);
            this._wait(1000);
          }
        }

        if (!success && !cancelToken.isCancelled()) {
          throw new Error(error);
        }
      }
    });

    if (cancelToken.isCancelled()) {
      console.log(`Deploy => Download cancelled`);
    } else {
      console.log(`Deploy => Files downloaded.`);
    }

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

  private  _wait(ms: number) {
    const start = new Date().getTime();
    let end = start;
    while (end < start + ms) {
      end = new Date().getTime();
   }
 }

  private async _fetchManifestWithRetry(url: string, noRetries: number): Promise<FetchManifestResp> {
    if (noRetries <= 1) {
      noRetries = 1;
    }

    try {
      return await this._fetchManifest(url)
    } catch(error) {
        if (noRetries === 1) {
          console.log(`Deploy: Fetch manifest has an error: ${error}`);
          throw error;
        }
        return await this._fetchManifestWithRetry(url, noRetries - 1);
    }
  }

  private async _fetchManifest(url: string): Promise<FetchManifestResp> {
    console.log(`_fetchManifest: ${url}`);
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
    });

    const responseBody = await resp.json();

    return {
      fileBaseUrl: resp.url,
      manifestJson: responseBody
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
      const differences = newManifest.filter(entry => (entry.href === 'assets/version.txt' || (snapManifestStrings.indexOf(JSON.stringify(entry)) === -1 && !entry.href.startsWith('svg/')) ));

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
    console.log('Deploy => Cleaned version directory');

    await this._copyBaseAppDir(versionId);
    console.log('Deploy => Copied base app resources');
  }

  async extractUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<boolean> {
    return cancelToken && cancelToken.isCancelled()
      ? false
      : this._extractUpdate(progress);
  }

  async _extractUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    const prefs = this._savedPreferences;

    if (!prefs.availableUpdate || prefs.availableUpdate.state !== UpdateState.Pending) {
      return false;
    }

    if (progress) {
      progress(100);
    }

    prefs.availableUpdate.state = UpdateState.Ready;
    if (!prefs.updates) {
      prefs.updates = {};
    }

    prefs.updates[prefs.availableUpdate.versionId] = prefs.availableUpdate;
    await this._savePrefs(prefs);

    return true;
  }

  async reloadApp(force = false): Promise<boolean> {
    const prefs = this._savedPreferences;

    // Save the current update if it's ready
    if (prefs.availableUpdate && prefs.availableUpdate.state === UpdateState.Ready) {
      prefs.currentVersionId = prefs.availableUpdate.versionId;
      prefs.currentVersionForAppId = prefs.appId;
      prefs.currentBuildId = prefs.availableUpdate.buildId;
      delete prefs.availableUpdate;
      await this._savePrefs(prefs);
    }

    // Is there a non-binary version deployed?
    if (prefs.currentVersionId) {
      // Are we already running the deployed version?
      if (await this._isRunningVersion(prefs.currentVersionId)) {
        console.log(`Deploy => Already running version ${prefs.currentVersionId}`);
        prefs.currentVersionForAppId = prefs.appId;
        await this._savePrefs(prefs);
        channel.onIonicProReady.fire();
        Ionic.WebView.persistServerBasePath();
        await this.cleanupVersions();
        if (force) {
          await this.forceReloadApp();
        }
        return false;
      }

      // Is the current version on the device?
      if (!prefs.updates) {
        prefs.updates = {};
      }

      if (!(prefs.currentVersionId in prefs.updates)) {
        console.error(`Deploy => Missing version ${prefs.currentVersionId}`);
        channel.onIonicProReady.fire();
        if (force) {
          await this.forceReloadApp();
        }
        return false;
      }

      // Reload the webview
      const newLocation = this.getSnapshotCacheDir(prefs.currentVersionId);
      console.log('Deploy => setServerBasePath: ' + newLocation);
      Ionic.WebView.setServerBasePath(newLocation);
      return true;
    }

    console.log('Deploy => Reload requested but no current version using bundle');
    channel.onIonicProReady.fire();
    if (force) {
      await this.forceReloadApp();
    }
    return true;
  }

  async forceReloadApp(): Promise<boolean> {
    try {
      window.location.reload();
    } catch (error) {
      console.error(`Deploy => Force reload failed: ${error}`);
    }
    return true;
  }

  // compare an update to the current version using both name & code
  private isCurrentVersion(update: IAvailableUpdate) {
    const currentVersionCode = this._savedPreferences.binaryVersionCode;
    const currentVersionName = this._savedPreferences.binaryVersionName;
    console.log(`Deploy => Current: versionCode: ${currentVersionCode} versionName: ${currentVersionName}`);
    console.log(`Deploy => update: versionCode: ${update.binaryVersionCode} versionName: ${update.binaryVersionName}`);

    return update.binaryVersionName === currentVersionName && update.binaryVersionCode === currentVersionCode;
  }

  private async cleanCurrentVersionIfStale() {
    const prefs = this._savedPreferences;

    if (!prefs.currentVersionId) {
      return;
    }

    if(!prefs.updates) {
      prefs.updates = {};
    }

    // Is the current version built from a previous binary?
    if (!this.isCurrentVersion(prefs.updates[prefs.currentVersionId]) && !(await this._isRunningVersion(prefs.currentVersionId))) {
      if (prefs.currentVersionForAppId === "5fc6b2fe" ) {
        await this.cleanReferenceDownload();
      } else {
        await this.cleanAcgOrMwgDownload();
      }
    }
  }

  private async cleanReferenceDownload() {
    const prefs = this._savedPreferences;
    if (!prefs.currentVersionId) {
      return;
    }

    if(!prefs.updates) {
      prefs.updates = {};
    }

    console.log(
      `Deploy => Update ${prefs.currentVersionId} was built for different binary version removing update from device` +
      `Update binaryVersionName: ${prefs.updates[prefs.currentVersionId].binaryVersionName}, Device binaryVersionName ${prefs.binaryVersionName}` +
      `Update binaryVersionCode: ${prefs.updates[prefs.currentVersionId].binaryVersionCode}, Device binaryVersionCode ${prefs.binaryVersionCode}`
    );
    const versionId = prefs.currentVersionId;
    // NOTE: deleting pref.currentVersionId here to fool deleteVersionById into deleting it
    delete prefs.currentVersionId;
    delete prefs.currentVersionForAppId;
    await this.deleteVersionById(versionId);
  }

  private async cleanAcgOrMwgDownload() {
    const prefs = this._savedPreferences;

    if (!prefs.currentVersionId) {
      return;
    }

    if(!prefs.updates) {
      prefs.updates = {};
    }

    try {
      const snapshotDirectory = this.getSnapshotCacheDir(prefs.currentVersionId);
      const bundledAppDir = this.getBundledAppDir();

      console.log('Deploy => Ionic: Copying folder cordova-js-src...');
      await this._fileManager.copyTo({
        source: { path: Path.join(bundledAppDir, 'cordova-js-src'), directory: 'APPLICATION' },
        target: Path.join(snapshotDirectory, 'cordova-js-src')
      });
      console.log('Deploy => Ionic: Copying folder plugins...');
      await this._fileManager.copyTo({
        source: { path: Path.join(bundledAppDir, 'plugins'), directory: 'APPLICATION' },
        target: Path.join(snapshotDirectory, 'plugins')
      });
      console.log('Deploy => Ionic: Copying folder task...');
      await this._fileManager.copyTo({
        source: { path: Path.join(bundledAppDir, 'task'), directory: 'APPLICATION' },
        target: Path.join(snapshotDirectory, 'task')
      });

      console.log('Deploy => Ionic: Copying cordova files...');
      await this._fileManager.copyFile('APPLICATION', Path.join(bundledAppDir, 'cordova.js'), Path.join(snapshotDirectory, 'cordova.js'));
      await this._fileManager.copyFile('APPLICATION', Path.join(bundledAppDir, 'cordova_plugins.js'), Path.join(snapshotDirectory, 'cordova_plugins.js'));

      if (this.appInfo.platform === 'ios') {
        console.log('Deploy => Ionic: Copying ios specific file wk-plugin.js...');
        await this._fileManager.copyFile('APPLICATION', Path.join(bundledAppDir, 'wk-plugin.js'), Path.join(snapshotDirectory, 'wk-plugin.js'));
      }

      console.log('Deploy => Ionic: switch binary version...');
      prefs.updates[prefs.currentVersionId].binaryVersionName = prefs.binaryVersionName;
      prefs.updates[prefs.currentVersionId].binaryVersionCode = prefs.binaryVersionCode;
      this._savePrefs(prefs);        
    } catch(error) {
      console.log(`Deploy => Ionic cordova files error: ${error}`);
    }

    console.log('Deploy => Ionic: cordova file update done...');
  }

  private async _isRunningVersion(versionId: string) {
    const currentPath = await this._getServerBasePath();
    return currentPath.includes(versionId);
  }

  private async _getServerBasePath(): Promise<string> {
    return new Promise<string>( async (resolve, reject) => {
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
      await this._fileManager.remove(snapshotDir);
      timer.end();
    } catch (e) {
      console.log('Deploy => No directory found for snapshot no need to delete');
      timer.end();
    }
  }

  private async _copyBaseAppDir(versionId: string) {
    const timer = new Timer('CopyBaseApp');
    await this._fileManager.copyTo({
      source: {
        path: this.getBundledAppDir(),
        directory: 'APPLICATION',
      },
      target: this.getSnapshotCacheDir(versionId),
    });
    timer.end();
  }

  async getCurrentVersion(): Promise<ISnapshotInfo | undefined> {
    const versionId = this._savedPreferences.currentVersionId;
    if (typeof versionId === 'string') {
      return this.getVersionById(versionId);
    }
    return;
  }

  async getVersionById(versionId: string): Promise<ISnapshotInfo | undefined> {
    if (!this._savedPreferences.updates) {
      this._savedPreferences.updates = {};
    }
    const update = this._savedPreferences.updates[versionId];
    if (!update) {
      return;
    }
    return this._convertToSnapshotInfo(update);
  }

  private _convertToSnapshotInfo(update: IAvailableUpdate): ISnapshotInfo {
    return {
      deploy_uuid: update.versionId,
      versionId: update.versionId,
      buildId: update.buildId,
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
    let filePath = '';
    try {
      filePath = Path.join(dir, this.MANIFEST_FILE);

      fileContents = await this._fileManager.getFileWithPlatform(filePath, this.appInfo.platform);
    } catch (err) {
      console.error(`Deploy => Get pro-manifest file content: ${err}`);
    }

    try {
      const manifest = JSON.parse(<string>fileContents);
      return manifest;
    } catch (err) {
      console.error('Deploy => Could not parse JSON: ' + fileContents);
    }

    return [];
  }

  async isDefaultApp(): Promise<boolean> {
    return Promise.resolve(
      this._savedPreferences.appId === this._savedPreferences.nativeAppId);
  }

  async getAvailableVersions(): Promise<ISnapshotInfo[]> {
    const updates = this._savedPreferences.updates || {};
    return Object.keys(updates).map(k => this._convertToSnapshotInfo(updates[k]));
  }

  async deleteVersionById(versionId: string): Promise<boolean> {
    const prefs = this._savedPreferences;

    if (prefs.currentVersionId === versionId) {
      throw Error(`Can't delete version with id: ${versionId} as it is the current version.`);
    }

    console.log(`Deploy => Deploy => Deleting ionic snapshot ${versionId}.`);

    if (prefs.updates) {
      delete prefs.updates[versionId];
    }
    await this._savePrefs(prefs);

    // delete snapshot directory
    await this._cleanSnapshotDir(versionId);

    return true;
  }

  private getStoredUpdates() {
    // get an array of stored updates minus current deployed one
    const prefs = this._savedPreferences;
    if (!prefs.updates) {
      prefs.updates = {};
    }
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
    const prefs = this._savedPreferences;

    // clean down to Max Updates stored
    let updates = this.getStoredUpdates();
    updates = updates.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
    updates = updates.reverse();
    updates = updates.slice(prefs.maxVersions);

    for (const update of updates) {
      await this.deleteVersionById(update.versionId);
    }
  }

  async sync(syncOptions: ISyncOptions = {}, cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<ISnapshotInfo | undefined> {
    const prefs = this._savedPreferences;

    // TODO: Get API override if present?
    const updateMethod = syncOptions.updateMethod || prefs.updateMethod;

    const wrappedProgress = progress ? (complete?: number) => {
      progress(complete);
    } : undefined;

    await this.checkForUpdate();

    if (prefs.availableUpdate) {
      if (prefs.availableUpdate.state === UpdateState.Available) {
        await this.downloadUpdate(cancelToken, wrappedProgress);
      }
      if (!cancelToken.isCancelled()) {
        cancelToken.onCancel();
        return;
      } else {
        if (prefs.availableUpdate.state === UpdateState.Pending) {
          // ignore progress from this since it's trivial
          await this.extractUpdate(cancelToken);
        }
        if (prefs.availableUpdate.state === UpdateState.Ready && updateMethod === UpdateMethod.AUTO) {
          await this.reloadApp();
        }
      }
    }

    if (prefs.currentVersionId && prefs.currentBuildId) {
      return {
        deploy_uuid: prefs.currentVersionId,
        versionId: prefs.currentVersionId,
        buildId: prefs.currentBuildId,
        channel: prefs.channel,
        binary_version: prefs.binaryVersionName,
        binaryVersion: prefs.binaryVersionName,
        binaryVersionCode: prefs.binaryVersionCode,
        binaryVersionName: prefs.binaryVersionName
      };
    }

    return;
  }

  private sendEvent(eventName: string, data: any) {
    const event = new CustomEvent(eventName, { detail: data });
    document.dispatchEvent(event);
  }
}

class FileManager {
  async copyFile(directory: string, fromFile: string, toFile: string) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'copyFile', [{directory, fromFile, toFile}]);
    }).catch(error => console.log(`Deploy => Error copying file ${fromFile}: ${error}`));
  }

  async copyTo(options: { source: { directory: string; path: string; } , target: string}) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'copyTo', [options]);
    });
  }

  async remove(path: string) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'remove', [{target: path}]);
    }).catch(error => console.log(`Deploy => Error deleting file ${path}: ${error}`));
  }

  async downloadAndWriteFile(url: string, path: string) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'downloadFile', [{url, target: path}]);
    });
  }

  async hasBundle(app: string) {
    return new Promise<boolean>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'hasBundle', [app]);
    });
  }

  async getBundleVersion(app: string) {
    return new Promise<string>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'getBundleVersion', [app]);
    });
  }

  async extractApplication(app: string, version: string) {
    return new Promise<boolean>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'extractApplication', [app, version]);
    });
  }

  async getDirectory(path: string, createDirectory = true): Promise<DirectoryEntry> {
    return new Promise<DirectoryEntry>((resolve, reject) => {
      resolveLocalFileSystemURL(
        path,
        entry => entry.isDirectory ? resolve(entry as DirectoryEntry) : reject(),
        async () => {
          const components = path.split('/');
          const child = components.pop() as string;
          try {
            const parent = (await this.getDirectory(components.join('/'), createDirectory)) as DirectoryEntry;
            parent.getDirectory(child, {create: createDirectory}, async entry => {
              if (entry.fullPath === path) {
                resolve(entry);
              } else {
                resolve(await this.getDirectory(path, createDirectory));
              }
            }, reject);
          } catch (e) {
            reject(e);
          }
        }
      );
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

  async getFile(fullPath: string): Promise<string> {
    let normalizedURL = Ionic.WebView.convertFileSrc(fullPath);
    const req = await fetch(normalizedURL);
    return req.text();
  }

  async getFileWithPlatform(fullPath: string, platform: string): Promise<string> {
    let normalizedURL = Ionic.WebView.convertFileSrc(fullPath);
    if (normalizedURL.startsWith('undefined')) {
      const prefix = platform === 'ios' ? 'ionic://localhost' : 'http://localhost';
      normalizedURL = normalizedURL.replace('undefined', prefix);
    }
    const req = await fetch(normalizedURL);
    return req.text();
  }

  async getFileEntry(path: string, fileName: string) {
    const dirEntry = await this.getDirectory(path, false);
    return new Promise<FileEntry>((resolve, reject) => {
      dirEntry.getFile(fileName, {create: false, exclusive: false}, resolve, reject);
    });
  }

  async getFileEntryFile(path: string, fileName: string): Promise<File> {
    const fileEntry = await this.getFileEntry(path, fileName);
    return new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
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
    this.fetchIsAvailable = typeof(fetch) === 'function';
    document.addEventListener('deviceready', this.onLoad.bind(this));
  }

  async initialize() {
    const preferences = await this._initPreferences();
    if (!preferences.updates) {
      preferences.updates = {};
    }
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
      console.warn(`Deploy => ${disabledMessage}`);
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
    if (!this.disabled && this.lastPause && this.minBackgroundDuration && Date.now() - this.lastPause > this.minBackgroundDuration * 1000) {
      await (await this.delegate)._handleInitialPreferenceState();
    }
  }

  async _initPreferences(): Promise<ISavedPreferences> {
    return new Promise<ISavedPreferences>(async (resolve, reject) => {
      try {
        channel.onNativeReady.subscribe(async () => {
          // timeout to let browser proxy to init
          window.setTimeout(function () {
            cordova.exec(async (prefs: ISavedPreferences) => {
              resolve(prefs);
            }, reject, 'IonicCordovaCommon', 'getPreferences');
          }, 0);
        });
      } catch (e) {
        channel.onIonicProReady.fire();
        reject(e.message);
      }
    });
  }

  async checkForUpdate(): Promise<CheckForUpdateResponse> {
    if (!this.disabled) {
      return (await this.delegate).checkForUpdate();
    }
    return  {available: false, compatible: false, partial: false};
  }

  async configure(config: IDeployConfig): Promise<void> {
    if (!this.disabled) return (await this.delegate).configure(config);
  }

  async getConfiguration(): Promise<ICurrentConfig> {
    return new Promise<ICurrentConfig>(async (resolve, reject) => {
      try {
        cordova.exec(async (prefs: ISavedPreferences) => {
            if (prefs.availableUpdate) {
              delete prefs.availableUpdate;
            }
            if (prefs.updates) {
              delete prefs.updates;
            }
            console.log(`Deploy => prefs: ${JSON.stringify(prefs)}`);
            resolve(prefs);
          }, reject, 'IonicCordovaCommon', 'getPreferences');
      } catch (e) {
        reject(e.message);
      }
    });
  }

  async deleteVersionById(version: string): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).deleteVersionById(version);
    return true;
  }

  async downloadUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).downloadUpdate(cancelToken, progress);
    return false;
  }

  async extractUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).extractUpdate(cancelToken, progress);
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

  async getVersionById(versionId: string): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).getVersionById(versionId);
    return;
  }

  async reloadApp(force = false): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).reloadApp(force);
    return false;
  }

  async resetToBundle(): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).resetToBundle();
    return false;
  }

  async hasBundle(app: string): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).hasBundle(app);
    return false;
  }

  async extractApplication(app: string): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).extractApplication(app);
    return false;
  }

  async showErrorAlert(): Promise<string> {
    if (this.disabled) {
      return Promise.resolve('Disbaled');
    }

    return new Promise<string>((resolve, reject) => {
      cordova.exec((userAction: string) => {
        resolve(userAction);
      },
      () => {
        reject('Error happen showing alert');
      }, 'IonicCordovaCommon', 'showErrorAlert');
    });
  }

  async sync(syncOptions: ISyncOptions = {}, cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).sync(syncOptions, cancelToken, progress);
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
    console.warn('Deploy => This function has been deprecated in favor of IonicCordova.getAppDetails.');
    this.getAppDetails().then(
      result => success(result),
      err => {
        typeof err === 'string' ? failure(err) : failure(err.message);
      }
    );
  }

  async getAppDetails(): Promise<IAppInfo> {
    return new Promise<IAppInfo>( (resolve, reject) => {
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
