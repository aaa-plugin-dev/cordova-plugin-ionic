export class CancelToken {
  private _onCancel: Function;
  private cancelled = false;
  private cancelTimeout: any;

  constructor() {
    this._onCancel = () => {
      console.log('CancelToken: onCancel');
    };
  }

  public cancel(onCancel: Function, timeout = 65): void {
    this._onCancel = onCancel;
    this.cancelled = true;
    this.cancelTimeout = setTimeout(() => {
      this.onCancel();
    }, timeout * 1000);
  }

  public reset(): void {
    this.cancelled = false;
  }

  public isCancelled(): boolean {
    return this.cancelled;
  }

  public onCancel(): void {
    if (this.cancelTimeout) {
      clearTimeout(this.cancelTimeout);
    }
    if (this._onCancel) {
      this._onCancel();
    }
  }
}
