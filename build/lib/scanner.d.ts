interface MinimalLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
}
/** Normalised advertisement, binary fields kept as Buffers (converted to HEX later). */
export interface Advertisement {
    address: string;
    addressType: string;
    rssi: number;
    localName?: string;
    txPowerLevel?: number;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
    serviceData?: {
        uuid: string;
        data: Buffer;
    }[];
}
/** Receives every advertisement while scanning, plus noble's peripheral object for it. */
export type AdvertisementHandler = (adv: Advertisement, peripheral: any) => void;
export declare class BleScanner {
    private readonly noble;
    private readonly log;
    private scanning;
    private wanted;
    private suspendCount;
    private pausedLogged;
    private ops;
    private onAdv;
    private onDiscover;
    private scanStartedAt;
    private lastAdvAt;
    constructor(noble: any, log: MinimalLogger);
    getPowerState(): string;
    isPoweredOn(): boolean;
    isScanning(): boolean;
    waitPoweredOn(timeoutMs?: number): Promise<void>;
    isSuspended(): boolean;
    /**
     * How long the running scan has delivered no advertisement at all, in ms
     * (0 while not scanning). A controller can refuse "scan enable" while noble
     * still believes it scans — then nothing arrives and only a restart helps.
     */
    silentMs(): number;
    /** Stop and start the running scan again (no-op if it is not running). */
    restart(): Promise<void>;
    /**
     * Want continuous scanning. `allowDuplicates=true` so repeated advertisements
     * from the same device keep flowing — essential for streaming sensors/beacons.
     * Resolves once the scan runs (or stays paused while suspended).
     */
    start(onAdvertisement: AdvertisementHandler): Promise<void>;
    /** No longer want scanning. The HCI socket stays bound but idle. */
    stop(): Promise<void>;
    /** Pause scanning (nestable). Resolves once the scan has actually stopped. */
    suspend(): Promise<void>;
    /** Undo one suspend(). Scanning resumes when the last suspend is undone and it is still wanted. */
    resume(): Promise<void>;
    private reconcile;
    private sync;
    private handleExternalScanStop;
    private doStart;
    private detachDiscover;
    private doStop;
}
export {};
