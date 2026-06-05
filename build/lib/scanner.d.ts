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
export declare class BleScanner {
    private readonly noble;
    private readonly log;
    private scanning;
    private onAdv;
    private onDiscover;
    constructor(noble: any, log: MinimalLogger);
    getPowerState(): string;
    isPoweredOn(): boolean;
    isScanning(): boolean;
    waitPoweredOn(timeoutMs?: number): Promise<void>;
    /**
     * Start continuous scanning. `allowDuplicates=true` so repeated advertisements
     * from the same device keep flowing — essential for streaming sensors/beacons.
     */
    start(onAdvertisement: (adv: Advertisement) => void): Promise<void>;
    /** Stop scanning and detach the discover listener. The HCI socket stays bound but idle. */
    stop(): Promise<void>;
}
export {};
