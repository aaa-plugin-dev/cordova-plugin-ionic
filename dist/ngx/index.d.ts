import { CallbackFunction, CheckForUpdateResponse, ICurrentConfig, IDeployConfig, ISnapshotInfo, ISyncOptions } from './IonicCordova';
import { CancelToken } from './tokens';
export declare class DeployClass implements IDeployPluginAPI {
    configure(config: IDeployConfig): Promise<void>;
    getConfiguration(): Promise<ICurrentConfig>;
    checkForUpdate(): Promise<CheckForUpdateResponse>;
    downloadUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<boolean>;
    extractUpdate(cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<boolean>;
    reloadApp(force?: boolean): Promise<boolean>;
    resetToBundle(): Promise<boolean>;
    hasBundle(app: string): Promise<boolean>;
    extractApplication(app: string): Promise<boolean>;
    showErrorAlert(): Promise<string>;
    sync(options: ISyncOptions, cancelToken: CancelToken, progress?: CallbackFunction<number>): Promise<ISnapshotInfo | undefined>;
    getCurrentVersion(): Promise<ISnapshotInfo | undefined>;
    getAvailableVersions(): Promise<ISnapshotInfo[]>;
    deleteVersionById(versionId: string): Promise<boolean>;
    getVersionById(versionId: string): Promise<ISnapshotInfo | undefined>;
}
export declare const Deploy: DeployClass;
