import type { GattCharPayload, GattConnectPayload, GattConnectResult, GattConnectionInfo, GattWritePayload } from '../types';
interface MinimalLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
}
/** What the proxy needs from the gateway. */
export interface GattProxyHost {
    log: MinimalLogger;
    /** Resolve the noble peripheral for a MAC: from the cache, or by scanning for it. */
    findPeripheral(address: string, timeoutMs: number): Promise<any>;
    /** Pause / resume the advertisement scan (nestable). */
    suspendScan(): Promise<void>;
    resumeScan(): Promise<void>;
    /** Push a message to an instance without waiting for an answer. */
    send(instance: string, command: string, message: unknown): void;
    /** The set of connections changed (for info states). */
    onChange(): void;
}
/** Timing of the scan pause around GATT work (see the header). */
export interface GattScanPauseTiming {
    /** Wait after pausing the scan before the first connect. */
    settleMs: number;
    /** Keep the scan paused this long after the last connection closed. */
    releaseDelayMs: number;
    /** Resume the scan after this long even while connections are open. */
    maxHoldMs: number;
}
export declare class GattProxy {
    private readonly host;
    private readonly connections;
    private connectLock;
    private readonly connecting;
    private counter;
    private readonly timing;
    private holding;
    private holdSince;
    private releaseTimer;
    constructor(host: GattProxyHost, timing?: Partial<GattScanPauseTiming>);
    /** True while the proxy keeps the scan paused. */
    isHoldingScan(): boolean;
    get size(): number;
    hasOwner(owner: string): boolean;
    list(): GattConnectionInfo[];
    connect(owner: string, payload: GattConnectPayload): Promise<GattConnectResult>;
    private doConnect;
    subscribe(owner: string, p: GattCharPayload): Promise<void>;
    unsubscribe(owner: string, p: GattCharPayload): Promise<void>;
    write(owner: string, p: GattWritePayload): Promise<void>;
    read(owner: string, p: GattCharPayload): Promise<string>;
    disconnect(owner: string, connectionId: string): Promise<void>;
    /** Close every connection of an instance (it died or unsubscribed everything). */
    dropOwner(owner: string): Promise<number>;
    disconnectAll(): Promise<void>;
    private holdScan;
    private releaseScanNow;
    private releaseScanSoon;
    private getConn;
    private op;
    private handleLinkLoss;
    private close;
    private cleanup;
}
export {};
