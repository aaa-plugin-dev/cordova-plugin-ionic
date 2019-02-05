export declare class CancelToken {
    private _onCancel;
    private cancelled;
    private cancelTimeout;
    constructor();
    cancel(onCancel: Function, timeout?: number): void;
    reset(): void;
    isCancelled(): boolean;
    onCancel(): void;
}
