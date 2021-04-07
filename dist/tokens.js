"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CancelToken = void 0;
var CancelToken = /** @class */ (function () {
    function CancelToken() {
        this.cancelled = false;
        this._onCancel = function () {
            console.log('CancelToken: onCancel');
        };
    }
    CancelToken.prototype.cancel = function (onCancel, timeout) {
        var _this = this;
        if (timeout === void 0) { timeout = 65; }
        this._onCancel = onCancel;
        this.cancelled = true;
        this.cancelTimeout = setTimeout(function () {
            _this.onCancel();
        }, timeout * 1000);
    };
    CancelToken.prototype.reset = function () {
        this.cancelled = false;
    };
    CancelToken.prototype.isCancelled = function () {
        return this.cancelled;
    };
    CancelToken.prototype.onCancel = function () {
        if (this.cancelTimeout) {
            clearTimeout(this.cancelTimeout);
        }
        if (this._onCancel) {
            this._onCancel();
        }
    };
    return CancelToken;
}());
exports.CancelToken = CancelToken;
