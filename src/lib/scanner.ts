// Generic continuous BLE advertisement scanner — a thin wrapper around
// @stoprocent/noble. Owns nothing battery- or device-specific; it just turns
// the noble `discover` stream into normalised advertisement objects.
//
// noble holds native HCI socket state, so exactly one of these should exist per
// process. Scanning is started lazily by the gateway (only once a subscriber
// exists) and stopped when the last subscriber leaves.

interface MinimalLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
}

/** Normalised advertisement, binary fields kept as Buffers (converted to HEX later). */
export interface Advertisement {
    address: string; // lowercased MAC
    addressType: string;
    rssi: number;
    localName?: string;
    txPowerLevel?: number;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
    serviceData?: { uuid: string; data: Buffer }[];
}

export class BleScanner {
    private readonly noble: any;
    private readonly log: MinimalLogger;
    private scanning = false;
    private onAdv: ((adv: Advertisement) => void) | null = null;
    private onDiscover: ((p: any) => void) | null = null;

    public constructor(noble: any, log: MinimalLogger) {
        this.noble = noble;
        this.log = log;
    }

    public getPowerState(): string {
        return this.noble._state || this.noble.state || 'unknown';
    }

    public isPoweredOn(): boolean {
        return this.getPowerState() === 'poweredOn';
    }

    public isScanning(): boolean {
        return this.scanning;
    }

    public async waitPoweredOn(timeoutMs = 15000): Promise<void> {
        if (typeof this.noble?.on !== 'function') {
            throw new Error('Bluetooth binding not initialised correctly');
        }
        if (this.isPoweredOn()) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            let onState: ((s: string) => void) | null = null;
            const safeRemove = (): void => {
                try {
                    if (typeof this.noble.removeListener === 'function' && onState) {
                        this.noble.removeListener('stateChange', onState);
                    }
                } catch {
                    // ignore
                }
            };
            const timer = setTimeout(() => {
                safeRemove();
                reject(new Error(`Bluetooth adapter not powered on (state=${this.getPowerState()})`));
            }, timeoutMs);
            onState = (s: string): void => {
                if (s === 'poweredOn') {
                    clearTimeout(timer);
                    safeRemove();
                    resolve();
                }
            };
            try {
                this.noble.on('stateChange', onState);
            } catch (e) {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    /**
     * Start continuous scanning. `allowDuplicates=true` so repeated advertisements
     * from the same device keep flowing — essential for streaming sensors/beacons.
     */
    public async start(onAdvertisement: (adv: Advertisement) => void): Promise<void> {
        if (this.scanning) {
            this.onAdv = onAdvertisement;
            return;
        }
        await this.waitPoweredOn();
        this.onAdv = onAdvertisement;
        this.onDiscover = (p: any): void => {
            const cb = this.onAdv;
            if (!cb) {
                return;
            }
            const addr = (p.address || '').toLowerCase();
            if (!addr) {
                return;
            }
            const a = p.advertisement || {};
            const serviceData = Array.isArray(a.serviceData)
                ? a.serviceData.map((sd: any) => ({
                      uuid: String(sd.uuid),
                      data: Buffer.isBuffer(sd.data) ? sd.data : Buffer.from(sd.data || []),
                  }))
                : undefined;
            cb({
                address: addr,
                addressType: p.addressType || 'unknown',
                rssi: typeof p.rssi === 'number' ? p.rssi : 0,
                localName: a.localName || undefined,
                txPowerLevel: typeof a.txPowerLevel === 'number' ? a.txPowerLevel : undefined,
                serviceUuids: Array.isArray(a.serviceUuids) && a.serviceUuids.length ? a.serviceUuids : undefined,
                manufacturerData: Buffer.isBuffer(a.manufacturerData) ? a.manufacturerData : undefined,
                serviceData: serviceData && serviceData.length ? serviceData : undefined,
            });
        };
        this.noble.on('discover', this.onDiscover);
        await this.noble.startScanningAsync([], true);
        this.scanning = true;
        this.log.info('BLE scan started');
    }

    /** Stop scanning and detach the discover listener. The HCI socket stays bound but idle. */
    public async stop(): Promise<void> {
        this.onAdv = null;
        if (this.onDiscover) {
            try {
                if (typeof this.noble.removeListener === 'function') {
                    this.noble.removeListener('discover', this.onDiscover);
                }
            } catch {
                // ignore — noble may be in a degraded state
            }
            this.onDiscover = null;
        }
        if (!this.scanning) {
            return;
        }
        this.scanning = false;
        try {
            await this.noble.stopScanningAsync();
            this.log.info('BLE scan stopped');
        } catch {
            // ignore
        }
    }
}
