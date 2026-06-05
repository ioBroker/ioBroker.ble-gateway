"use strict";
// Generic continuous BLE advertisement scanner — a thin wrapper around
// @stoprocent/noble. Owns nothing battery- or device-specific; it just turns
// the noble `discover` stream into normalised advertisement objects.
//
// noble holds native HCI socket state, so exactly one of these should exist per
// process. Scanning is started lazily by the gateway (only once a subscriber
// exists) and stopped when the last subscriber leaves.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BleScanner = void 0;
class BleScanner {
    noble;
    log;
    scanning = false;
    onAdv = null;
    onDiscover = null;
    constructor(noble, log) {
        this.noble = noble;
        this.log = log;
    }
    getPowerState() {
        return this.noble._state || this.noble.state || 'unknown';
    }
    isPoweredOn() {
        return this.getPowerState() === 'poweredOn';
    }
    isScanning() {
        return this.scanning;
    }
    async waitPoweredOn(timeoutMs = 15000) {
        if (typeof this.noble?.on !== 'function') {
            throw new Error('Bluetooth binding not initialised correctly');
        }
        if (this.isPoweredOn()) {
            return;
        }
        await new Promise((resolve, reject) => {
            let onState = null;
            const safeRemove = () => {
                try {
                    if (typeof this.noble.removeListener === 'function' && onState) {
                        this.noble.removeListener('stateChange', onState);
                    }
                }
                catch {
                    // ignore
                }
            };
            const timer = setTimeout(() => {
                safeRemove();
                reject(new Error(`Bluetooth adapter not powered on (state=${this.getPowerState()})`));
            }, timeoutMs);
            onState = (s) => {
                if (s === 'poweredOn') {
                    clearTimeout(timer);
                    safeRemove();
                    resolve();
                }
            };
            try {
                this.noble.on('stateChange', onState);
            }
            catch (e) {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }
    /**
     * Start continuous scanning. `allowDuplicates=true` so repeated advertisements
     * from the same device keep flowing — essential for streaming sensors/beacons.
     */
    async start(onAdvertisement) {
        if (this.scanning) {
            this.onAdv = onAdvertisement;
            return;
        }
        await this.waitPoweredOn();
        this.onAdv = onAdvertisement;
        this.onDiscover = (p) => {
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
                ? a.serviceData.map((sd) => ({
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
    async stop() {
        this.onAdv = null;
        if (this.onDiscover) {
            try {
                if (typeof this.noble.removeListener === 'function') {
                    this.noble.removeListener('discover', this.onDiscover);
                }
            }
            catch {
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
        }
        catch {
            // ignore
        }
    }
}
exports.BleScanner = BleScanner;
//# sourceMappingURL=scanner.js.map